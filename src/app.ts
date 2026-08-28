// The demo, headless. No DOM anywhere in this file — the page is a renderer over it.
//
// Every panel (the canvas included) reads its LIVE engine view. Writes land through
// `Writer.commit`, the engine folds the delta into every affected view inside that same call,
// and the next paint reads the updated arrays. Nothing re-runs, ever.
//
// The page never re-runs a query on a timer. Each view is materialized once and stays current by
// folding the engine's deltas into its maintained array.

import type { ArrayView, FlatChange, WireSchema } from "@rindle/client";

import { Bots } from "./bots.ts";
import { cellsForView, levelForZoom } from "./cell.ts";
import { errText, makeCustomDef } from "./custom.ts";
import { boot, type Engine } from "./engine.ts";
import { aabbOf, boundsOf, unionRect, type Rect } from "./geom.ts";
import { History, type StepDelta } from "./history.ts";
import { Mirror, type ShapeRow } from "./mirror.ts";
import { Samples, jsHeapBytes } from "./metrics.ts";
import {
  cellPaint,
  extent,
  layerCounts,
  recent,
  selection,
  tally,
  top,
  type CellArgs,
  type ExtentArgs,
  type QueryDef,
  type ResultRow,
} from "./queries.ts";
import { confetti, initialScene } from "./scene.ts";
import { CONFETTI_WHO, LAYERS, YOU } from "./schema.ts";
import { Writer, type Mut } from "./write.ts";

/** Every subscription ever made, counted. See {@link LiveQuery.seq}. */
let subscriptionEpoch = 0;

/** How many confetti rows one commit may carry.
 *
 *  A drop is a BATCH job, not a single transaction: `addConfetti(32_000)` is sixteen commits of
 *  this size, one per frame, not one commit that owns the main thread for as long as it takes.
 *  The engine's bill is the same rows either way — what batching buys is that the page keeps
 *  painting, panning and drawing while they land, and that the frame the drop starts on is a
 *  frame like any other. Saturating one frame with the whole pile is the one way this demo can
 *  make an incremental engine look like a batch one.
 *
 *  2,000 is the size the button's first press has always used — the batch whose cost the demo
 *  already prints on the status line as one commit's worth of work. */
export const CONFETTI_BATCH = 2000;

/** Hand the frame back before committing the next batch. The page has a `requestAnimationFrame`
 *  and that is exactly the beat we want to land on; a macrotask is the same promise shape with
 *  the same serialization. */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** One live query: the maintained view, plus everything a panel says about it. */
export class LiveQuery<A> {
  readonly def: QueryDef<A>;
  args: A;
  view!: ArrayView<ResultRow>;
  /** Wall time of the most recent materialize — what subscribing THIS query cost. */
  hydrateMs = 0;
  /** Bumped on every fold; panels repaint only when it moves. Seeded from a monotonic counter
   *  rather than from zero, because a re-SUBSCRIBED query would otherwise look exactly like the
   *  one it replaced: a fresh pipeline has folded nothing, so its `seq` is 0, and a panel that
   *  last rendered at 0 keeps painting the old rows. Selecting used to hide this — every click
   *  also raised the shape, and that write folded the counter off 0 within a frame — but a
   *  marquee re-subscribes on every frame it sweeps and writes nothing at all. */
  seq = 0;
  folds = 0;
  lastMovedAt = 0;
  lastDelta: string | null = null;

  private readonly root: Engine["store"];
  private detach: Array<() => void> = [];

  constructor(store: Engine["store"], def: QueryDef<A>, args: A) {
    this.def = def;
    this.args = args;
    this.root = store;
    this.materialize();
  }

  private materialize(): void {
    this.seq = ++subscriptionEpoch;
    const t0 = performance.now();
    this.view = this.def.query(this.root.query, this.args).materialize() as ArrayView<ResultRow>;
    this.hydrateMs = performance.now() - t0;
    this.detach.push(
      this.view.subscribe(() => {
        this.seq++;
        this.folds++;
        this.lastMovedAt = performance.now();
      }),
    );
    this.detach.push(
      this.view.onChanges((changes) => {
        if (changes.length > 0) this.lastDelta = describeChange(changes[changes.length - 1], this.view.schema);
      }),
    );
  }

  get data(): readonly ResultRow[] {
    return this.view.data;
  }

  /** Tear this pipeline out and subscribe the query again with new args (a zoom level stepping,
   *  a different shape selected). Re-hydrating is the price of a NEW query, and it is timed. */
  retarget(args: A): void {
    this.args = args;
    this.destroy();
    this.materialize();
  }

  destroy(): void {
    for (const d of this.detach) d();
    this.detach = [];
    this.view.destroy();
  }
}

/** The most shapes one selection may hold.
 *
 *  Selecting itself no longer needs a bound — it is a write to the `selection` table, and one
 *  commit of a few thousand tiny rows is the confetti drop the demo already brags about. What
 *  needs one is DRAGGING: a moving selection is that many shape edits every frame, which is the
 *  only part of a selection whose cost recurs. Five hundred edits a frame is comfortable; thirty
 *  thousand (a brush over a confetti drop) is not.
 *
 *  It clamps to the shapes on TOP (`select` is handed paint order) and reports what it dropped,
 *  because a demo that quietly selects less than the brush covered is lying about the brush. */
export const MAX_SELECTION = 512;

/** Two id lists, already canonicalised, holding the same ids. */
function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** How long a cell that has left the viewport stays subscribed. Panning across a boundary and
 *  straight back — a jittery drag, a shove and a correction — must not tear the pipeline out and
 *  build it again. A hydrate is microseconds, not free, and the churn would show up in the HUD as
 *  work the app did not need to do. */
const CELL_EVICT_MS = 1200;

/** …but the grace period must absorb JITTER, not travel. A fast pan crosses many boundaries
 *  inside one 1.2 s window, and a purely time-based eviction lets every cell it passed over stay
 *  subscribed until its own timer expires — the set grew 3x across a hard pan before this cap
 *  existed (the browser smoke caught it). So the cooling set is also bounded by the size of the
 *  live one: past that, the oldest go immediately. Memory is then O(viewport), not O(distance
 *  travelled). */
const COOLING_RATIO = 1;

/** The canvas as a SET of live queries — one per visible cell — rather than one query over the
 *  whole table.
 *
 *  This is the whole infinite-canvas argument in one class. Panning re-runs nothing: it
 *  subscribes the cells coming into view, and drops the ones that left after a grace period.
 *  Every cell already in view keeps its pipeline and keeps folding writes, so the INTERIOR of a
 *  pan is free and only the edge costs anything. What a boundary crossing costs is one hydrate
 *  per new cell, and a single-cell hydrate is a seek — the engine's where-guard seek turns
 *  `where.c1(id)` into an index seek that breaks at the cell edge instead of scanning the table.
 *
 *  Zoom is the one camera move that is not incremental: a level change means a different COLUMN
 *  addresses a cell, so every subscription becomes a different query. That is rare, and it is
 *  honest to pay for it visibly.
 */
export class CellViews {
  level = 0;
  readonly views = new Map<number, LiveQuery<CellArgs>>();
  /** Cells that have left the viewport, and when their grace period expires. */
  private readonly evictAt = new Map<number, number>();
  /** Bumped whenever the subscribed SET changes — half of the merge cache key. */
  private gen = 0;
  private merged: ShapeRow[] = [];
  private mergedGen = -1;
  private mergedSeq = -1;
  subscribes = 0;
  teardowns = 0;
  /** What subscribing one cell cost, sampled — the number tile size is chosen against. */
  readonly hydrate = new Samples(256);

  private readonly store: Engine["store"];
  constructor(store: Engine["store"]) {
    this.store = store;
  }

  /** Bring the subscription set in line with the camera. */
  retarget(level: number, want: readonly number[], now: number): void {
    if (level !== this.level) {
      this.teardowns += this.views.size;
      for (const v of this.views.values()) v.destroy();
      this.views.clear();
      this.evictAt.clear();
      this.level = level;
      this.gen++;
    }
    for (const cell of want) {
      this.evictAt.delete(cell);
      if (this.views.has(cell)) continue;
      const q = new LiveQuery(this.store, cellPaint, { cell, level });
      this.hydrate.add(q.hydrateMs);
      this.views.set(cell, q);
      this.subscribes++;
      this.gen++;
    }
    const live = new Set(want);
    for (const [cell, q] of [...this.views]) {
      if (live.has(cell)) continue;
      const due = this.evictAt.get(cell);
      if (due === undefined) {
        this.evictAt.set(cell, now + CELL_EVICT_MS);
        continue;
      }
      if (now >= due) this.evict(cell, q);
    }
    // Bound the cooling set. `evictAt` is a Map, so its iteration order IS insertion order —
    // the cells that left the viewport longest ago come first, and those are the ones a pan is
    // least likely to come back to.
    const cap = Math.max(8, Math.round(want.length * COOLING_RATIO));
    if (this.evictAt.size > cap) {
      let over = this.evictAt.size - cap;
      for (const cell of [...this.evictAt.keys()]) {
        if (over-- <= 0) break;
        const q = this.views.get(cell);
        if (q) this.evict(cell, q);
        else this.evictAt.delete(cell);
      }
    }
  }

  private evict(cell: number, q: LiveQuery<CellArgs>): void {
    q.destroy();
    this.views.delete(cell);
    this.evictAt.delete(cell);
    this.teardowns++;
    this.gen++;
  }

  /** Cells still subscribed only because their grace period has not expired. */
  get coolingDown(): number {
    return this.evictAt.size;
  }

  /** The paint list: every subscribed cell's rows in ONE z order.
   *
   *  Each cell's view is already sorted by `(z, id)` — the engine's completed ORDER BY — so this
   *  is a k-way MERGE, not a sort, and it runs only when some cell actually folded or the set
   *  changed. Both halves of the cache key are monotone (a view's `seq` only increases; `gen`
   *  only increases), so a stale read is not possible. */
  rows(): readonly ShapeRow[] {
    let seq = 0;
    for (const v of this.views.values()) seq += v.seq;
    if (this.gen === this.mergedGen && seq === this.mergedSeq) return this.merged;
    this.mergedGen = this.gen;
    this.mergedSeq = seq;
    this.merged = mergeByZ([...this.views.values()].map((v) => v.data as unknown as ShapeRow[]));
    return this.merged;
  }

  destroy(): void {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    this.evictAt.clear();
    this.gen++;
  }
}

/** K-way merge of per-cell paint lists, each already `(z asc, id asc)`. A binary heap over the
 *  list heads: O(n log K) with no re-sort of rows the engine already ordered. */
function mergeByZ(lists: ShapeRow[][]): ShapeRow[] {
  const live = lists.filter((l) => l.length > 0);
  if (live.length === 0) return [];
  if (live.length === 1) return live[0].slice();
  const at = new Array<number>(live.length).fill(0);
  const before = (a: number, b: number): boolean => {
    const x = live[a][at[a]];
    const y = live[b][at[b]];
    return x.z !== y.z ? x.z < y.z : x.id < y.id;
  };
  const heap: number[] = [];
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && before(heap[l], heap[m])) m = l;
      if (r < heap.length && before(heap[r], heap[m])) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m], heap[i]];
      i = m;
    }
  };
  let total = 0;
  for (let i = 0; i < live.length; i++) {
    total += live[i].length;
    heap.push(i);
    up(heap.length - 1);
  }
  const out: ShapeRow[] = new Array(total);
  let n = 0;
  while (heap.length > 0) {
    const i = heap[0];
    out[n++] = live[i][at[i]++];
    if (at[i] < live[i].length) {
      down(0);
    } else {
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        down(0);
      }
    }
  }
  return out;
}

export interface AppStats {
  rows: number;
  wasmHeapBytes: number | null;
  jsHeapBytes: number | null;
  writesPerSec: number;
  writeVisibleP50: number;
  writeVisibleP99: number;
  lastCommitMs: number;
  lastCommitRows: number;
  engineMsPerSec: number;
  resubscribeP50: number;
  /** Cells subscribed right now, and what one cell's hydrate costs. */
  cellsLive: number;
  cellsCoolingDown: number;
  cellLevel: number;
  cellSubscribes: number;
  cellTeardowns: number;
  cellHydrateP50: number;
  /** Undo steps available in each direction, and the rows the stack is holding alive so redo
   *  can put them back — history's whole memory cost, said out loud. */
  undoDepth: number;
  redoDepth: number;
  historyRows: number;
}

/** An undo or redo that has been committed: the step, and what folding its delta into every
 *  view actually cost. */
export interface AppliedStep extends StepDelta {
  ms: number;
}

/** One user-authored pane: its id, and the live query built from the last GOOD text. A failed
 *  edit never reaches `live` — the previous subscription keeps folding while the error shows. */
export interface CustomPane {
  readonly id: number;
  live: LiveQuery<void>;
}

export type CustomResult = { ok: true; id: number } | { ok: false; error: string };

export class DrawApp {
  engine!: Engine;
  readonly mirror = new Mirror();
  writer!: Writer;
  bots!: Bots;

  /** The canvas: one live query per visible cell, and nothing else. There is deliberately NO
   *  whole-drawing subscription — the global `paint` query survives only as a `QueryDef`, whose
   *  canvas itself is split into the cell subscriptions held in `cells`. */
  cells!: CellViews;
  tally!: LiveQuery<void>;
  layers!: LiveQuery<void>;
  top!: LiveQuery<void>;
  recent!: LiveQuery<void>;
  /** The selection card's view. Subscribed at boot with constant args and never re-subscribed:
   *  selecting is a write to the `selection` table that this view folds. */
  sel!: LiveQuery<void>;
  /** The selection as the POINTER knows it, updated synchronously so a gesture can act on the
   *  click that started it. The engine learns the same thing a commit later, and `sel` is the
   *  authority on the rows; this is the authority on the intent. */
  private selIds: number[] = [];
  private selSet = new Set<number>();
  /** How many shapes the last `select` dropped on the floor (see {@link MAX_SELECTION}) — the
   *  page says so out loud rather than silently selecting fewer than the brush covered. */
  selectionClamped = 0;
  /** User-authored panes — forked from a built-in or typed from scratch (see `custom.ts`). */
  readonly customs: CustomPane[] = [];
  private customSeq = 0;

  /** Undo/redo. Not a stack of documents — a stack of DELTAS, replayed through the same commit
   *  funnel as everything else, so every view folds an undo exactly the way it folds a drag.
   *  See `history.ts`; it is wired to the writer in `boot`. */
  readonly history = new History(() => this.selIds);

  /** The drawing's extent, as four `ORDER BY … LIMIT 1` queries — subscribed the first time
   *  something asks to fit the view, never at boot (see `queries.ts`). */
  private extent: Array<LiveQuery<ExtentArgs>> | null = null;

  /** Wall time of subscribing a selection / a custom pane — the "a click is a subscription"
   *  number. */
  readonly resubscribe = new Samples(256);

  private confettiSeed = 1;

  ready = false;

  async boot(wasmUrl?: string): Promise<void> {
    this.engine = await boot(wasmUrl);
    this.writer = new Writer(this.engine.store, this.mirror);
    await this.writer.seedLayers(LAYERS.map((l) => ({ ...l })));
    await this.writer.seed(initialScene()); // not recorded: the opening scene is not a step you took
    // From here every RECORDED commit folds into the open history step. The robots' ticks, the
    // seed above, and the undo's own commits pass `record = false` and never reach it.
    this.writer.onCommit = (rec) => this.history.record(rec, performance.now());
    this.bots = new Bots(this.mirror);

    const store = this.engine.store;
    this.cells = new CellViews(store);
    this.tally = new LiveQuery(store, tally, undefined);
    this.layers = new LiveQuery(store, layerCounts, undefined);
    this.top = new LiveQuery(store, top, undefined);
    this.recent = new LiveQuery(store, recent, undefined);
    this.sel = new LiveQuery(store, selection, undefined);
    this.ready = true;
  }

  /** Point the canvas at a viewport: subscribe the cells it covers, drop the ones it left.
   *  Called every frame; almost every call is a no-op, because the cell set only changes when
   *  the camera crosses a cell boundary or steps a zoom level. */
  lookAt(view: { x0: number; y0: number; x1: number; y1: number }, zoom: number, now: number): void {
    const level = levelForZoom(zoom);
    this.cells.retarget(level, cellsForView(level, view.x0, view.y0, view.x1, view.y1), now);
  }

  /** Every live query, including the cell subscriptions currently held by the canvas. */
  queries(): Array<LiveQuery<unknown>> {
    const list: Array<LiveQuery<unknown>> = [
      this.tally as LiveQuery<unknown>,
      this.layers as LiveQuery<unknown>,
      this.top as LiveQuery<unknown>,
      this.recent as LiveQuery<unknown>,
    ];
    list.push(this.sel as LiveQuery<unknown>);
    for (const v of this.cells.views.values()) list.push(v as LiveQuery<unknown>);
    for (const q of this.extent ?? []) list.push(q as LiveQuery<unknown>);
    for (const c of this.customs) list.push(c.live as LiveQuery<unknown>);
    return list;
  }

  // -- history -----------------------------------------------------------------------------------

  /** Open a new undo step — the start of a gesture, a keystroke, a button. */
  mark(tag: string, coalesceMs = 0): void {
    this.history.mark(tag, performance.now(), coalesceMs);
  }

  /** Step back: commit the inverse delta and restore the selection the step began with.
   *
   *  Nothing here is undo-specific except the word. It is a commit like any other, so every view
   *  folds it, and the HUD times it.
   *  The selection is restored to what it was — filtered to rows that still exist, because a
   *  later step may have deleted one and undo does not resurrect what it did not remove. */
  async undo(): Promise<AppliedStep | null> {
    const step = this.history.undo();
    return step ? this.apply(step) : null;
  }

  /** …and forward again. */
  async redo(): Promise<AppliedStep | null> {
    const step = this.history.redo();
    return step ? this.apply(step) : null;
  }

  private async apply(step: StepDelta): Promise<AppliedStep> {
    // `record = false`: this commit IS the inverse of one that recorded, and a history that
    // recorded its own undos would never get anywhere. (The selection write below needs no such
    // flag — a selection-only commit changes no shape row, so it never reaches the history.)
    //
    // Its wall time is reported back rather than read off the writer afterwards: restoring the
    // selection below is a second commit, and the number the page prints has to be the DELTA's.
    const res = await this.commit(step.muts, false);
    await this.select(step.selection.filter((id) => this.mirror.get(id) !== undefined));
    return { ...step, ms: res?.ms ?? 0 };
  }

  // -- what the keyboard does --------------------------------------------------------------------

  /** ⌘D: a copy of everything selected, offset, selected in place of the originals. One commit,
   *  and the new rows are yours (`who = 0`) whoever drew the originals. */
  async duplicate(offset = 16): Promise<{ rows: number; ms: number } | null> {
    const src = this.selectionRows() as unknown as readonly ShapeRow[];
    if (src.length === 0) return null;
    this.mark("duplicate");
    const copies = src.map((s) => this.writer.duplicate(s, offset, offset, YOU));
    const res = await this.commit(copies.map((row) => ({ op: "add" as const, row })));
    await this.select(copies.map((r) => r.id));
    return res;
  }

  /** Arrow keys: move the selection by a world-unit delta. Its own history step, but a HELD key
   *  is one step — sixty keystrokes a second have the same problem sixty commits a second do. */
  nudge(dx: number, dy: number): Promise<{ rows: number; ms: number } | null> {
    const rows = this.selectionRows() as unknown as readonly ShapeRow[];
    if (rows.length === 0) return Promise.resolve(null);
    this.mark("nudge", 600);
    const muts: Mut[] = [];
    for (const s of rows) {
      // An arrow key moves a shape exactly as a drag does, so a confetti speck it moves is
      // promoted exactly as a dragged one is (`CanvasView.promote`): the cached layer is keyed on
      // which specks it holds, not on where they are, and a speck moved while still in it would
      // keep painting at its old position. The writer coalesces both patches into one edit.
      if (s.who === CONFETTI_WHO) muts.push({ op: "set", id: s.id, patch: { who: YOU } });
      muts.push({ op: "set", id: s.id, patch: { x: s.x + dx, y: s.y + dy } });
    }
    return this.commit(muts);
  }

  // -- what the camera asks for ------------------------------------------------------------------

  /** The selection's bounding box — ⇧2. */
  selectionBounds(): Rect | null {
    return boundsOf(this.selectionRows() as unknown as readonly ShapeRow[]);
  }

  /** The whole drawing's bounding box — ⇧1 — from the four extent queries, subscribing them on
   *  first use. `hydrateMs` is what that first subscription cost; from then on the extent is
   *  maintained by the engine and reading it is reading four arrays. */
  contentBounds(): { rect: Rect | null; hydrateMs: number; fresh: boolean } {
    const fresh = this.extent === null;
    if (!this.extent) {
      const store = this.engine.store;
      this.extent = (
        [
          { col: "x", dir: "asc" },
          { col: "x", dir: "desc" },
          { col: "y", dir: "asc" },
          { col: "y", dir: "desc" },
        ] as ExtentArgs[]
      ).map((args) => new LiveQuery(store, extent, args));
    }
    let rect: Rect | null = null;
    let hydrateMs = 0;
    for (const q of this.extent) {
      hydrateMs += q.hydrateMs;
      const row = q.data[0] as unknown as ShapeRow | undefined;
      if (row) rect = unionRect(rect, aabbOf(row));
    }
    return { rect, hydrateMs, fresh };
  }

  /** Subscribe a user-authored pane. Bad text (a syntax error, an unsupported shape, a
   *  non-query expression) comes back as `error` and subscribes nothing. */
  addCustom(code: string): CustomResult {
    const id = this.customSeq + 1;
    const live = this.subscribeCustom(id, code);
    if (typeof live === "string") return { ok: false, error: live };
    this.customSeq = id;
    this.customs.push({ id, live });
    return { ok: true, id };
  }

  /** Re-subscribe a pane with new text. On failure the previous query STAYS live — the pane
   *  keeps folding while the visitor fixes the error. */
  editCustom(id: number, code: string): CustomResult {
    const pane = this.customs.find((c) => c.id === id);
    if (!pane) return { ok: false, error: "no such pane" };
    const live = this.subscribeCustom(id, code);
    if (typeof live === "string") return { ok: false, error: live };
    pane.live.destroy();
    pane.live = live;
    return { ok: true, id };
  }

  removeCustom(id: number): void {
    const i = this.customs.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.customs[i].live.destroy();
    this.customs.splice(i, 1);
  }

  /** Build + materialize a custom pane's query; a timed subscription like any other. Returns
   *  the error text instead of throwing so callers keep the ok/error shape. */
  private subscribeCustom(id: number, code: string): LiveQuery<void> | string {
    try {
      const def = makeCustomDef(`yours-${id}`, code);
      const t0 = performance.now();
      const live = new LiveQuery(this.engine.store, def, undefined);
      this.resubscribe.add(performance.now() - t0);
      return live;
    } catch (e) {
      return errText(e);
    }
  }

  /** The render source for a query: the live view's maintained array. */
  current<A>(q: LiveQuery<A>): readonly ResultRow[] {
    return q.data;
  }

  /** Select a set of shapes (empty = nothing selected).
   *
   *  This is a WRITE, not a re-subscription: it diffs the wanted set against the current one and
   *  commits a `selection` row per shape that actually crossed in or out. A marquee dragged
   *  across the drawing therefore costs the shapes at the edge of the box, not the whole set —
   *  and the selection view folds that delta like any other write. The returned promise is the
   *  commit; callers that need the rows (rather than just the intent) await it.
   *
   *  `ids` arrives in PAINT order (both callers walk the painted rows z-ascending), which is what
   *  makes the clamp take the shapes on top. */
  select(ids: readonly number[]): Promise<unknown> {
    const uniq = [...new Set(ids)];

    // Clamp, keeping what is ALREADY selected first. A marquee re-offers a growing set every
    // frame, and clamping it by "topmost wins" would slide the retained window as the box grew —
    // shapes dropping out of the selection while you are still dragging towards them, which both
    // flickers and writes: a measured sweep churned 2,434 selection rows to end up holding 512.
    // Held membership is stable, so the remaining room fills from the END of the offered list
    // (paint order — the shapes on top), which is what ⌘A wants and a marquee never notices.
    const wanted = new Set<number>();
    for (const id of uniq) if (this.selSet.has(id)) wanted.add(id);
    for (let i = uniq.length - 1; i >= 0 && wanted.size < MAX_SELECTION; i--) wanted.add(uniq[i]);
    this.selectionClamped = uniq.length - wanted.size;

    const muts: Mut[] = [];
    for (const id of wanted) if (!this.selSet.has(id)) muts.push({ op: "select", id, on: true });
    for (const id of this.selSet) if (!wanted.has(id)) muts.push({ op: "select", id, on: false });
    if (muts.length === 0) return Promise.resolve(null);

    this.selIds = [...wanted].sort((a, b) => a - b);
    this.selSet = wanted;
    return this.commit(muts);
  }

  /** Add one shape to the selection, or take it out — shift-click. */
  toggle(id: number): Promise<unknown> {
    return this.select(this.selSet.has(id) ? this.selIds.filter((i) => i !== id) : [...this.selIds, id]);
  }

  /** The selected ids, ascending. */
  get selectedIds(): readonly number[] {
    return this.selIds;
  }

  /** Membership, for the hit tests — the pointer's view, current as of this instant. */
  get selected(): ReadonlySet<number> {
    return this.selSet;
  }

  /** The selected ROWS — what a gesture measures itself against.
   *
   *  The selection view is the source, and it is the only view on the page held independently of
   *  the CAMERA: the cell queries shed a row the moment you pan off it, so a selection read from
   *  them would lose its bounding box the moment its shapes left the screen.
   *
   *  The one wrinkle is that selecting is now a write, so between the click that selects a shape
   *  and the commit that lands it there is a gap — and `beginMove` runs inside that gap, on the
   *  very pointerdown that made the selection. A shape selected in that gap is on screen by
   *  definition (you clicked or brushed it), so the cells hold its row: the fallback below reads
   *  it from there. Both sources are engine views of the same committed state, so they cannot
   *  disagree about a row's values — only about whether it is in the set yet, which the
   *  synchronous intent settles. */
  selectionRows(): readonly ResultRow[] {
    const out: ShapeRow[] = [];
    const seen = new Set<number>();
    for (const r of this.sel.data as unknown as readonly ShapeRow[]) {
      if (!this.selSet.has(r.id)) continue; // deselected this frame: gone now, not next commit
      seen.add(r.id);
      out.push(r);
    }
    if (seen.size < this.selSet.size) {
      for (const r of this.cells.rows()) {
        if (!this.selSet.has(r.id) || seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
      out.sort((a, b) => a.z - b.z || a.id - b.id); // the view's own order, kept through the merge
    }
    return out as unknown as readonly ResultRow[];
  }

  selectionRow(): ResultRow | null {
    const rows = this.selectionRows();
    return rows.length > 0 ? rows[0] : null;
  }

  /** Set the robots' write rate (0 = off). Writes coalesce per row per frame, so a higher rate
   *  first spawns whatever extra drifters keep it honest — robot-owned, never confetti — in ONE
   *  commit, then turns the dial. They are minted inside `area` (the page passes the viewport),
   *  so the writers you just asked for turn up where you are looking. */
  async setBotRate(
    perSec: number,
    area?: { x0: number; y0: number; x1: number; y1: number },
  ): Promise<{ spawned: number }> {
    const need = perSec > 0 ? this.bots.herdFor(perSec) - this.bots.herdSize : 0;
    if (need > 0) {
      const rows = this.bots.drifters(need, (...a) => this.writer.draft(...a), area);
      // Not recorded: these are the ROBOTS' shapes, minted because you turned their dial up.
      // ⌘Z is for what your hand did.
      await this.commit(rows.map((row) => ({ op: "add" as const, row })), false);
      this.bots.adopt();
    }
    this.bots.perSec = perSec;
    this.bots.enabled = perSec > 0;
    return { spawned: Math.max(0, need) };
  }

  /** Drop `n` small inert shapes — the base grows, the queries get more to hold, and the HUD
   *  shows what it cost.
   *
   *  Committed in batches of {@link CONFETTI_BATCH}, ONE PER FRAME: a press is a job that lands
   *  over the next few frames rather than a single transaction that stops the page for the
   *  length of the whole pile. Each batch is still one commit the engine folds into every
   *  affected view before it returns — the contract is per commit, and nothing about it changes
   *  because there are now sixteen of them.
   *
   *  `onBatch` is told what each one carried (`rows` this batch, `done` of `total` so far), so
   *  the page can count a drop in while it lands.
   *
   *  Returns the whole job's totals: engine time summed across the batches, rows committed, and
   *  how many commits it took. */
  async addConfetti(
    n: number,
    area?: { x0: number; y0: number; x1: number; y1: number },
    onBatch?: (batch: { rows: number; done: number; total: number; ms: number }) => void,
  ): Promise<{ ms: number; rows: number; commits: number }> {
    let ms = 0;
    let done = 0;
    let commits = 0;
    while (done < n) {
      // Every batch after the first waits for a frame. The first does not: a press should put
      // shapes on screen on the frame you pressed it, the way it always has.
      if (commits > 0) await nextFrame();
      const rows = confetti(
        Math.min(CONFETTI_BATCH, n - done),
        this.confettiSeed++,
        this.writer.idHighWater,
        this.writer.zHighWater + 1,
        this.writer.clockHighWater + 1,
        area,
      );
      // ONE history step per DROP, not per batch — ⌘Z undoes the press you made, not the last
      // sixteenth of it. The first batch opens a fresh step; the rest re-mark with the same tag
      // inside a coalescing window, which keeps that step open across the frames the job spans.
      // The window only has to outlast a frame — generously, so a struggling tab does not split a
      // drop into two steps. It cannot swallow a SEPARATE press, both because the first batch of
      // every job marks with no window at all AND because the button is dark while a drop lands
      // (`paintConfettiBtn`), so two jobs never overlap in the first place.
      //
      // The LIMIT, stated because the code does not enforce it: a GESTURE that starts mid-drop
      // shares this step. `mark` closes whatever is open, but `History.record` folds a commit
      // into whatever is open without a tag of its own — so the next batch re-marks "confetti" a
      // frame later, and the gesture's remaining per-frame commits land in the confetti step. One
      // ⌘Z then rewinds the tail of the drop and the tail of the drag together. Fixing it means
      // `History` keeping one open step PER TAG and `Writer.commit` carrying a tag to route by;
      // the exposure is the sixteen frames a drop takes, so that machinery is not paid for here.
      //
      // Recorded, which is the most extreme thing history does here: ⌘Z on a 32,000-row drop is
      // 32,000 removes in one commit.
      this.mark("confetti", commits === 0 ? 0 : 5000);
      const res = await this.writer.seed(rows, true);
      ms += res.ms;
      done += res.rows;
      commits++;
      onBatch?.({ rows: res.rows, done, total: n, ms });
    }
    return { ms, rows: done, commits };
  }

  /** One transaction. `record` is whether it belongs to YOUR history — the robots' ticks and an
   *  undo's own inverse pass `false`. */
  commit(muts: Mut[], record = true): Promise<{ ms: number; rows: number } | null> {
    return this.writer.commit(muts, record);
  }

  stats(): AppStats {
    const now = performance.now();
    return {
      rows: this.mirror.size,
      wasmHeapBytes: this.engine.wasmHeapBytes(),
      jsHeapBytes: jsHeapBytes(),
      writesPerSec: this.writer.writes.perSecond(now),
      writeVisibleP50: this.writer.writeVisible.quantile(0.5),
      writeVisibleP99: this.writer.writeVisible.quantile(0.99),
      lastCommitMs: this.writer.lastCommit.ms,
      lastCommitRows: this.writer.lastCommit.rows,
      engineMsPerSec: this.writer.engineWork.perSecond(now),
      resubscribeP50: this.resubscribe.quantile(0.5),
      cellsLive: this.cells.views.size,
      cellsCoolingDown: this.cells.coolingDown,
      cellLevel: this.cells.level,
      cellSubscribes: this.cells.subscribes,
      cellTeardowns: this.cells.teardowns,
      cellHydrateP50: this.cells.hydrate.quantile(0.5),
      undoDepth: this.history.depth.undo,
      redoDepth: this.history.depth.redo,
      historyRows: this.history.rowsHeld,
    };
  }

  destroy(): void {
    for (const q of this.queries()) q.destroy();
  }

}

// ---------------------------------------------------------------------------------------------
// Delta rendering — one short line per fold, from the change stream itself
// ---------------------------------------------------------------------------------------------

/** Render one folded `FlatChange` for a panel footer. All of this demo's queries are flat, so
 *  the row is positional cells named by the view's own `WireSchema`. */
export function describeChange(c: unknown, schema: WireSchema | null): string {
  const change = c as FlatChange;
  const cols = schema?.columns ?? null;
  const op = change?.op;
  if (!op) return "?";
  switch (op.tag) {
    case "add":
      return `+ ${identify(op.node?.row, cols)}`;
    case "remove":
      return `− ${identify(op.row, cols)}`;
    case "edit": {
      const changed: string[] = [];
      const n = Math.max(op.old?.length ?? 0, op.new?.length ?? 0);
      // A countAs view's flat rows carry the aggregate cell, but its WireSchema lists only the
      // base columns — positional labels would misalign, so cells are named only when they do.
      const aligned = cols !== null && n === cols.length;
      for (let i = 0; i < n; i++) {
        if (op.old?.[i] !== op.new?.[i] && (!aligned || cols[i] !== "updated")) {
          changed.push(`${aligned ? `${cols[i]} ` : ""}${cell(op.old?.[i])}→${cell(op.new?.[i])}`);
        }
      }
      return `Δ ${identify(op.new, cols)} ${changed.slice(0, 2).join(" · ") || "(clock only)"}`;
    }
    default:
      return "?";
  }
}

function identify(row: readonly unknown[] | undefined, cols: readonly string[] | null): string {
  if (!Array.isArray(row) || !cols) return "row";
  const id = cols.indexOf("id");
  if (id >= 0) return `#${String(row[id])}`;
  const color = cols.indexOf("color");
  if (color >= 0) return String(row[color]);
  return "row";
}

function cell(v: unknown): string {
  if (typeof v === "number") return String(Math.round(v));
  if (typeof v === "string") return v;
  return String(v);
}
