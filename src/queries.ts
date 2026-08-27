// The page's queries — ALL of them. Everything visible on the page renders from one of these:
// the canvas paints one `cellPaint` per visible cell, the palette is the `tally` aggregate, the
// layers panel is a per-layer `countAs` join, the leaderboard is `top`, the feed is `recent`,
// and the selection card is an EXISTS over the `selection` table. Every painted query walks the
// `onLayer` EXISTS gate.
//
// Each definition carries two implementations, side by side:
//
//   query()     — the Rindle query. Registered once, maintained by the engine forever after.
//   recompute() — the same result, from scratch, over the JS mirror: the differential's
//                 "fresh query" half — code that shares no operator, no index and no line with
//                 the engine.
//
// The orderings tiebreak on the primary key ASCENDING because the engine's builder appends every
// PK column not already in the ORDER BY as `asc` (rust/rindle/src/builder.rs, add_primary_keys).
// Get that wrong and the differential reports mismatches on ties — which is how it was confirmed.

import { exists } from "@rindle/client";
import type { AnyQuery, QueryRoot } from "@rindle/client";

import type { LayerRow, Mirror, ShapeRow } from "./mirror.ts";
import { cellCol } from "./cell.ts";
import { layerShapes, onLayer, onSelection, type DrawCols } from "./schema.ts";

export type Root = QueryRoot<DrawCols>;
export type ResultRow = Record<string, unknown>;

/** The visibility gate: `EXISTS (layer WHERE visible = 1)` through the `onLayer` relationship.
 *  Every painted query carries it, so hiding a layer is ONE row edit whose consequences the
 *  joins fan out. (The tally deliberately does not — see its note.) */
const onVisibleLayer = () => exists(onLayer, (l) => l.where.visible(1));

export interface QueryDef<A> {
  readonly name: string;
  /** Where `check()`'s fresh half comes from: "mirror" (the default — an independent JS
   *  recompute over the mirror) or "resubscribe" (a fresh hydration of the same query; the
   *  custom panes', which have no hand-written oracle — see `custom.ts`). */
  readonly oracle?: "mirror" | "resubscribe";
  /** The panel's rendering of the query: the same builder chain `query()` registers, args
   *  inlined, written against the docs' named-query root `q`. */
  code(args: A): string;
  query(root: Root, args: A): AnyQuery;
  recompute(mirror: Mirror, args: A): ResultRow[];
}

// ---------------------------------------------------------------------------------------------
// Orderings (each mirrors what the engine's completed ORDER BY does, PK tiebreak included)
// ---------------------------------------------------------------------------------------------

const byZ = (a: ShapeRow, b: ShapeRow) => a.z - b.z || a.id - b.id;
const byUpdatedDesc = (a: ShapeRow, b: ShapeRow) => b.updated - a.updated || a.id - b.id;
const byAreaDesc = (a: ShapeRow, b: ShapeRow) => b.area - a.area || a.id - b.id;

function asRows(rows: ShapeRow[]): ResultRow[] {
  return rows as unknown as ResultRow[];
}

/** The recomputes' half of the gate — same predicate, plain JS over the mirror's layer map. */
function visibleRows(m: Mirror): ShapeRow[] {
  const out: ShapeRow[] = [];
  for (const row of m.all()) if (m.visibleLayer(row.layer)) out.push(row);
  return out;
}

function layersById(m: Mirror): LayerRow[] {
  return [...m.allLayers()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------------------------
// The queries
// ---------------------------------------------------------------------------------------------

/** The canvas itself: every shape on a VISIBLE layer, in paint order. Unbounded on purpose — the
 *  canvas shows the whole drawing, so the query holds the whole drawing, and the engine's job is
 *  to keep this array right by folding deltas rather than rebuilding it. The EXISTS gate is the
 *  join at work: hide a layer and ONE row edit re-derives this whole membership. */
export const paint: QueryDef<void> = {
  name: "paint",
  code: () =>
    `q.shape\n  .where(exists(onLayer,\n    (l) => l.where.visible(1)))\n  .orderBy("z", "asc")`,
  query: (root) => root.shape.where(onVisibleLayer()).orderBy("z", "asc") as AnyQuery,
  recompute: (m) => asRows(visibleRows(m).sort(byZ)),
};

/** The palette tally: a real top-level aggregate, one row per color. Recoloring one shape moves
 *  two of these counters in the same commit. Deliberately UNGATED — it is the drawing's
 *  inventory, hidden layers included (and the engine does not yet take an EXISTS in a top-level
 *  aggregate's `where`). */
export const tally: QueryDef<void> = {
  name: "tally",
  code: () => `q.shape.groupBy("color").count()`,
  query: (root) => root.shape.groupBy("color").count() as AnyQuery,
  recompute: (m) => {
    const counts = new Map<string, number>();
    for (const row of m.all()) counts.set(row.color, (counts.get(row.color) ?? 0) + 1);
    return [...counts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([color, count]) => ({ color, count }));
  },
};

/** The leaderboard: largest six visible shapes by maintained `area`. */
export const top: QueryDef<void> = {
  name: "top",
  code: () =>
    `q.shape\n  .where(exists(onLayer,\n    (l) => l.where.visible(1)))\n  .orderBy("area", "desc").limit(6)`,
  query: (root) => root.shape.where(onVisibleLayer()).orderBy("area", "desc").limit(6) as AnyQuery,
  recompute: (m) => asRows(visibleRows(m).sort(byAreaDesc).slice(0, 6)),
};

/** The feed: the eight most recently written visible rows, whoever wrote them. */
export const recent: QueryDef<void> = {
  name: "recent",
  code: () =>
    `q.shape\n  .where(exists(onLayer,\n    (l) => l.where.visible(1)))\n  .orderBy("updated", "desc").limit(8)`,
  query: (root) => root.shape.where(onVisibleLayer()).orderBy("updated", "desc").limit(8) as AnyQuery,
  recompute: (m) => asRows(visibleRows(m).sort(byUpdatedDesc).slice(0, 8)),
};

/** One cell of the canvas. `args` is the cell id and the level whose column holds it.
 *
 *  This is the query the infinite canvas is MADE of: the page subscribes one per visible cell
 *  and merges their results by z to paint. It is deliberately an EQUALITY on the cell column
 *  rather than a range over x/y, because equality is what the engine can seek: the `where`
 *  yields a `PushGuard`, the leaf turns that into a seek over a `(cell, z, id)` index, and the
 *  scan BREAKS at the cell edge. The same window written as `.where.x(ge(..)).where.x(le(..))`
 *  would be a full scan of the table per subscription — the shape this one exists to avoid.
 *
 *  It carries the same visibility gate as every other painted query, so hiding a layer still
 *  fans out through the join to every cell in view. */
export interface CellArgs {
  cell: number;
  level: number;
}

export const cellPaint: QueryDef<CellArgs> = {
  name: "cell",
  code: (a) =>
    `q.shape\n  .where.${cellCol(a.level)}(${a.cell})\n  .where(exists(onLayer,\n    (l) => l.where.visible(1)))\n  .orderBy("z", "asc")`,
  query: (root, a) => {
    const where = root.shape.where as unknown as Record<string, (v: number) => Root["shape"]>;
    return where[cellCol(a.level)](a.cell).where(onVisibleLayer()).orderBy("z", "asc") as AnyQuery;
  },
  recompute: (m, a) => {
    const col = cellCol(a.level);
    return asRows(visibleRows(m).filter((s) => s[col] === a.cell).sort(byZ));
  },
};

/** One edge of the drawing: the shape whose centre is furthest in one direction.
 *
 *  Four of these — `x asc`, `x desc`, `y asc`, `y desc` — are what ⇧1 (zoom to fit) reads, and
 *  they are the honest way to ask "how big is the drawing" on a page that deliberately runs no
 *  whole-drawing subscription. Each is an ORDER BY … LIMIT 1: the engine's `take` keeps exactly
 *  one row true through every write, so the extent is MAINTAINED rather than scanned for, and a
 *  robot dragging a shape further out than anything else moves it in the same commit.
 *
 *  They are subscribed lazily — the first time ⇧1 is pressed — because four extra orderings are
 *  four extra indexes over the base, and a page that never asks to fit should not pay for them.
 *
 *  The bound is the extreme CENTRE, padded by that row's own box, which is the true extent
 *  unless some other shape is wide enough to reach past it from further in. A zoom-to-fit lands
 *  with a margin anyway, so the difference is invisible; being exact would mean maintaining
 *  `x - w/2` as its own column, which is a real cost on every write to buy nothing you can see. */
export interface ExtentArgs {
  col: "x" | "y";
  dir: "asc" | "desc";
}

export const extent: QueryDef<ExtentArgs> = {
  name: "extent",
  code: (a) =>
    `q.shape\n  .where(exists(onLayer,\n    (l) => l.where.visible(1)))\n  .orderBy("${a.col}", "${a.dir}").limit(1)`,
  query: (root, a) => root.shape.where(onVisibleLayer()).orderBy(a.col, a.dir).limit(1) as AnyQuery,
  recompute: (m, a) => {
    const rows = visibleRows(m).sort((p, q) =>
      p[a.col] !== q[a.col] ? (a.dir === "asc" ? p[a.col] - q[a.col] : q[a.col] - p[a.col]) : p.id - q.id,
    );
    return asRows(rows.slice(0, 1));
  },
};

/** The layers panel: every layer with a LIVE `countAs` of the shapes on it — the join, as a
 *  panel. The eye toggle edits `visible` on ONE of these rows. */
export const layerCounts: QueryDef<void> = {
  name: "layers",
  code: () => `q.layer\n  .countAs("shapes", layerShapes)\n  .orderBy("id", "asc")`,
  query: (root) => root.layer.countAs("shapes", layerShapes).orderBy("id", "asc") as AnyQuery,
  recompute: (m) => {
    const counts = new Map<number, number>();
    for (const s of m.all()) counts.set(s.layer, (counts.get(s.layer) ?? 0) + 1);
    return layersById(m).map((l) => ({ ...l, shapes: counts.get(l.id) ?? 0 }));
  },
};

/** The selection card: every SELECTED shape, in paint order.
 *
 *  Registered ONCE, at boot, and never again — its args are `void`. That is the whole reason
 *  selection lives in a table: an `EXISTS` over `selection` has nothing in it that changes when
 *  you select something, so selecting is a WRITE that this view folds, exactly like every other
 *  write on the page. Brushing a marquee across the drawing emits only the shapes that crossed
 *  the box's edge on that frame.
 *
 *  The version of this that looks reasonable and is not: put the selected ids in the query —
 *  `where.id(inList([…]))`. It seeks (the builder lowers `IN` to a multi-value `PushGuard`), so
 *  it reads fast in isolation, but the selection is then part of the query's IDENTITY: every
 *  change re-registers the pipeline and re-hydrates the whole set. Measured on a 60-frame
 *  marquee over 4,230 rows, that was 60 re-subscriptions, 22,847 seeks to arrive at 512 rows,
 *  and 767 ms of hydration — 18 ms of it inside the pointermove handler, on a page whose pitch
 *  is a 300 µs write→visible. Deltas beat re-registration, which is the engine's own argument.
 *
 *  Deliberately UNGATED by layer visibility, like the card it feeds: hiding a layer is not
 *  deselecting, and it never was. */
export const selection: QueryDef<void> = {
  name: "selection",
  code: () => `q.shape\n  .where(exists(onSelection))\n  .orderBy("z", "asc")`,
  query: (root) => root.shape.where(exists(onSelection)).orderBy("z", "asc") as AnyQuery,
  recompute: (m) => {
    const out: ShapeRow[] = [];
    for (const row of m.all()) if (m.isSelected(row.id)) out.push(row);
    return asRows(out.sort(byZ));
  },
};
