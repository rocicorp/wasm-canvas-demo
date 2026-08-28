// Undo, as a delta.
//
// The obvious way to build undo in a drawing app is snapshots: keep a copy of the document per
// step and swap one in. Under IVM that is the worst thing you could do — restoring a snapshot
// tells every view "everything changed", so every pipeline re-derives from scratch and the cost
// of undoing one nudge is the cost of the whole drawing. It is the re-registration mistake the
// selection design already refused (`schema.ts`), wearing a different hat.
//
// So undo here is not a state to restore. It is a WRITE — the inverse delta of the step you
// took — pushed through the same `Writer.commit` funnel your hand uses. Every consequence
// follows from that one fact:
//
//   * every view folds it. The canvas's cell queries, the palette's GROUP BY, the layer join's
//     counts, the leaderboard, the feed, the panes you wrote yourself: an undo is just another
//     commit, so nothing on the page needs to know undo exists.
//   * it costs the STEP, not the drawing. Undoing a 512-shape drag is 512 row-writes; undoing a
//     32,000-row confetti drop is 32,000 removes in one commit. Both are the same commit the
//     forward gesture made, run backwards, and both are timed on screen like any other write.
//   * `view-after-undo` follows the same live-query contract as every other write: each view
//     folds the inverse delta without any special snapshot or refresh path.
//
// Two design notes worth the words:
//
// **What an inverse is made of.** Not "the row as it was" — the COLUMNS this step actually
// moved, and what they held before it moved them (`CommitRecord.keys`, built in the writer where
// both rows are in hand). That is what makes undo behave in a room with other writers in it: the
// robots are writing the whole time you are, so an undo that restored whole rows would also
// revert everything a robot did to those rows in between. Restoring only the columns you touched
// rebases your undo onto whatever the row says NOW, which is what a multiplayer app has to do
// anyway.
//
// **What a step is.** A gesture, not a commit. The page commits once per frame, so a drag is
// sixty commits; a history with sixty entries in it for one drag is not a history. Commits fold
// into the currently open step — first-seen `before`, last-seen `after`, per column — and a
// `mark()` at each gesture's start is what closes one step and opens the next.

import type { ShapeRow } from "./mirror.ts";
import { maintained, type CommitRecord, type Mut, type SetPatch } from "./write.ts";

/** One undoable interaction, as the two deltas that move between its two ends. */
interface Step {
  tag: string;
  /** When the last commit folded into it — the coalescing window's clock. */
  at: number;
  /** Rows this step added: `id → the row as it ended up` (redo re-adds exactly that). */
  added: Map<number, ShapeRow>;
  /** Rows it removed: `id → the row as it stood when the step began`. */
  removed: Map<number, ShapeRow>;
  /** Rows it edited: per column, what it held before and after. */
  edited: Map<number, { before: SetPatch; after: SetPatch }>;
  /** Layer visibility it toggled. */
  layers: Map<number, { before: number; after: number }>;
  selBefore: number[];
  selAfter: number[];
}

/** What the app applies for one undo or redo: a delta to commit, and the selection to restore
 *  around it. */
export interface StepDelta {
  tag: string;
  muts: Mut[];
  /** Row-writes the delta carries — what the page reports the undo cost. */
  rows: number;
  selection: number[];
}

const stepRows = (s: Step): number => s.added.size + s.removed.size + s.edited.size + s.layers.size;

const empty = (s: Step): boolean => stepRows(s) === 0;

export class History {
  /** How many steps deep it goes. Past this the oldest is forgotten — a demo, not a document
   *  store. */
  private readonly maxSteps: number;
  /** …and how many ROWS it may hold, which is the bound that actually matters: one confetti
   *  press can put 32,000 rows into a single step, and every one of them is a row object the
   *  step keeps alive so redo can put it back. */
  private readonly maxRows: number;

  private readonly selectionNow: () => readonly number[];
  private open: Step | null = null;
  private readonly undoStack: Step[] = [];
  private readonly redoStack: Step[] = [];

  constructor(selectionNow: () => readonly number[], opts: { maxSteps?: number; maxRows?: number } = {}) {
    this.selectionNow = selectionNow;
    this.maxSteps = opts.maxSteps ?? 60;
    this.maxRows = opts.maxRows ?? 120_000;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || (this.open !== null && !empty(this.open));
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Steps available in each direction — what the buttons count. The open step counts as one:
   *  it is undoable the instant it has anything in it. */
  get depth(): { undo: number; redo: number } {
    return {
      undo: this.undoStack.length + (this.open !== null && !empty(this.open) ? 1 : 0),
      redo: this.redoStack.length,
    };
  }

  /** The name of the step ⌘Z would undo — the button's tooltip. */
  get nextTag(): string | null {
    if (this.open !== null && !empty(this.open)) return this.open.tag;
    return this.undoStack[this.undoStack.length - 1]?.tag ?? null;
  }

  /** Start a new step. Called at the START of an interaction (a pointerdown, a keystroke, a
   *  button), which is what makes a step a gesture rather than a frame.
   *
   *  `coalesceMs` is for the one interaction that arrives as a stream of separate keystrokes
   *  rather than as a drag: holding an arrow key nudges over and over, and thirty entries for
   *  one held key is the per-frame problem again. A same-tagged mark inside the window keeps the
   *  open step instead of starting another. */
  mark(tag: string, now: number, coalesceMs = 0): void {
    if (this.open && this.open.tag === tag && coalesceMs > 0 && now - this.open.at < coalesceMs) return;
    this.close();
    this.open = {
      tag,
      at: now,
      added: new Map(),
      removed: new Map(),
      edited: new Map(),
      layers: new Map(),
      selBefore: [...this.selectionNow()],
      selAfter: [],
    };
  }

  /** Fold one commit into the open step. Wired to `Writer.onCommit`, so anything that reaches
   *  the drawing through a recorded commit is undoable without asking. */
  record(rec: CommitRecord, now: number): void {
    if (!this.open) this.mark("edit", now);
    const step = this.open!;
    step.at = now;
    // A new change forks the timeline: whatever was redoable is not any more.
    this.redoStack.length = 0;

    for (const row of rec.adds) step.added.set(row.id, row);

    for (const e of rec.edits) {
      if (e.keys.length === 0) continue;
      const added = step.added.get(e.next.id);
      // A row this step ADDED, edited again inside the same step (draw a shape, then drag its
      // corner): there is no "before" to keep — the inverse is still just "remove it" — so the
      // edit folds into the row redo will re-add.
      if (added) {
        step.added.set(e.next.id, e.next);
        continue;
      }
      const cur = step.edited.get(e.next.id) ?? { before: {}, after: {} };
      for (const k of e.keys) {
        // First-seen before, last-seen after: sixty frames of a drag collapse to one pair.
        if (!(k in cur.before)) (cur.before as Record<string, unknown>)[k] = e.prev[k];
        (cur.after as Record<string, unknown>)[k] = e.next[k];
      }
      step.edited.set(e.next.id, cur);
    }

    for (const row of rec.removes) {
      // Added and removed inside one step: nothing happened, and the inverse must not claim it
      // did (an `add` of a row the step also invented would resurrect it).
      if (step.added.delete(row.id)) {
        step.edited.delete(row.id);
        continue;
      }
      const edited = step.edited.get(row.id);
      // The row as it stood when the step BEGAN — the removed row rewound through whatever this
      // same step had already edited on it. Its maintained columns are re-derived, because
      // rewinding x/y/w/h moves `area` and the cells with them.
      step.removed.set(row.id, edited ? maintained({ ...row, ...edited.before }) : row);
      step.edited.delete(row.id);
    }

    for (const l of rec.layers) {
      const cur = step.layers.get(l.next.id);
      step.layers.set(l.next.id, { before: cur ? cur.before : l.prev.visible, after: l.next.visible });
    }
  }

  /** Close the open step onto the undo stack (a no-op if it never wrote anything). */
  close(): void {
    const step = this.open;
    this.open = null;
    if (!step || empty(step)) return;
    step.selAfter = [...this.selectionNow()];
    this.undoStack.push(step);
    this.trim();
  }

  /** The inverse delta of the most recent step, and the selection it began with. */
  undo(): StepDelta | null {
    this.close();
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push(step);
    return { tag: step.tag, muts: invert(step), rows: stepRows(step), selection: step.selBefore };
  }

  /** …and the same step forwards again. */
  redo(): StepDelta | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push(step);
    return { tag: step.tag, muts: replay(step), rows: stepRows(step), selection: step.selAfter };
  }

  clear(): void {
    this.open = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Rows held across the whole stack — the page's "what history costs you" number. */
  get rowsHeld(): number {
    let n = 0;
    for (const s of this.undoStack) n += stepRows(s);
    for (const s of this.redoStack) n += stepRows(s);
    return n;
  }

  private trim(): void {
    while (this.undoStack.length > this.maxSteps) this.undoStack.shift();
    let rows = this.rowsHeld;
    while (rows > this.maxRows && this.undoStack.length > 1) {
      rows -= stepRows(this.undoStack.shift()!);
    }
  }
}

/** The step, backwards. */
function invert(step: Step): Mut[] {
  const muts: Mut[] = [];
  for (const id of step.added.keys()) muts.push({ op: "remove", id });
  for (const row of step.removed.values()) muts.push({ op: "add", row });
  for (const [id, e] of step.edited) muts.push({ op: "set", id, patch: e.before });
  for (const [id, l] of step.layers) muts.push({ op: "layer", id, patch: { visible: l.before } });
  return muts;
}

/** …and forwards. */
function replay(step: Step): Mut[] {
  const muts: Mut[] = [];
  for (const row of step.added.values()) muts.push({ op: "add", row });
  for (const id of step.removed.keys()) muts.push({ op: "remove", id });
  for (const [id, e] of step.edited) muts.push({ op: "set", id, patch: e.after });
  for (const [id, l] of step.layers) muts.push({ op: "layer", id, patch: { visible: l.after } });
  return muts;
}
