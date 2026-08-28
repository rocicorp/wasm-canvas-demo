// The opening scene, generated deterministically — same seed, same drawing, in the page and in
// every test. Nothing is downloaded and nothing is random between runs: browser tests replay
// the exact scene the page shows.

import { CONFETTI_WHO, KINDS, LAYER_BACKDROP, LAYER_CONFETTI, LAYER_DRAWING, PALETTE, WORLD_H, WORLD_W } from "./schema.ts";
import { cellsOf } from "./cell.ts";
import { normAngle, type Rect } from "./geom.ts";
import type { ShapeRow } from "./mirror.ts";

/** mulberry32 — a tiny deterministic PRNG; good enough to lay out a drawing. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260819;

/** The opening composition: three color blooms (each owned by a robot, so the scene drifts), a
 *  scatter of triangles, and a few large quiet rectangles behind everything. ~300 rows — the
 *  scene is a drawing, not a benchmark; the "+2,000 shapes" button is where the pile comes from. */
export function initialScene(): ShapeRow[] {
  const r = rng(SEED);
  const rows: ShapeRow[] = [];
  let id = 1;
  let z = 1;
  let updated = 1;
  // `rot` defaults to 0 — the blooms are unrotated, and only the shapes below that say so are
  // turned. It is a plain column, so nothing else in the row changes when they are.
  const push = (
    row: Omit<ShapeRow, "id" | "z" | "updated" | "area" | "rot" | "c0" | "c1" | "c2" | "c3"> & { rot?: number },
  ) => {
    rows.push({
      rot: 0,
      ...row,
      id: id++,
      z: z++,
      updated: updated++,
      area: round1(row.w * row.h),
      ...cellsOf(row.x, row.y),
    });
  };

  // Quiet rectangles at the bottom of the paint order.
  for (let i = 0; i < 8; i++) {
    const w = 60 + r() * 160;
    const h = 50 + r() * 130;
    push({
      kind: "rect",
      x: round1(60 + r() * (WORLD_W - 120)),
      y: round1(60 + r() * (WORLD_H - 120)),
      w: round1(w),
      h: round1(h),
      color: PALETTE[Math.floor(r() * PALETTE.length)].key,
      rot: roundRot((r() - 0.5) * 0.5), // a few degrees off square — the quiet ones are tilted
      who: 1 + (i % 3),
      layer: LAYER_BACKDROP,
    });
  }

  // Three blooms, each two adjacent palette colors, each owned by one robot.
  const blooms = [
    { cx: 420, cy: 400, colors: ["coral", "amber"], who: 1 },
    { cx: 1080, cy: 320, colors: ["sky", "violet"], who: 2 },
    { cx: 800, cy: 720, colors: ["mint", "lemon"], who: 3 },
  ];
  for (const b of blooms) {
    for (let i = 0; i < 62; i++) {
      const ang = r() * Math.PI * 2;
      const rad = Math.abs(r() + r() - 1) * 250; // triangular density — thick middle, soft edge
      const d = 14 + r() * 52;
      push({
        kind: "ellipse",
        x: clamp(round1(b.cx + Math.cos(ang) * rad * 1.25), 20, WORLD_W - 20),
        y: clamp(round1(b.cy + Math.sin(ang) * rad), 20, WORLD_H - 20),
        w: round1(d),
        h: round1(d * (0.7 + r() * 0.6)),
        color: b.colors[Math.floor(r() * b.colors.length)],
        who: b.who,
        layer: LAYER_DRAWING,
      });
    }
  }

  // Triangles on top, scattered.
  for (let i = 0; i < 36; i++) {
    const s = 22 + r() * 60;
    push({
      kind: "tri",
      x: round1(40 + r() * (WORLD_W - 80)),
      y: round1(40 + r() * (WORLD_H - 80)),
      w: round1(s),
      h: round1(s * (0.8 + r() * 0.5)),
      color: PALETTE[Math.floor(r() * PALETTE.length)].key,
      rot: roundRot(r() * Math.PI * 2), // triangles point wherever they like
      who: 1 + (i % 3),
      layer: LAYER_DRAWING,
    });
  }

  return rows;
}

/** The world-space density of a drop: this many specks fit in the opening scene's area before
 *  the scatter box has to grow. Keeping this density in WORLD units is what makes zoom matter:
 *  a far-out viewport can hold the whole box, while a close-up viewport only sees part of it. */
export const CONFETTI_PER_SCENE = 2000;

/** Where a drop of `n` specks scatters, given the rect it was aimed at (the camera's viewport).
 *
 *  The minimum scatter area is `n / CONFETTI_PER_SCENE` opening scenes. If the viewport is
 *  already that large (because the camera is far out), use it verbatim and keep every speck on
 *  screen. If the viewport is smaller (because the camera is close in), enlarge it uniformly
 *  about its centre until it reaches that area. Uniform growth preserves the viewport's aspect
 *  ratio and makes the overflow equally discoverable in every direction.
 *
 *  This deliberately does not scale by a fixed multiple OF the viewport. That inverted the
 *  intended behaviour: a large, zoomed-out viewport got an enormous scatter box while a tiny,
 *  zoomed-in viewport still got a tiny one. */
export function confettiArea(view: Rect, n: number): Rect {
  const width = Math.max(1, view.x1 - view.x0);
  const height = Math.max(1, view.y1 - view.y0);
  const minArea = (WORLD_W * WORLD_H * Math.max(CONFETTI_PER_SCENE, n)) / CONFETTI_PER_SCENE;
  const scale = Math.max(1, Math.sqrt(minArea / (width * height)));
  const cx = (view.x0 + view.x1) / 2;
  const cy = (view.y0 + view.y1) / 2;
  const hw = (width * scale) / 2;
  const hh = (height * scale) / 2;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}

/** A batch of small inert shapes ("+2,000 shapes"). `who = 9`: the robots never touch them, so
 *  piling them on prices the QUERIES over a bigger base, not a busier workload.
 *
 *  `area` is where they land — sized by {@link confettiArea} when the page aims the drop, because
 *  the caller knows the size of the whole JOB and a batch only knows its own share. It can be the
 *  viewport itself or a larger box around it, and every batch in one drop uses the same box. It
 *  defaults to the opening scene's extent so the headless tests stay deterministic. */
export function confetti(
  n: number,
  seed: number,
  firstId: number,
  firstZ: number,
  firstUpdated: number,
  area: Rect = { x0: 0, y0: 0, x1: WORLD_W, y1: WORLD_H },
): ShapeRow[] {
  const r = rng(seed);
  const rows: ShapeRow[] = [];
  for (let i = 0; i < n; i++) {
    const w = round1(3 + r() * 7);
    const h = round1(3 + r() * 7);
    const x = round1(area.x0 + 6 + r() * Math.max(12, area.x1 - area.x0 - 12));
    const y = round1(area.y0 + 6 + r() * Math.max(12, area.y1 - area.y0 - 12));
    rows.push({
      id: firstId + i,
      kind: KINDS[Math.floor(r() * KINDS.length)],
      x,
      y,
      w,
      h,
      rot: 0, // a speck is a couple of pixels: it paints as a square, and an angle would not show
      color: PALETTE[Math.floor(r() * PALETTE.length)].key,
      z: firstZ + i,
      area: round1(w * h),
      updated: firstUpdated + i,
      who: CONFETTI_WHO,
      layer: LAYER_CONFETTI,
      ...cellsOf(x, y),
    });
  }
  return rows;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** One decimal place — enough for a drawing, and it keeps the panels readable. */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Angles get four places, not one: a tenth of a radian is six degrees. Same rounding the write
 *  funnel applies, so a seeded row and a written one are stored to the same precision. */
export function roundRot(v: number): number {
  return Math.round(normAngle(v) * 1e4) / 1e4;
}
