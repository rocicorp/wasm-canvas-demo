// The selection's geometry: oriented boxes, the eight handles, and the two transforms a gesture
// applies to them. Pure functions over rows — no canvas, no pointer, no DOM — so the whole of
// what a drag DOES is unit-testable without one (`test/units.test.ts`), and `app.ts` can reach
// the same math headlessly for ⇧2 and ⌘D.
//
// One idea runs through the file: a selection has a FRAME, and every gesture is expressed in
// that frame's own coordinates.
//
//   * one shape selected → the frame IS the shape: same centre, same size, same `rot`. Handles
//     ride around the rotated box, and a resize is exact, because the shape's local axes and the
//     frame's are the same axes.
//   * several → the frame is their axis-aligned union, `rot = 0`, which is what tldraw draws for
//     a multi-selection and the only frame in which "drag the east edge" means anything shared.
//
// A rotated shape inside an axis-aligned multi-selection is the one place that cannot be exact:
// scaling a rotated rectangle by different factors on each axis is a parallelogram, and the
// schema stores rectangles. `applyResize` projects the world scale onto the shape's own axes
// (`|cos|·sx + |sin|·sy`), which is exact at every right angle and smooth in between — a
// deliberate approximation, and the only one in here.

import type { ShapeRow } from "./mirror.ts";

export const TAU = Math.PI * 2;

/** Nothing scales below this, in world units — the floor is on the FRAME, not on each shape, so
 *  scaling a set never inflates its smallest member. */
export const MIN_SIZE = 8;

/** An axis-aligned world rectangle. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** An oriented box: a centre, a size, and a rotation about that centre. */
export interface Frame {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

/** The eight scale handles, plus the rotate handle above the frame's top edge. */
export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

export const CORNERS: HandleId[] = ["nw", "ne", "se", "sw"];
export const EDGES: HandleId[] = ["n", "e", "s", "w"];

/** Where one shape was when a gesture started. Snapshotted ONCE, at grab time, so every frame of
 *  a drag writes an absolute position derived from where the shape began rather than from where
 *  the previous frame's write left it — which would compound rounding and pull a moving set
 *  apart shape by shape. */
export interface Origin {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

/** Snapshot where a set of shapes begins a gesture. */
export function originsOf(rows: readonly ShapeRow[]): Origin[] {
  return rows.map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot }));
}

// ---------------------------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------------------------

/** Rotate `(x, y)` about the origin by `rot` radians. */
export function rotPoint(x: number, y: number, rot: number): { x: number; y: number } {
  if (rot === 0) return { x, y };
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** An angle folded into `[0, 2π)` — `rot` is a stored column, so it must not drift up by 2π
 *  every time a shape is spun round. */
export function normAngle(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}

/** Snap to the nearest multiple of `step` radians — what ⇧ does while rotating (15°). */
export function snapAngle(a: number, step: number): number {
  return Math.round(a / step) * step;
}

// ---------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------

/** One shape's axis-aligned bounding box, rotation included.
 *
 *  The four corners of the rotated box, for every kind. A rotated ellipse's true extent is
 *  tighter than its box's, but the box is what a selection, a marquee and the viewport cull all
 *  agree to mean by "where this shape is" — and being a hair generous only ever draws or selects
 *  something you can see. */
export function aabbOf(s: Pick<ShapeRow, "x" | "y" | "w" | "h" | "rot">): Rect {
  const hw = s.w / 2;
  const hh = s.h / 2;
  if (!s.rot) return { x0: s.x - hw, y0: s.y - hh, x1: s.x + hw, y1: s.y + hh };
  const c = Math.abs(Math.cos(s.rot));
  const sn = Math.abs(Math.sin(s.rot));
  const ex = hw * c + hh * sn;
  const ey = hw * sn + hh * c;
  return { x0: s.x - ex, y0: s.y - ey, x1: s.x + ex, y1: s.y + ey };
}

/** The union of some shapes' boxes — the selection's axis-aligned bounds — or null for none. */
export function boundsOf(rows: readonly ShapeRow[]): Rect | null {
  if (rows.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of rows) {
    const b = aabbOf(s);
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}

/** The union of two rectangles, either of which may be null. */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** Is `s` entirely outside `r`? The viewport cull, the marquee, and the selection's own cull —
 *  one test. */
export function offscreen(s: Pick<ShapeRow, "x" | "y" | "w" | "h" | "rot">, r: Rect): boolean {
  const b = aabbOf(s);
  return b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1;
}

/** The world rectangle two dragged corners describe, in either direction. */
export function rectOf(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

/** Which shapes a marquee covers, in the paint order it was given — anything whose box the
 *  marquee touches, which is tldraw's rule (a brush need not swallow a shape whole).
 *
 *  Boxes rather than the exact outlines the hit test uses: a marquee is a coarse gesture and the
 *  difference is a few pixels at the corner of an ellipse, whereas running real geometry over
 *  every painted row on every frame of the drag is not free. */
export function marqueeHits(rows: readonly ShapeRow[], r: Rect): number[] {
  const out: number[] = [];
  for (const s of rows) if (!offscreen(s, r)) out.push(s.id);
  return out;
}

/** Is `p` inside this shape? The one hit test behind the cursor, the click, and the drag — run
 *  in the shape's OWN frame, so a rotated triangle is grabbable where it is drawn and not where
 *  it would have been. */
export function hitShape(p: { x: number; y: number }, s: ShapeRow, px: number): boolean {
  const hw = Math.max(s.w / 2, 4 * px); // small confetti still gets a grabbable hit box
  const hh = Math.max(s.h / 2, 4 * px);
  const { x: dx, y: dy } = rotPoint(p.x - s.x, p.y - s.y, -s.rot);
  if (Math.abs(dx) > hw || Math.abs(dy) > hh) return false;
  if (s.kind === "ellipse" && (dx / hw) ** 2 + (dy / hh) ** 2 > 1) return false;
  if (s.kind === "tri" && dy < ((Math.abs(dx) / hw) * 2 - 1) * hh) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------------------------

/** The selection's frame: the shape itself when there is exactly one (rotation included), the
 *  axis-aligned union when there are several. Null for an empty selection. */
export function frameOf(rows: readonly ShapeRow[]): Frame | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const s = rows[0];
    return { cx: s.x, cy: s.y, w: s.w, h: s.h, rot: s.rot ?? 0 };
  }
  const b = boundsOf(rows)!;
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, w: b.x1 - b.x0, h: b.y1 - b.y0, rot: 0 };
}

/** A world point in the frame's own coordinates: origin at the centre, axes along the box. */
export function toLocal(f: Frame, p: { x: number; y: number }): { x: number; y: number } {
  return rotPoint(p.x - f.cx, p.y - f.cy, -f.rot);
}

/** …and back. */
export function toWorld(f: Frame, l: { x: number; y: number }): { x: number; y: number } {
  const r = rotPoint(l.x, l.y, f.rot);
  return { x: f.cx + r.x, y: f.cy + r.y };
}

/** The frame's box in its own coordinates. */
export function localBox(f: Frame): Rect {
  return { x0: -f.w / 2, y0: -f.h / 2, x1: f.w / 2, y1: f.h / 2 };
}

/** How far outside the frame the rotate handle floats, in screen pixels. */
export const ROTATE_OFFSET = 22;
/** How far outside the frame the selection outline — and the handles on it — sit. */
const OUTLINE_PAD = 4;
/** …and the smallest ring the handles may form, whatever the frame's size. A confetti speck is
 *  two pixels across: handles ON its corners would cover the shape entirely and there would be
 *  nowhere left to grab it by, so the outline stops shrinking here and the speck keeps a
 *  draggable middle. */
const MIN_RING = 11;
/** The drawn handle's half-size, in screen pixels. */
export const HANDLE_R = 4.5;
/** …and how close a pointer must come. Bigger than what is drawn: the handles are small at
 *  every zoom, and one test behind both the cursor and the gesture keeps what you see and what
 *  you grab from drifting apart. */
export const HANDLE_HIT = 10;

/** Below this many screen pixels a side has no room for its edge handle, so only the corners
 *  are drawn (and only the corners can be grabbed). */
const EDGE_MIN_PX = 26;

/** The half-extents of the selection's OUTLINE, in world units: the frame, padded, and never
 *  below the minimum ring. The dashed box and the handles are both drawn from this, so what you
 *  see and what you can grab are the same rectangle by construction. */
export function outlineOf(f: Frame, px: number): { ex: number; ey: number } {
  return {
    ex: Math.max(f.w / 2, MIN_RING * px) + OUTLINE_PAD * px,
    ey: Math.max(f.h / 2, MIN_RING * px) + OUTLINE_PAD * px,
  };
}

/** Where a scale handle actually PULLS: the corner or edge midpoint of the frame itself, not of
 *  the padded outline the handle is drawn on.
 *
 *  The difference is a few pixels and it matters: a resize that took the drawn handle's position
 *  as the pointer's target would grow the shape by the padding the instant you touched it. The
 *  gesture measures from here instead, so the corner tracks your hand exactly. */
export function handleAnchor(f: Frame, h: HandleId): { x: number; y: number } {
  const b = localBox(f);
  const x = WEST.has(h) ? b.x0 : EAST.has(h) ? b.x1 : 0;
  const y = NORTH.has(h) ? b.y0 : SOUTH.has(h) ? b.y1 : 0;
  return toWorld(f, { x, y });
}

/** Every handle this frame offers, in WORLD coordinates, in hit-test order (rotate first, then
 *  corners, then edges — the same order they are drawn in reverse).
 *
 *  `px` is one screen pixel in world units, so the handles stay the same size on screen at every
 *  zoom, and a frame too small to hold its edge handles simply does not offer them. */
export function handlePoints(f: Frame, px: number): Array<{ id: HandleId; x: number; y: number }> {
  const { ex, ey } = outlineOf(f, px);
  const out: Array<{ id: HandleId; x: number; y: number }> = [];
  const at = (id: HandleId, lx: number, ly: number) => out.push({ id, ...toWorld(f, { x: lx, y: ly }) });
  at("rotate", 0, -ey - ROTATE_OFFSET * px);
  at("nw", -ex, -ey);
  at("ne", ex, -ey);
  at("se", ex, ey);
  at("sw", -ex, ey);
  if (f.w / px >= EDGE_MIN_PX) {
    at("n", 0, -ey);
    at("s", 0, ey);
  }
  if (f.h / px >= EDGE_MIN_PX) {
    at("e", ex, 0);
    at("w", -ex, 0);
  }
  return out;
}

/** Which handle is under `p`, or null. */
export function handleAt(f: Frame, p: { x: number; y: number }, px: number): HandleId | null {
  const r = HANDLE_HIT * px;
  for (const h of handlePoints(f, px)) {
    if (Math.abs(p.x - h.x) < r && Math.abs(p.y - h.y) < r) return h.id;
  }
  return null;
}

/** The cursor a handle asks for. Rotated frames rotate their cursors too — a "ne" corner on a
 *  box turned 90° pulls along the other diagonal, and promising otherwise is a lie you feel. */
export function handleCursor(h: HandleId, rot: number): string {
  if (h === "rotate") return "grab";
  const base: Record<string, number> = { e: 0, se: 1, s: 2, sw: 3, w: 4, nw: 5, n: 6, ne: 7 };
  const names = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
  const step = Math.round(normAngle(rot) / (TAU / 8));
  return names[(base[h] + step) % 4];
}

// ---------------------------------------------------------------------------------------------
// The two transforms
// ---------------------------------------------------------------------------------------------

const WEST = new Set<HandleId>(["nw", "w", "sw"]);
const EAST = new Set<HandleId>(["ne", "e", "se"]);
const NORTH = new Set<HandleId>(["nw", "n", "ne"]);
const SOUTH = new Set<HandleId>(["sw", "s", "se"]);

/** The frame's new box, in its own coordinates, with `p` (also local) dragging `h`.
 *
 *  The opposite side is the anchor — it is the one thing a scale handle must never move — and
 *  the floor is on the BOX, so a set never has its smallest member inflated to 8 units the
 *  moment you touch a handle. */
export function resizeLocalBox(f: Frame, h: HandleId, p: { x: number; y: number }, min = MIN_SIZE): Rect {
  const b = localBox(f);
  const box = { ...b };
  if (WEST.has(h)) box.x0 = Math.min(p.x, b.x1 - min);
  if (EAST.has(h)) box.x1 = Math.max(p.x, b.x0 + min);
  if (NORTH.has(h)) box.y0 = Math.min(p.y, b.y1 - min);
  if (SOUTH.has(h)) box.y1 = Math.max(p.y, b.y0 + min);
  return box;
}

/** What a resize writes: the new centre and size of every shape in the selection.
 *
 *  The whole transform is the affine map from the frame's old local box to its new one. Each
 *  shape's centre goes through it; each shape's SIZE takes the two scale factors projected onto
 *  its own axes, which is exact whenever the shape is square to the frame (always, for a single
 *  selection — the frame is the shape) and an even blend when it is not. */
export function applyResize(
  f: Frame,
  h: HandleId,
  pointer: { x: number; y: number },
  origins: readonly Origin[],
  min = MIN_SIZE,
): Array<{ id: number; x: number; y: number; w: number; h: number }> {
  const b = localBox(f);
  const box = resizeLocalBox(f, h, toLocal(f, pointer), min);
  const sx = (box.x1 - box.x0) / f.w;
  const sy = (box.y1 - box.y0) / f.h;
  return origins.map((o) => {
    const l = toLocal(f, o);
    const mapped = { x: box.x0 + (l.x - b.x0) * sx, y: box.y0 + (l.y - b.y0) * sy };
    const w = toWorld(f, mapped);
    const c = Math.abs(Math.cos(o.rot - f.rot));
    const s = Math.abs(Math.sin(o.rot - f.rot));
    return { id: o.id, x: w.x, y: w.y, w: o.w * (c * sx + s * sy), h: o.h * (c * sy + s * sx) };
  });
}

/** One 15° detent, the ⇧-rotate step. */
export const ROTATE_SNAP = TAU / 24;

/** What a rotate writes: every shape's new angle, and — for a set — its new centre, swung about
 *  the frame's. A single shape turns about itself and does not move at all. */
export function applyRotate(
  f: Frame,
  origins: readonly Origin[],
  delta: number,
  snap = false,
): Array<{ id: number; x: number; y: number; rot: number }> {
  const d = snap ? snapAngle(f.rot + delta, ROTATE_SNAP) - f.rot : delta;
  return origins.map((o) => {
    const p = rotPoint(o.x - f.cx, o.y - f.cy, d);
    return { id: o.id, x: f.cx + p.x, y: f.cy + p.y, rot: normAngle(o.rot + d) };
  });
}

// ---------------------------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------------------------

/** The camera that puts `r` on screen with `margin` device pixels to spare: what ⇧1 and ⇧2 land
 *  on. Pure — the canvas only has to install the result. */
export function fitView(
  r: Rect,
  screenW: number,
  screenH: number,
  margin: number,
  minZoom: number,
  maxZoom: number,
): { scale: number; ox: number; oy: number } {
  const w = Math.max(r.x1 - r.x0, 1e-6);
  const h = Math.max(r.y1 - r.y0, 1e-6);
  const room = (v: number) => Math.max(v - margin * 2, v / 2);
  const scale = Math.min(maxZoom, Math.max(minZoom, Math.min(room(screenW) / w, room(screenH) / h)));
  return {
    scale,
    ox: screenW / 2 - ((r.x0 + r.x1) / 2) * scale,
    oy: screenH / 2 - ((r.y0 + r.y1) / 2) * scale,
  };
}
