// Spatial cells: the columns that turn "what is on screen" into point lookups.
//
// The canvas is no longer ONE query. It is one query per visible cell — `where.c1(id)` — and
// panning subscribes the cells coming into view and tears out the ones leaving. That only pays
// if a single-cell hydrate is a seek rather than a scan, which is what the engine's
// where-guard seek buys (`MemorySource::fetch_by_guard`): an equality `where` yields a
// `PushGuard`, the guard drives a seek over a `(cell, z, id)` index, and the scan BREAKS at the
// cell edge instead of walking the table.
//
// **One column per level, not one column total.** A shape's cell has to be a function of the
// CAMERA's zoom, not of the shape, because a viewport at a coarse zoom must still draw fine
// shapes — a shape one level below the display level is still ~128 screen px, nowhere near
// subpixel, and reaching it through finer cells would mean subscribing 4^k of them. So each
// shape carries its cell at every level (`c0..c3`), computed from its centre on every write,
// and the camera picks the column. Four columns, four lazily-built indexes, and the zoom range
// is exactly the level count.
//
// Big shapes are handled by INFLATING the query one ring rather than by a size-keyed level: a
// shape is indexed by its centre, so it can overhang into a neighbouring cell, and one extra
// ring covers any shape whose bounding box fits inside a cell. Everything this demo draws does
// (shapes are <= ~250 world units; the finest cell is 256).

/** The finest cell, in world units. Sized so a 1600x1000 viewport at 100% spans 8x5 of them —
 *  the point on the over-fetch curve where a bigger cell starts wasting a lot of area and a
 *  smaller one only buys subscriptions. */
export const CELL0 = 256;

/** `c0..c3` — 256, 512, 1024, 2048 world units. The count IS the zoom-out range (8x). */
export const LEVELS = 4;

/** Cell coordinates are biased into the non-negative range so the packed id stays a small
 *  positive integer: |cx| < 2^22 cells, which at level 0 is +/- a billion world units. */
const BIAS = 1 << 22;
const STRIDE = 1 << 23;

/** The column name for a level — the demo's schema declares `c0`..`c3`. */
export function cellCol(level: number): "c0" | "c1" | "c2" | "c3" {
  return `c${clampLevel(level)}` as "c0" | "c1" | "c2" | "c3";
}

export function cellSize(level: number): number {
  return CELL0 * (1 << clampLevel(level));
}

export function clampLevel(level: number): number {
  return Math.min(LEVELS - 1, Math.max(0, level | 0));
}

/** The cell a world point falls in at `level`, packed into one integer.
 *
 *  `cy * 2^23 + cx` stays below 2^45, well inside a double's exact range — but note the engine
 *  compares `Int` cells EXACTLY (design 226), so widening the world later cannot silently
 *  collide two cells the way an f64 encoding would. */
export function cellAt(level: number, x: number, y: number): number {
  const s = cellSize(level);
  const cx = Math.floor(x / s) + BIAS;
  const cy = Math.floor(y / s) + BIAS;
  return cy * STRIDE + cx;
}

/** `{ c0, c1, c2, c3 }` for a shape's centre — what every write stamps onto the row. */
export function cellsOf(x: number, y: number): { c0: number; c1: number; c2: number; c3: number } {
  return {
    c0: cellAt(0, x, y),
    c1: cellAt(1, x, y),
    c2: cellAt(2, x, y),
    c3: cellAt(3, x, y),
  };
}

/** The level whose cells land closest to `CELL0` screen pixels at this zoom. Zooming IN past
 *  100% stays at level 0 (cells simply get bigger on screen and there are fewer of them), so
 *  zoom-in is free and only zoom-out consumes the ladder. */
export function levelForZoom(zoom: number): number {
  return clampLevel(Math.round(Math.log2(1 / Math.max(zoom, 1e-6))));
}

/** Every cell id covering the world rect, at `level`, inflated by one ring so a shape whose
 *  centre sits in a neighbouring cell but whose body overhangs into view is still found. */
export function cellsForView(
  level: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  const s = cellSize(level);
  const cx0 = Math.floor(x0 / s) - 1;
  const cx1 = Math.floor(x1 / s) + 1;
  const cy0 = Math.floor(y0 / s) - 1;
  const cy1 = Math.floor(y1 / s) + 1;
  const out: number[] = [];
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      out.push((cy + BIAS) * STRIDE + (cx + BIAS));
    }
  }
  return out;
}

/** Inverse of `cellAt`, for tests and the HUD. */
export function decodeCell(level: number, id: number): { cx: number; cy: number } {
  return { cx: (id % STRIDE) - BIAS, cy: Math.floor(id / STRIDE) - BIAS };
}
