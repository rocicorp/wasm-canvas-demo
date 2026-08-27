// The write funnel. Every mutation on the page — your drag, a robot's drift, a 2,000-row
// confetti drop — goes through `commit()`, which does exactly three things, in order:
//
//   1. build the rows (ids, clocks, `area`, and each edit's `old` row from the mirror);
//   2. `store.write(...)` — timed. The call is synchronous and in-process: the commit, the
//      derivation of every affected pipeline, and the fold of every affected view all happen
//      inside it, so its wall time IS write→visible, not a lower bound on it;
//   3. apply the same rows to the JS mirror, so the differential is always comparing two views
//      of one state.
//
// Muts from one frame are COALESCED per row before committing — sixteen pointermoves between two
// paints are one edit with the last position, which is what an app would write, and it keeps
// "writes/s" an honest count of committed row-writes rather than of mouse events.

import type { DrawStore } from "./engine.ts";
import type { LayerRow, Mirror, ShapeRow } from "./mirror.ts";
import { Rate, Samples } from "./metrics.ts";
import { cellsOf } from "./cell.ts";
import { round1, roundRot } from "./scene.ts";
import { LAYER_DRAWING, type Kind } from "./schema.ts";

/** The columns a `set` may write. `z` is in here for one reason: undo. Nothing else writes it
 *  directly (`raise` mints the next one), but restoring a raised shape's old paint order is
 *  exactly what the inverse of a raise IS, and an inverse that could not say `z` would put the
 *  drawing back in the wrong order — see `history.ts`. */
export type SetPatch = Partial<Pick<ShapeRow, "x" | "y" | "w" | "h" | "rot" | "color" | "who" | "z">>;

export type Mut =
  | { op: "add"; row: ShapeRow }
  | { op: "set"; id: number; patch: SetPatch }
  | { op: "raise"; id: number }
  | { op: "remove"; id: number }
  /** An edit on the LAYER table — the eye toggle. One row; the joins do the fanning out. */
  | { op: "layer"; id: number; patch: Pick<LayerRow, "visible"> }
  /** Select or deselect one shape: a row added to or removed from the `selection` table.
   *
   *  Selecting is a WRITE here, which is the whole point. The selection query
   *  (`where(exists(onSelection))`) is registered once at boot with constant args, so a marquee
   *  sweeping across the drawing emits only the shapes that entered or left the box on that
   *  frame — a delta the engine folds — instead of re-registering a query whose args are the
   *  whole selected set. */
  | { op: "select"; id: number; on: boolean };

export interface CommitResult {
  ms: number;
  rows: number;
}

/** What one commit did to the drawing, in exactly the terms an inverse needs: the rows that
 *  appeared, the rows that vanished, and — per edited row — WHICH columns moved and what they
 *  held on both sides. `history.ts` turns this into the undo delta; nothing else reads it.
 *
 *  Selection writes are deliberately absent. Selecting is a write like any other, but it is not
 *  a change to the DRAWING, and a history that stepped back through every marquee frame would be
 *  unusable. The selection a step began and ended with is remembered separately, and restored
 *  around the delta. */
export interface CommitRecord {
  adds: ShapeRow[];
  edits: Array<{ prev: ShapeRow; next: ShapeRow; keys: Array<keyof SetPatch> }>;
  removes: ShapeRow[];
  layers: Array<{ prev: LayerRow; next: LayerRow }>;
}

export class Writer {
  private readonly store: DrawStore;
  private readonly mirror: Mirror;
  private nextId = 1;
  private clock = 0;
  private maxZ = 0;

  /** Wall time of `store.write` — write→visible, sampled per commit. */
  readonly writeVisible = new Samples(512);
  /** Committed row-writes per second, sliding window. */
  readonly writes = new Rate(2000);
  /** ms of main-thread time the engine spent per second of wall clock (the sum of commit wall
   *  times over a sliding window). */
  readonly engineWork = new Rate(3000);
  /** The last commit, for the HUD ("2,000 rows in 18 ms"). */
  lastCommit: CommitResult = { ms: 0, rows: 0 };
  /** Total rows ever committed (seed included) — the smoke test's "did anything happen". */
  totalRows = 0;

  /** Where a commit's inverse is built from, when the caller asked to record one. Set by the
   *  app to the history's recorder; the robots' ticks and the seed pass `record = false` and
   *  never reach it — undo is YOUR history, not the room's. */
  onCommit: ((rec: CommitRecord) => void) | null = null;

  /** Commits are SERIALIZED through this chain. Two in-flight commits would interleave at the
   *  `await`: the second would build its edits' `old` rows from a mirror the first had not yet
   *  caught up, hand the engine a stale `old`, and desynchronize the views from the base — which
   *  is not hypothetical: the browser smoke test's scripted writes raced the page's frame loop
   *  and the differential caught it on the first run. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(store: DrawStore, mirror: Mirror) {
    this.store = store;
    this.mirror = mirror;
  }

  /** Seed rows verbatim (the opening scene, a confetti batch): one commit, counters advanced
   *  past what the batch used. The opening scene is not history; a confetti drop is (`record`). */
  seed(rows: ShapeRow[], record = false): Promise<CommitResult> {
    return this.enqueue(() => this.seedNow(rows, record));
  }

  /** Seed the layer table (once, at boot): one commit. */
  seedLayers(rows: LayerRow[]): Promise<void> {
    return this.enqueue(async () => {
      await this.store.write((tx) => {
        for (const r of rows) tx.add("layer", r);
      });
      for (const r of rows) this.mirror.addLayer(r);
    });
  }

  /** Commit a batch of muts as ONE transaction. Returns what it cost, or null for an empty batch.
   *
   *  `record` is whether this commit is part of YOUR history: your gestures record, the robots
   *  and the seed do not, and an undo's own commit does not either (it is already the inverse of
   *  one that did). */
  commit(muts: Mut[], record = true): Promise<CommitResult | null> {
    if (muts.length === 0) return Promise.resolve(null);
    return this.enqueue(() => this.commitNow(muts, record));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async seedNow(rows: ShapeRow[], record: boolean): Promise<CommitResult> {
    for (const r of rows) {
      this.nextId = Math.max(this.nextId, r.id + 1);
      this.clock = Math.max(this.clock, r.updated);
      this.maxZ = Math.max(this.maxZ, r.z);
    }
    const t0 = performance.now();
    await this.store.write((tx) => {
      for (const r of rows) tx.add("shape", r);
    });
    const ms = performance.now() - t0;
    for (const r of rows) this.mirror.add(r);
    if (record && this.onCommit) this.onCommit({ adds: rows, edits: [], removes: [], layers: [] });
    this.count(ms, rows.length);
    return { ms, rows: rows.length };
  }

  /** A fresh row at the top of the paint order, ready for an `add` mut. */
  draft(kind: Kind, x: number, y: number, w: number, h: number, color: string, who: number): ShapeRow {
    const rx = round1(x);
    const ry = round1(y);
    return {
      id: this.nextId++,
      kind,
      x: rx,
      y: ry,
      w: round1(w),
      h: round1(h),
      rot: 0,
      color,
      z: ++this.maxZ,
      area: round1(w * h),
      updated: ++this.clock,
      who,
      layer: LAYER_DRAWING, // everything drawn or drifted lives on the drawing layer
      ...cellsOf(rx, ry),
    };
  }

  /** A copy of an existing row, offset — ⌘D. A NEW id, a new place at the top of the paint
   *  order and a fresh clock; everything else (kind, size, rotation, colour, layer) is the
   *  source's, because a duplicate that quietly normalised any of that would not be one. */
  duplicate(src: ShapeRow, dx: number, dy: number, who: number): ShapeRow {
    const x = round1(src.x + dx);
    const y = round1(src.y + dy);
    return {
      ...src,
      id: this.nextId++,
      x,
      y,
      z: ++this.maxZ,
      updated: ++this.clock,
      who,
      ...cellsOf(x, y),
    };
  }

  private async commitNow(muts: Mut[], record: boolean): Promise<CommitResult | null> {
    // Coalesce per row: last patch wins field-wise; a remove drops any pending edit; a remove of
    // a row added in the same batch cancels both.
    const adds = new Map<number, ShapeRow>();
    const patches = new Map<number, Partial<ShapeRow>>();
    const removes = new Set<number>();
    const layerPatches = new Map<number, Pick<LayerRow, "visible">>();
    /** id → wanted selection state; last write in the frame wins, like every other coalesce. */
    const selects = new Map<number, boolean>();
    for (const mut of muts) {
      switch (mut.op) {
        case "select":
          selects.set(mut.id, mut.on);
          break;
        case "layer":
          layerPatches.set(mut.id, { ...(layerPatches.get(mut.id) ?? {}), ...mut.patch });
          break;
        case "add":
          adds.set(mut.row.id, mut.row);
          removes.delete(mut.row.id);
          break;
        case "set": {
          const prev = patches.get(mut.id) ?? {};
          patches.set(mut.id, { ...prev, ...mut.patch });
          break;
        }
        case "raise":
          patches.set(mut.id, { ...(patches.get(mut.id) ?? {}), z: ++this.maxZ });
          break;
        case "remove":
          // A deleted shape must not leave a selection row pointing at nothing.
          selects.set(mut.id, false);
          if (adds.delete(mut.id)) break; // added and removed in one batch: nothing happened
          patches.delete(mut.id);
          removes.add(mut.id);
          break;
      }
    }
    // A patch aimed at a row being added in the same batch folds into the add itself.
    for (const [id, patch] of [...patches]) {
      const draft = adds.get(id);
      if (draft) {
        adds.set(id, finishRow(draft, patch, draft.updated));
        patches.delete(id);
      }
    }

    // Build the edit pairs from the mirror BEFORE writing: the engine is told each row's previous
    // state, and a stale `old` is a corruption, not an edit.
    const edits: CommitRecord["edits"] = [];
    for (const [id, patch] of patches) {
      const prev = this.mirror.get(id);
      if (!prev) continue;
      const next = finishRow(prev, patch, ++this.clock);
      // The columns that actually MOVED — the patch's own keys, minus the ones that landed on
      // the value already there (a drag re-offers `y` every frame while only `x` changes). This
      // is what an inverse is built from, and it is free to compute here where both rows are in
      // hand.
      const keys = (Object.keys(patch) as Array<keyof SetPatch>).filter((k) => prev[k] !== next[k]);
      edits.push({ prev, next, keys });
    }
    const removals: ShapeRow[] = [];
    for (const id of removes) {
      const prev = this.mirror.get(id);
      if (prev) removals.push(prev);
    }
    const layerEdits: Array<{ prev: LayerRow; next: LayerRow }> = [];
    for (const [id, patch] of layerPatches) {
      const prev = this.mirror.getLayer(id);
      if (!prev) continue;
      const next = { ...prev, ...patch };
      if (next.visible !== prev.visible) layerEdits.push({ prev, next });
    }
    // Selection rows: only the ids whose state actually CHANGES reach the engine. A marquee
    // re-offers its whole covered set every frame, and all but the edge of it is already true.
    const selAdds: number[] = [];
    const selRemoves: number[] = [];
    for (const [id, on] of selects) {
      if (on === this.mirror.isSelected(id)) continue;
      (on ? selAdds : selRemoves).push(id);
    }

    const addRows = [...adds.values()];
    const rows =
      addRows.length + edits.length + removals.length + layerEdits.length + selAdds.length + selRemoves.length;
    if (rows === 0) return null;

    const t0 = performance.now();
    await this.store.write((tx) => {
      for (const r of addRows) tx.add("shape", r);
      for (const e of edits) tx.edit("shape", e.prev, e.next);
      for (const r of removals) tx.remove("shape", r);
      for (const e of layerEdits) tx.edit("layer", e.prev, e.next);
      for (const id of selAdds) tx.add("selection", { shape: id });
      for (const id of selRemoves) tx.remove("selection", { shape: id });
    });
    const ms = performance.now() - t0;

    for (const r of addRows) this.mirror.add(r);
    for (const e of edits) this.mirror.edit(e.next);
    for (const r of removals) this.mirror.remove(r.id);
    for (const e of layerEdits) this.mirror.editLayer(e.next);
    for (const id of selAdds) this.mirror.addSelection(id);
    for (const id of selRemoves) this.mirror.removeSelection(id);

    if (record && this.onCommit && (addRows.length || edits.length || removals.length || layerEdits.length)) {
      this.onCommit({ adds: addRows, edits, removes: removals, layers: layerEdits });
    }

    this.count(ms, rows);
    return { ms, rows };
  }

  get idHighWater(): number {
    return this.nextId;
  }
  get zHighWater(): number {
    return this.maxZ;
  }
  get clockHighWater(): number {
    return this.clock;
  }

  private count(ms: number, rows: number): void {
    const now = performance.now();
    this.writeVisible.add(ms);
    this.writes.add(rows, now);
    this.engineWork.add(ms, now);
    this.lastCommit = { ms, rows };
    this.totalRows += rows;
  }
}

/** Re-derive a row's maintained columns from its own geometry. One home for the rule that
 *  `area` follows w×h and `c0`–`c3` follow the centre, so a row rebuilt anywhere else — an
 *  undo rewinding a deleted row's position, say — cannot forget half of it. */
export function maintained(row: ShapeRow): ShapeRow {
  return { ...row, area: round1(row.w * row.h), ...cellsOf(row.x, row.y) };
}

/** Apply a patch to a row, keeping the maintained columns maintained: `area` follows w×h,
 *  `c0`–`c3` follow the centre, and `updated` is the commit's clock tick.
 *
 *  The cell recompute is what makes a shape dragged across a cell boundary a clean
 *  Remove-from-one-view + Add-to-the-other: the engine's `filter_push` splits the Edit by each
 *  cell query's predicate, and the push index routes it to BOTH the old and the new cell's
 *  connection because an Edit contributes `row[col]` and `old[col]`. Nothing here has to know
 *  that — it just has to keep the column true. */
function finishRow(prev: ShapeRow, patch: Partial<ShapeRow>, updated: number): ShapeRow {
  const next = { ...prev, ...patch, updated };
  if (patch.w !== undefined || patch.h !== undefined) next.area = round1(next.w * next.h);
  if (patch.x !== undefined) next.x = round1(next.x);
  if (patch.y !== undefined) next.y = round1(next.y);
  if (patch.w !== undefined) next.w = round1(next.w);
  if (patch.h !== undefined) next.h = round1(next.h);
  // Rotation is folded into `[0, 2π)` and kept to four decimals — a hundredth of a degree, so a
  // spun shape's column does not accumulate turns, and an undo compares equal to what it
  // restored. Nothing DERIVED moves: `area` is w × h at any angle, and the cells come from the
  // centre a rotation turns about.
  if (patch.rot !== undefined) next.rot = roundRot(next.rot);
  if (patch.x !== undefined || patch.y !== undefined) Object.assign(next, cellsOf(next.x, next.y));
  return next;
}
