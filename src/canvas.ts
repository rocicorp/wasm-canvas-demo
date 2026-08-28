// The canvas: a renderer over query results, and a pointer-gesture machine that emits muts.
//
// Two disciplines, both load-bearing:
//
//   * The canvas NEVER holds shape state of its own. Every frame it paints whatever rows the
//     subscribed CELL views currently hold, merged by z. The shape follows your hand because the
//     write→fold→read loop completes inside the frame — if that loop were slow, THIS is where
//     you would feel it, which is the demo.
//
//   * Pointer events do not write. They accumulate muts (`drainMuts`), and the page's frame
//     loop commits one coalesced transaction per frame. Sixteen pointermoves between two paints
//     are one edit — what an app would write. A multi-select drag is the same rule with more
//     rows in it: one commit per frame carrying the whole set.
//
// The gestures are tldraw's, which is what most people's hands already know:
//
//   select tool  click a shape selects it · shift-click adds or removes one · drag empty canvas
//                draws a marquee (shift keeps what was selected) · drag any selected shape moves
//                the whole selection · any of the EIGHT handles scales it about the opposite
//                side · the handle above the box rotates it (⇧ snaps to 15°)
//   camera       wheel pans · ctrl/cmd-wheel (and a trackpad pinch) zooms about the cursor ·
//                two fingers on a touchscreen pinch and pan together · space-drag, middle-drag,
//                or the hand tool pans
//
// The one gesture that changed meaning: dragging empty canvas used to pan, and now brushes. Pan
// moved onto space/middle/hand, and the cursor over empty canvas is a plain arrow because of it.
//
// The geometry all of that is written in — oriented frames, the handles, and the two transforms
// — lives in `geom.ts` as pure functions over rows, so what a drag DOES is unit-tested without a
// pointer, and the headless app can reach the same math for ⌘D and ⇧2.

import type { Mut } from "./write.ts";
import type { ResultRow } from "./queries.ts";
import type { ShapeRow } from "./mirror.ts";
import {
  HANDLE_R,
  MIN_SIZE,
  applyResize,
  applyRotate,
  fitView,
  frameOf,
  handleAt,
  handleCursor,
  handleAnchor,
  handlePoints,
  hitShape,
  outlineOf,
  marqueeHits,
  offscreen,
  originsOf,
  rectOf,
  rotPoint,
  toWorld,
  type Frame,
  type HandleId,
  type Origin,
  type Rect,
} from "./geom.ts";
import { CONFETTI_WHO, HEX, WORLD_H, WORLD_W, YOU, type Kind } from "./schema.ts";
import { LEVELS } from "./cell.ts";

/** The camera's zoom range. Zooming OUT consumes the cell-level ladder — one level per halving —
 *  so the floor is exactly what `cell.ts` declares: four levels, 8x out. Zooming IN costs the
 *  engine nothing (level 0 all the way; cells just get bigger on screen and there are fewer of
 *  them), so the ceiling is only a matter of taste. */
export const MIN_ZOOM = 1 / (1 << (LEVELS - 1));
export const MAX_ZOOM = 8;

/** Zoom per pixel of wheel delta — tldraw's ratio (delta/100). */
const ZOOM_PER_PX = 0.01;
/** The most one wheel EVENT may zoom, in the same pixels. A mouse notch arrives as a single
 *  ~100px delta while a trackpad pinch arrives as a stream of small ones; clamping the step is
 *  what makes one notch a crisp ~10% without making the pinch coarse. Un-clamped, `delta/100`
 *  would turn one notch into a 100% jump. */
const MAX_ZOOM_STEP_PX = 10;

/** Wheel deltas come in three units (pixels, lines, pages). Normalise to pixels so a Firefox
 *  line-scroll and a Chrome pixel-scroll feel the same — un-normalised, a line delta of 3 reads
 *  as three PIXELS and the gesture barely moves. */
function wheelPixels(e: WheelEvent, pageHeight: number): { dx: number; dy: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  return { dx: e.deltaX * k, dy: e.deltaY * k };
}

export type Tool = "select" | "hand" | "rect" | "ellipse" | "tri";

export interface CanvasHooks {
  /** Rows to paint and hit-test, in paint order (the subscribed cells, merged by z). */
  rows(): readonly ResultRow[];
  /** The SELECTION query's rows, z ascending. Everything the selection knows about itself — its
   *  bounding box, its handle, what a drag moves — is read from here rather than from `rows`,
   *  because the cell queries shed a row the moment the camera leaves it and a selection must
   *  outlive being panned away from. */
  selectedRows(): readonly ResultRow[];
  /** Membership, for the hit tests. */
  selected(): ReadonlySet<number>;
  /** A fresh row for a create gesture (the writer owns ids and clocks). */
  draft(kind: Kind, x: number, y: number, w: number, h: number, color: string, who: number): ShapeRow;
  /** Replace the selection (immediately — selecting is a subscription and it is timed upstream).
   *  Ids are given in PAINT order; the app clamps long lists from the end. */
  select(ids: number[]): void;
  /** Add one shape to the selection, or take it out — shift-click. */
  toggle(id: number): void;
  /** Open a new undo step. Called at the START of every gesture that can write, so one step is
   *  one gesture rather than one frame — see `history.ts`. */
  mark(tag: string): void;
}

type Gesture =
  | { t: "none" }
  | { t: "move"; ax: number; ay: number; origins: Origin[] }
  /** Scaling: the frame the gesture began with, and which of its handles is being pulled. The
   *  opposite side is the anchor, and the frame is the SHAPE's own (rotation included) whenever
   *  exactly one is selected. */
  | { t: "resize"; h: HandleId; frame: Frame; ox: number; oy: number; origins: Origin[] }
  /** Rotating about the frame's centre. `a0` is where the pointer started, in angle. */
  | { t: "rotate"; frame: Frame; a0: number; origins: Origin[] }
  | { t: "create"; id: number; ax: number; ay: number; moved: boolean }
  /** The marquee (tldraw calls it the brush; `brush` here is already the paint colour). Dragging
   *  empty canvas draws it, and the selection follows it live. */
  | { t: "marquee"; ax: number; ay: number; bx: number; by: number; base: number[] }
  /** Panning moves the CAMERA, which is the one gesture that writes nothing at all — it re-aims
   *  the subscription set instead. On the select tool it is no longer what dragging empty canvas
   *  does: it is the hand tool, a held space bar, or the middle button, exactly as in tldraw. */
  | { t: "pan"; sx: number; sy: number }
  /** Two fingers on a touchscreen: zoom by their separation, pan by their midpoint, both at
   *  once. Also camera-only — a pinch writes nothing. */
  | { t: "pinch"; dist: number; mx: number; my: number };

export class CanvasView {
  tool: Tool = "select";
  brush = "sky";

  private readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hooks: CanvasHooks;
  /** Backing-store pixels per CSS pixel. The camera itself deliberately stays in CSS pixels:
   *  zoom levels, hit targets and selection chrome are visual sizes, and must not become three
   *  times smaller just because a phone has a 3x screen. */
  private dpr = 1;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private placed = false;
  private gesture: Gesture = { t: "none" };
  private pending: Mut[] = [];

  /** The confetti layer: one `Path2D` per colour, in WORLD coordinates. Confetti rows
   *  (`who = 9`) never change — grabbing one PROMOTES it to a live row first — so the pile is
   *  traced once and then painted per frame as one fill per colour. This keeps the per-frame
   *  paint cost proportional to the shapes that can actually move, so what you feel as the base
   *  grows is the engine's bill, never a rendering artifact.
   *
   *  Traced once, and then KEPT: specks that arrive are appended to the paths already built
   *  rather than re-tracing the pile around them (see {@link staticPlan}). A drop lands
   *  `CONFETTI_BATCH` rows a frame, so a cache that turned over on every membership change would
   *  charge the whole pile per frame for a delta of two thousand — the O(base) bill for an
   *  O(delta) change that the engine underneath spends its whole design refusing to pay. A
   *  renderer that re-derives everything on every write is the same mistake as a view that does.
   *
   *  WORLD coordinates are the load-bearing part. An offscreen bitmap bakes the camera in, so it
   *  has to be redrawn the moment you pan — 64k re-traced paths in the frame you are dragging,
   *  which is precisely the frame that cannot afford them. A path in world space is
   *  camera-independent: the context transform moves it, and a pan costs seven `fill` calls of
   *  paths that were already built.
   *
   *  Two approximations live here — the layer paints under all live rows, and within it the
   *  specks composite in COLOUR order rather than z order — and both are bounded the same way:
   *  ONLY shapes under ~4 screen pixels are ever in the layer. At that size a speck has no
   *  observable stacking order, so neither approximation can show; anything big enough to show
   *  one is drawn per frame in its true place in the merge instead. The live query result is
   *  exact either way. */
  private readonly staticPaths: Array<{ color: string; path: Path2D }> = [];
  /** The same paths by colour — what an append looks one up in. `staticPaths` is the paint
   *  order (insertion order, and arbitrary: see the note on colour order above). */
  private readonly staticByColor = new Map<string, Path2D>();
  private staticCount = -1;
  private staticIdSum = -1;
  /** The largest confetti id in the layer. Ids only ever go up — `Writer.draft` and `confetti`
   *  both take theirs from one high-water mark — so "id above this" IS "never traced", and that
   *  is the whole test for what may be appended. */
  private staticMaxId = 0;
  /** This frame's arrivals, refilled by the partition and consumed by an append. Reused rather
   *  than allocated: it is touched on every frame and holds nothing on almost all of them. */
  private readonly arrivals: ShapeRow[] = [];
  /** What the layer has cost since boot — traces, how they were reached, and how many specks it
   *  holds for them. Nothing on the page reads it; `test/browser-smoke.mjs` asserts on it,
   *  because "a drop appends instead of re-tracing" is a claim about work done, and the only
   *  honest way to check a cache is to count what it built. */
  readonly staticWork = { traced: 0, rebuilds: 0, appends: 0, held: 0 };
  /** The level-of-detail bucket the paths were traced at. `trace` swaps an arc for a square
   *  below ~4 screen pixels, which is the ONE thing in a path that depends on the camera, so the
   *  cache turns over on a half-octave of zoom — and on nothing else. */
  private staticLod = NaN;
  private readonly liveRows: ShapeRow[] = [];
  /** Is the space bar down? While it is, every tool is the hand tool. */
  private space = false;
  /** Every finger currently on the glass, in client coordinates. Only touches are tracked: a
   *  mouse has one pointer and a pen behaves like one, and the map exists solely so the SECOND
   *  finger can turn the gesture into a pinch. */
  private readonly touches = new Map<number, { x: number; y: number }>();

  constructor(el: HTMLCanvasElement, hooks: CanvasHooks) {
    this.el = el;
    this.hooks = hooks;
    this.ctx = el.getContext("2d")!;
    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.up(e));
    el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    // Space-to-pan, tldraw's shortcut. The listener is on the WINDOW because the canvas is not
    // focusable — and it stands down inside a custom pane's textarea, where a space is a space.
    window.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault(); // a bare space would scroll the page
      if (this.space) return;
      this.space = true;
      if (this.gesture.t === "none") this.el.style.cursor = "grab";
    });
    window.addEventListener("keyup", (e) => {
      if (e.code !== "Space") return;
      this.space = false;
      if (this.gesture.t === "none") this.el.style.cursor = "default";
    });
    new ResizeObserver(() => this.fit()).observe(el);
    // Moving a window between screens can change DPR without changing the canvas's CSS box.
    window.addEventListener("resize", () => this.fit());
    this.fit();
  }

  /** Muts accumulated since the last drain (the frame loop commits them as one transaction). */
  drainMuts(): Mut[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Every id a gesture is currently writing to — the robots leave these alone rather than fight
   *  your hand. A multi-select drag writes to all of them, so this is a set, not an id. */
  get dragging(): ReadonlySet<number> | null {
    const g = this.gesture;
    if (g.t === "move" || g.t === "resize" || g.t === "rotate") return new Set(g.origins.map((o) => o.id));
    if (g.t === "create") return new Set([g.id]);
    return null;
  }

  // -- painting ---------------------------------------------------------------------------------

  render(): void {
    const { ctx } = this;
    const w = this.el.width;
    const h = this.el.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(
      this.scale * this.dpr,
      0,
      0,
      this.scale * this.dpr,
      this.ox * this.dpr,
      this.oy * this.dpr,
    );

    // Dot grid — quiet, and on an unbounded canvas it is the only thing that says you moved.
    // The spacing doubles as you zoom out so the dots stay about the same distance apart on
    // screen instead of turning into a grey wash.
    const view = this.viewport();
    let step = 80;
    while (step * this.scale < 40) step *= 2;
    ctx.fillStyle = "rgba(148, 163, 200, 0.10)";
    for (let gx = Math.floor(view.x0 / step) * step; gx <= view.x1; gx += step) {
      for (let gy = Math.floor(view.y0 / step) * step; gy <= view.y1; gy += step) {
        ctx.fillRect(gx - 1, gy - 1, 2, 2);
      }
    }
    const rows = this.hooks.rows() as unknown as readonly ShapeRow[];
    const px = 1 / this.scale; // one screen pixel, in world units

    // The scale the cached paths are traced at, quantised to a half-octave so an ordinary zoom
    // nudge does not turn the cache over. The PARTITION below must use this same quantised scale
    // and not the live one, or a shape sitting on the threshold lands in both halves on the
    // frames between rebuilds and paints twice.
    const lod = Math.round(Math.log2(this.scale) * 2);
    const lodPx = 1 / 2 ** (lod / 2);

    // Partition: sub-pixel confetti to the cached layer, everything else to the per-frame pass.
    // The layer's fingerprint (count + id sum) moves on any add, remove, or promote — and the
    // ARRIVALS half of it says how much of that move was rows the layer has never held, which is
    // what lets a drop append instead of re-trace (`staticPlan`).
    //
    // Only the sub-pixel ones. A speck under ~4 screen pixels has no observable stacking order,
    // which is what buys the right to paint the layer in colour order and under the live rows; a
    // confetto you can actually SEE has to obey z like anything else, so it joins the per-frame
    // pass and is drawn in its place in the merge. Zoom out and the whole pile crosses back into
    // the layer, which is the case the layer exists for.
    this.liveRows.length = 0;
    this.arrivals.length = 0;
    let confettiCount = 0;
    let confettiIdSum = 0;
    let arrivedCount = 0;
    let arrivedIdSum = 0;
    let maxId = 0;
    for (const s of rows) {
      if (s.who === CONFETTI_WHO && s.w / lodPx < 4) {
        confettiCount++;
        confettiIdSum += s.id;
        if (s.id > maxId) maxId = s.id;
        // Above the layer's high-water id, so it cannot already be in a path. On an ordinary
        // frame nothing is, and this whole branch is one integer compare per speck.
        if (s.id > this.staticMaxId) {
          arrivedCount++;
          arrivedIdSum += s.id;
          this.arrivals.push(s);
        }
        continue;
      }
      // Cull to the viewport. A cell is a query unit, not a screen: at a fine level the ring plus
      // the cooling set hold far more rows than are actually on screen, and every one of them
      // would otherwise be a recorded draw call for the rasteriser to throw away. The cached
      // layer is deliberately NOT culled — it is camera-independent, which is the whole point.
      if (offscreen(s, view)) continue;
      this.liveRows.push(s);
    }
    const plan = staticPlan(
      { count: this.staticCount, idSum: this.staticIdSum, lod: this.staticLod },
      { count: confettiCount, idSum: confettiIdSum, lod, arrivedCount, arrivedIdSum },
    );
    if (plan !== "keep") {
      if (plan === "append") {
        this.staticWork.appends++;
        for (const s of this.arrivals) traceShape(this.staticPath(s.color), s, lodPx);
        this.staticWork.traced += this.arrivals.length;
      } else {
        this.rebuildStatic(rows, lodPx);
      }
      this.staticCount = confettiCount;
      this.staticIdSum = confettiIdSum;
      this.staticLod = lod;
      this.staticMaxId = maxId;
      this.staticWork.held = confettiCount;
    }

    ctx.globalAlpha = 0.92;
    for (const { color, path } of this.staticPaths) {
      ctx.fillStyle = HEX.get(color) ?? "#888";
      ctx.fill(path);
    }
    for (const s of this.liveRows) {
      ctx.fillStyle = HEX.get(s.color) ?? "#888";
      this.tracePath(s, px);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.paintSelection(view, px);
    this.paintMarquee(px);
  }

  /** The selection: a hairline per shape, one dashed box around the set, eight scale handles and
   *  a rotate handle above the top edge.
   *
   *  Drawn from the SELECTION query's rows rather than the painted ones, so a shape you selected
   *  and then panned away from keeps its box and stays draggable — the cell views dropped it, and
   *  this query did not.
   *
   *  The box is the FRAME (`geom.ts`): the shape's own rotated box when exactly one is selected,
   *  the axis-aligned union when several. Drawing what the gesture measures against is not a
   *  detail — a box that did not turn with its shape would put the handles somewhere other than
   *  where they can be grabbed. */
  private paintSelection(view: Rect, px: number): void {
    const rows = this.hooks.selectedRows() as unknown as readonly ShapeRow[];
    const f = frameOf(rows);
    if (!f) return;
    const { ctx } = this;

    // One selected shape needs no hairline: its own box is four pixels away and says the same
    // thing twice. A SET needs them, because the box alone cannot say which shapes are in it.
    if (rows.length > 1) {
      ctx.strokeStyle = "rgba(89, 165, 255, 0.9)";
      ctx.lineWidth = px;
      for (const s of rows) {
        if (offscreen(s, view)) continue;
        this.strokeFrame({ cx: s.x, cy: s.y, w: s.w, h: s.h, rot: s.rot }, s.w / 2, s.h / 2);
      }
    }

    const { ex, ey } = outlineOf(f, px);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    this.strokeFrame(f, ex, ey);
    ctx.setLineDash([]);

    // The rotate handle floats off the top edge; a stem joins it to the box so it reads as
    // attached to the thing it turns rather than as a stray dot.
    const handles = handlePoints(f, px);
    const rot = handles.find((h) => h.id === "rotate");
    if (rot) {
      const top = toWorld(f, { x: 0, y: -ey });
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = px;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(rot.x, rot.y);
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(20, 26, 40, 0.85)";
    ctx.lineWidth = px;
    for (const h of handles) {
      if (h.id === "rotate") {
        ctx.beginPath();
        ctx.arc(h.x, h.y, HANDLE_R * px, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        continue;
      }
      ctx.fillRect(h.x - HANDLE_R * px, h.y - HANDLE_R * px, HANDLE_R * 2 * px, HANDLE_R * 2 * px);
      ctx.strokeRect(h.x - HANDLE_R * px, h.y - HANDLE_R * px, HANDLE_R * 2 * px, HANDLE_R * 2 * px);
    }
  }

  /** Stroke an oriented box with the given half-extents. Four `lineTo`s rather than a
   *  `strokeRect` under a context rotation: the transform is already the camera's, and pushing a
   *  second one per selected shape would re-set it thousands of times on a big selection. */
  private strokeFrame(f: Frame, ex: number, ey: number): void {
    const { ctx } = this;
    const pts = [
      { x: -ex, y: -ey },
      { x: ex, y: -ey },
      { x: ex, y: ey },
      { x: -ex, y: ey },
    ].map((p) => toWorld(f, p));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
  }

  /** The marquee, while it is being dragged. */
  private paintMarquee(px: number): void {
    const g = this.gesture;
    if (g.t !== "marquee") return;
    const r = rectOf(g.ax, g.ay, g.bx, g.by);
    const { ctx } = this;
    ctx.fillStyle = "rgba(89, 165, 255, 0.12)";
    ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.strokeStyle = "rgba(89, 165, 255, 0.9)";
    ctx.lineWidth = px;
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.setLineDash([]);
  }

  /** The layer's path for one colour, opened the first time that colour turns up.
   *
   *  One path per COLOUR rather than one per shape is the other half of the win: 64k
   *  `fillStyle`-then-`fill` pairs are 64k draw calls to record every frame, and seven are
   *  seven. The palette is small and fixed (`schema.ts`), so the grouping is bounded by it. */
  private staticPath(color: string): Path2D {
    let path = this.staticByColor.get(color);
    if (!path) {
      this.staticByColor.set(color, (path = new Path2D()));
      this.staticPaths.push({ color, path });
    }
    return path;
  }

  /** Trace the confetti layer from scratch: every speck in the pile, into a path per colour.
   *
   *  The fallback, not the common case. Arrivals append (`staticPlan`); this runs when a speck
   *  LEFT the layer — promoted by your hand, deleted, hidden with its layer, or carried out of
   *  the subscribed cells by a pan — or when the zoom crosses the half-octave the paths were
   *  traced at. A Path2D has no way to drop a subpath, so losing one speck costs the pile. */
  private rebuildStatic(rows: readonly ShapeRow[], px: number): void {
    this.staticByColor.clear();
    this.staticPaths.length = 0;
    this.staticWork.rebuilds++;
    for (const s of rows) {
      if (s.who !== CONFETTI_WHO || s.w / px >= 4) continue; // the same split as the partition
      traceShape(this.staticPath(s.color), s, px);
      this.staticWork.traced++;
    }
  }

  private tracePath(s: ShapeRow, px: number): void {
    this.ctx.beginPath();
    traceShape(this.ctx, s, px);
  }

  // -- pointer machine --------------------------------------------------------------------------

  /** Is a drag the CAMERA's rather than the drawing's? tldraw's three ways to say so: the hand
   *  tool, a held space bar, the middle button. Dragging empty canvas is no longer one of them —
   *  on the select tool that gesture is the marquee. */
  private panMode(e?: PointerEvent): boolean {
    return this.tool === "hand" || this.space || e?.button === 1;
  }

  private down(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // A second finger turns whatever was happening into a pinch. Whatever the first finger had
      // already written stays written — it was a real gesture up to this frame — but from here
      // the two fingers are the camera's.
      if (this.touches.size === 2) {
        this.gesture = this.pinchFrom();
        return;
      }
    }
    const p = this.toWorld(e);
    const px = 1 / this.scale;

    if (this.panMode(e)) {
      this.gesture = { t: "pan", sx: e.clientX, sy: e.clientY };
      this.el.style.cursor = "grabbing";
      return;
    }

    // (`hand` never reaches here — `panMode` claimed it above.)
    if (this.tool !== "select" && this.tool !== "hand") {
      this.hooks.mark("draw");
      const row = this.hooks.draft(this.tool, p.x, p.y, MIN_SIZE, MIN_SIZE, this.brush, YOU);
      this.pending.push({ op: "add", row });
      this.gesture = { t: "create", id: row.id, ax: p.x, ay: p.y, moved: false };
      this.hooks.select([row.id]);
      return;
    }

    const rows = this.hooks.rows() as unknown as readonly ShapeRow[];

    // The selection's own handles first — they sit above everything, including the shapes they
    // surround.
    const selected = this.hooks.selectedRows() as unknown as readonly ShapeRow[];
    const f = frameOf(selected);
    const handle = f && handleAt(f, p, px);
    if (f && handle) {
      const origins = originsOf(selected);
      this.promote(selected); // a handle reshapes them, so the same rule as a drag applies
      if (handle === "rotate") {
        this.hooks.mark("rotate");
        this.gesture = { t: "rotate", frame: f, a0: Math.atan2(p.y - f.cy, p.x - f.cx), origins };
      } else {
        this.hooks.mark("resize");
        // A zero-area frame (one hairline-thin shape) would divide the scale factor by nothing.
        const frame = { ...f, w: Math.max(f.w, MIN_SIZE), h: Math.max(f.h, MIN_SIZE) };
        // The handle is DRAWN a few pixels outside the corner it pulls (and further out still on
        // a tiny shape). Carry the difference for the length of the gesture, so the corner
        // tracks the pointer exactly instead of jumping to it on the first move.
        const a = handleAnchor(frame, handle);
        this.gesture = { t: "resize", h: handle, frame, ox: a.x - p.x, oy: a.y - p.y, origins };
      }
      return;
    }

    // Then a shape. Shift toggles it in or out of the selection; a plain click on something
    // OUTSIDE the selection replaces the selection with it, and a click on something already in
    // the selection keeps the whole set — which is what makes a drag move all of them.
    const hit = this.hitTest(p, rows, px);
    if (hit) {
      // The mark comes BEFORE the selection changes, so undoing the drag puts back the selection
      // you had when you reached for the shape.
      this.hooks.mark("drag");
      if (e.shiftKey) {
        this.hooks.toggle(hit.id);
        // Shift-adding a shape starts dragging the set; shift-REMOVING one has nothing to drag.
        if (this.hooks.selected().has(hit.id)) this.beginMove(p);
        return;
      }
      if (!this.hooks.selected().has(hit.id)) this.hooks.select([hit.id]);
      this.beginMove(p);
      return;
    }
    this.hooks.mark("select"); // a marquee writes no shape rows; the empty step is dropped

    // Nothing under the pointer: the marquee. Shift keeps what is already selected and adds to
    // it; without shift the selection clears the moment the drag starts, the way a click on
    // nothing does.
    const base = e.shiftKey ? [...this.hooks.selected()] : [];
    if (!e.shiftKey) this.hooks.select([]);
    this.gesture = { t: "marquee", ax: p.x, ay: p.y, bx: p.x, by: p.y, base };
  }

  /** Start moving the whole selection: raise every shape in it, promote any confetti, and
   *  snapshot where they all began. */
  private beginMove(p: { x: number; y: number }): void {
    const rows = this.hooks.selectedRows() as unknown as readonly ShapeRow[];
    for (const s of rows) this.pending.push({ op: "raise", id: s.id });
    this.promote(rows);
    this.gesture = { t: "move", ax: p.x, ay: p.y, origins: originsOf(rows) };
  }

  /** Promote any confetti in `rows` to live rows — a speck your hand is about to EDIT leaves the
   *  cached layer and is yours from then on. Every pixel stays grabbable without the layer ever
   *  going stale.
   *
   *  EVERY writer that changes anything the traced path encodes owes this, not just a drag. The
   *  paths carry position, size, rotation and kind in their vertices, and COLOUR in which path a
   *  speck was traced into (`staticByColor`) — so the rule covers x, y, w, h, rot, kind and
   *  color, and a recolour owes it exactly as a move does (`main.ts`, the palette). What the
   *  layer is keyed on is which specks it holds and nothing else (`staticPlan`), so a speck
   *  edited while still inside it goes on being painted the way it used to look: right in the
   *  query, wrong on the glass, and the live query would say nothing. */
  private promote(rows: readonly ShapeRow[]): void {
    for (const s of rows) {
      if (s.who === CONFETTI_WHO) this.pending.push({ op: "set", id: s.id, patch: { who: YOU } });
    }
  }

  /** Wheel pans; ctrl/⌘-wheel (and a trackpad pinch, which arrives as ctrl-wheel) zooms about
   *  the cursor. Zoom is clamped to the cell ladder's range — see `MIN_ZOOM`.
   *
   *  The step is exponential in the delta, so zooming in and back out by the same gesture lands
   *  exactly where it started; `exp(±0.1)` is within a fraction of a percent of tldraw's
   *  linear `z ± 0.1z`, so it reads as the same gesture. */
  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const box = this.el.getBoundingClientRect();
    const { dx, dy } = wheelPixels(e, box.height);
    if (e.ctrlKey || e.metaKey) {
      const step = clamp(dy, -MAX_ZOOM_STEP_PX, MAX_ZOOM_STEP_PX);
      this.zoomAt(Math.exp(-step * ZOOM_PER_PX), e.clientX, e.clientY);
    } else {
      this.panBy(-dx, -dy);
    }
  }

  private move(e: PointerEvent): void {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const p = this.toWorld(e);
    const g = this.gesture;
    switch (g.t) {
      case "pinch": {
        // Zoom by how far the fingers moved apart, about the point between them, and pan by how
        // far that point itself travelled — the two halves of the gesture, applied in that order
        // so the zoom's anchor is the midpoint you are actually holding.
        const now = this.pinchFrom();
        if (now.dist <= 0 || g.dist <= 0) return;
        this.zoomAt(now.dist / g.dist, g.mx, g.my);
        this.panBy(now.mx - g.mx, now.my - g.my);
        this.gesture = now;
        return;
      }
      case "none":
        this.hover(p);
        return;
      case "pan": {
        this.panBy(e.clientX - g.sx, e.clientY - g.sy);
        this.gesture = { t: "pan", sx: e.clientX, sy: e.clientY };
        return;
      }
      case "move": {
        // No clamp: the canvas has no edges to hold a shape inside any more. Every shape moves by
        // the pointer's delta from where IT started, so the set keeps its own shape exactly.
        const dx = p.x - g.ax;
        const dy = p.y - g.ay;
        for (const o of g.origins) {
          this.pending.push({ op: "set", id: o.id, patch: { x: o.x + dx, y: o.y + dy } });
        }
        return;
      }
      case "resize": {
        // The opposite side is the anchor — tldraw's rule for every handle — and the whole
        // transform is the map from the frame's old box to its new one (`applyResize`). One
        // shape scales about its own corner, in its OWN rotated frame; a set scales about the
        // set's, and the arrangement inside it is preserved because every shape takes the same
        // factors. The floor is on the FRAME, not on each shape — flooring each one would blow a
        // confetti speck up to 8 units the moment you touched a handle.
        for (const r of applyResize(g.frame, g.h, { x: p.x + g.ox, y: p.y + g.oy }, g.origins)) {
          this.pending.push({ op: "set", id: r.id, patch: { x: r.x, y: r.y, w: r.w, h: r.h } });
        }
        return;
      }
      case "rotate": {
        // The angle the pointer has swept about the frame's centre. ⇧ snaps the FRAME's angle to
        // 15°, so a set turns as one thing and the shapes inside it keep their arrangement.
        const delta = Math.atan2(p.y - g.frame.cy, p.x - g.frame.cx) - g.a0;
        for (const r of applyRotate(g.frame, g.origins, delta, e.shiftKey)) {
          this.pending.push({ op: "set", id: r.id, patch: { x: r.x, y: r.y, rot: r.rot } });
        }
        return;
      }
      case "marquee": {
        g.bx = p.x;
        g.by = p.y;
        // The selection follows the box as it grows, which means re-subscribing the `IN` query
        // whenever the covered set changes — `select` upstream no-ops when it has not, and the
        // card's hydrate time is then exactly what a marquee of this size costs to subscribe.
        const hits = marqueeHits(this.hooks.rows() as unknown as readonly ShapeRow[], rectOf(g.ax, g.ay, g.bx, g.by));
        this.hooks.select(g.base.length > 0 ? [...g.base, ...hits] : hits);
        return;
      }
      case "create": {
        g.moved = true;
        const w = Math.max(MIN_SIZE, Math.abs(p.x - g.ax));
        const h = Math.max(MIN_SIZE, Math.abs(p.y - g.ay));
        this.pending.push({
          op: "set",
          id: g.id,
          patch: { x: (p.x + g.ax) / 2, y: (p.y + g.ay) / 2, w, h },
        });
        return;
      }
    }
  }

  private up(e: PointerEvent): void {
    this.touches.delete(e.pointerId);
    const g = this.gesture;
    if (g.t === "create" && !g.moved) {
      // A click (no drag) plants a default-size shape.
      this.pending.push({ op: "set", id: g.id, patch: { w: 60, h: 60 } });
    }
    // Lifting one of two fingers leaves a pinch that cannot measure itself; the other finger
    // does NOT inherit the gesture, because a stray drag out of a pinch is how a drawing gets a
    // shape it did not ask for.
    this.gesture = this.touches.size === 2 ? this.pinchFrom() : { t: "none" };
    if (this.gesture.t === "none") this.hover(this.toWorld(e));
  }

  /** The pinch's current measurement: the two fingers' separation and their midpoint, in client
   *  coordinates. */
  private pinchFrom(): { t: "pinch"; dist: number; mx: number; my: number } {
    const [a, b] = [...this.touches.values()];
    return {
      t: "pinch",
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }

  private hover(p: { x: number; y: number }): void {
    const px = 1 / this.scale;
    if (this.panMode()) {
      this.el.style.cursor = "grab";
      return;
    }
    if (this.tool !== "select") {
      this.el.style.cursor = "crosshair";
      return;
    }
    const rows = this.hooks.rows() as unknown as readonly ShapeRow[];
    const f = frameOf(this.hooks.selectedRows() as unknown as readonly ShapeRow[]);
    // Same order as `down`: the handles sit above everything, so they claim the cursor first —
    // and a rotated frame rotates its cursors with it, because the diagonal a corner pulls along
    // is the frame's diagonal, not the screen's. Empty canvas keeps the plain arrow, because
    // dragging it now draws a marquee rather than moving the camera — the cursor has to stop
    // promising a pan it will not do.
    const h = f && handleAt(f, p, px);
    this.el.style.cursor =
      f && h ? handleCursor(h, f.rot) : this.hitTest(p, rows, px) ? "move" : "default";
  }

  private hitTest(p: { x: number; y: number }, rows: readonly ShapeRow[], px: number): ShapeRow | null {
    // Topmost first: paint order is z ascending, so walk it backwards.
    for (let i = rows.length - 1; i >= 0; i--) {
      if (hitShape(p, rows[i], px)) return rows[i];
    }
    return null;
  }

  // -- coordinates ------------------------------------------------------------------------------

  /** Resize the backing store. The camera SURVIVES a resize — on an unbounded canvas there is
   *  nothing to re-fit to — except the very first call, which places it over the opening scene. */
  private fit(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cw = this.el.clientWidth;
    const ch = this.el.clientHeight;
    if (cw === 0 || ch === 0) return;
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    this.dpr = dpr;
    // Setting width or height clears the bitmap and resets context state. Only do it when the
    // backing store actually changed; ResizeObserver is allowed to report the same box again.
    if (this.el.width !== bw) this.el.width = bw;
    if (this.el.height !== bh) this.el.height = bh;
    if (!this.placed) {
      this.placed = true;
      this.scale = Math.min(cw / WORLD_W, ch / WORLD_H);
      this.ox = (cw - WORLD_W * this.scale) / 2;
      this.oy = (ch - WORLD_H * this.scale) / 2;
    }
  }

  // -- the camera -------------------------------------------------------------------------------

  /** Screen pixels per world unit. `1` is 100%. */
  get zoom(): number {
    return this.scale;
  }

  /** The world rectangle currently on screen — what the app subscribes cells for. */
  viewport(): Rect {
    return {
      x0: -this.ox / this.scale,
      y0: -this.oy / this.scale,
      x1: (this.el.clientWidth - this.ox) / this.scale,
      y1: (this.el.clientHeight - this.oy) / this.scale,
    };
  }

  /** Slide the camera by a screen-space delta. */
  panBy(dxScreen: number, dyScreen: number): void {
    this.ox += dxScreen;
    this.oy += dyScreen;
  }

  /** Put a world rectangle on screen with room to breathe — ⇧1 (everything the drawing holds)
   *  and ⇧2 (the selection). The arithmetic is `fitView` in `geom.ts`, so the camera the page
   *  lands on is unit-tested; this only installs it. */
  zoomToRect(r: Rect): void {
    const fit = fitView(r, this.el.clientWidth, this.el.clientHeight, 48, MIN_ZOOM, MAX_ZOOM);
    this.scale = fit.scale;
    this.ox = fit.ox;
    this.oy = fit.oy;
  }

  /** Zoom about a point in CLIENT coordinates, keeping that point pinned under the cursor. */
  zoomAt(factor: number, clientX: number, clientY: number): void {
    const box = this.el.getBoundingClientRect();
    const sx = clientX - box.left;
    const sy = clientY - box.top;
    const next = clamp(this.scale * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === this.scale) return;
    // Keep the world point under the cursor fixed: solve for the offset that does it.
    this.ox = sx - ((sx - this.ox) / this.scale) * next;
    this.oy = sy - ((sy - this.oy) / this.scale) * next;
    this.scale = next;
  }

  private toWorld(e: PointerEvent): { x: number; y: number } {
    const box = this.el.getBoundingClientRect();
    return {
      x: (e.clientX - box.left - this.ox) / this.scale,
      y: (e.clientY - box.top - this.oy) / this.scale,
    };
  }
}

/** The primitives a shape's outline is built from. A `Path2D` and a 2D context both provide
 *  them, which is what lets the pile's cached paths and a live row's per-frame path be traced by
 *  the same code — the layer cannot drift from what a moving shape looks like. */
export interface PathSink {
  rect(x: number, y: number, w: number, h: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

/** Append one shape's outline to `sink`, as ONE self-contained subpath.
 *
 *  Self-contained is the load-bearing word, and the reason this is a named function with a test
 *  of its own. Every branch must OPEN its subpath: `rect` implies one, the others say `moveTo`
 *  first. `ellipse` is the trap — it draws a straight line from the current point to where the
 *  arc starts, so an ellipse appended to a path that already holds a shape spikes back to it and
 *  the fill washes over everything between. A per-shape `ctx.beginPath()` hid that for years
 *  (there was never a current point); the cached per-colour paths hold thousands of shapes and
 *  there always is one. The `moveTo` below lands exactly on the arc's start, so the line it
 *  implies has zero length.
 *
 *  Rotation is baked into the COORDINATES rather than applied as a context transform, for the
 *  same reason the cached layer is in world space: a `Path2D` holding thousands of shapes has no
 *  per-shape transform to push, and a rotation set on the context would turn the whole pile.
 *
 *  A context sink owns its own `beginPath` — see `tracePath`. */
/** The confetti layer's fingerprint: how many specks it holds, their id sum, and the LOD its
 *  paths were traced at. */
export interface StaticKey {
  count: number;
  idSum: number;
  lod: number;
}

/** …and the same for the rows on screen now, with the part of the move that is arrivals — specks
 *  whose ids are above every id the layer has ever held, so they cannot already be in a path. */
export interface StaticNow extends StaticKey {
  arrivedCount: number;
  arrivedIdSum: number;
}

/** What the confetti layer has to do this frame. Pure, and exported, because it is the whole of
 *  the cache's correctness — and the only part of it a Node test can reach, `Path2D` being a
 *  browser type.
 *
 *  `"append"` is the case worth the machinery: a drop lands `CONFETTI_BATCH` rows a frame, and
 *  re-tracing the pile around each batch would charge O(base) per frame for an O(delta) change —
 *  a growing bill for a constant-size write, which is the exact shape of work the engine below
 *  refuses to do and the renderer above should not reintroduce.
 *
 *  It is sound because ids only go up (`Writer.draft` and `confetti` mint from one high-water
 *  mark), so an id above the layer's high water has never been traced; and because the rest of
 *  the pile has to be untouched for arrivals to be the whole change — same count and same id sum
 *  on the NON-arriving half, which is the fingerprint this cache has always been invalidated by,
 *  applied to the half that was already traced. */
export function staticPlan(was: StaticKey, now: StaticNow): "keep" | "append" | "rebuild" {
  // The paths are traced AT a LOD — under ~4 screen pixels a speck is a square, not its own
  // kind — so crossing one is a different pile, not a bigger one.
  if (now.lod !== was.lod) return "rebuild";
  if (now.count === was.count && now.idSum === was.idSum) return "keep";
  if (now.count - now.arrivedCount === was.count && now.idSum - now.arrivedIdSum === was.idSum) return "append";
  return "rebuild";
}

export function traceShape(sink: PathSink, s: ShapeRow, px: number): void {
  const w = s.w;
  const h = s.h;
  const rot = s.rot ?? 0;
  // Anything under ~4 screen pixels paints as an axis-aligned square — an arc that small is
  // invisible and three times the cost, its rotation is unobservable at a couple of pixels, and
  // the confetti pile is thousands of them.
  if (w / px < 4) {
    sink.rect(s.x - w / 2, s.y - h / 2, w, h);
    return;
  }
  const at = (lx: number, ly: number) => {
    const r = rotPoint(lx, ly, rot);
    return { x: s.x + r.x, y: s.y + r.y };
  };
  if (s.kind === "rect") {
    if (rot === 0) {
      sink.rect(s.x - w / 2, s.y - h / 2, w, h);
      return;
    }
    const c = [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
    sink.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) sink.lineTo(c[i].x, c[i].y);
    sink.closePath();
  } else if (s.kind === "ellipse") {
    const start = at(w / 2, 0); // angle 0 in the shape's OWN frame — where the arc starts
    sink.moveTo(start.x, start.y); // …so the line this implies has zero length
    sink.ellipse(s.x, s.y, w / 2, h / 2, rot, 0, Math.PI * 2);
  } else {
    const c = [at(0, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
    sink.moveTo(c[0].x, c[0].y);
    sink.lineTo(c[1].x, c[1].y);
    sink.lineTo(c[2].x, c[2].y);
    sink.closePath();
  }
}

/** Is the event aimed at something the visitor is typing in? A custom pane's textarea owns its
 *  own keys — a space there is a space, not the camera. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
