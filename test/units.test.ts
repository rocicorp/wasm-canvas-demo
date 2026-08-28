// Pure-logic units: the scene generator, geometry, writer's per-frame coalescing, and history.
// No wasm here — the browser smoke test covers the engine-facing page.

import assert from "node:assert/strict";
import { test } from "node:test";

import { staticPlan, traceShape, type PathSink } from "../src/canvas.ts";
import {
  aabbOf,
  applyResize,
  applyRotate,
  boundsOf,
  fitView,
  frameOf,
  handleAnchor,
  handleAt,
  handleCursor,
  handlePoints,
  hitShape,
  marqueeHits,
  originsOf,
  rectOf,
  type Frame,
} from "../src/geom.ts";
import { History } from "../src/history.ts";
import {
  Bots,
  ROAM,
  botOwnerFor,
  isBotOwner,
  livingConfettiTarget,
} from "../src/bots.ts";
import { CELL0, LEVELS, cellAt, cellCol, cellSize, cellsForView, cellsOf, levelForZoom } from "../src/cell.ts";
import { Mirror, type ShapeRow } from "../src/mirror.ts";
import { CONFETTI_PER_SCENE, confetti, confettiArea, initialScene } from "../src/scene.ts";
import { CONFETTI_WHO, LAYERS, LAYER_CONFETTI, PALETTE, WORLD_H, WORLD_W } from "../src/schema.ts";
import { Writer, type Mut } from "../src/write.ts";
import type { DrawStore } from "../src/engine.ts";

// ---------------------------------------------------------------------------------------------
// Selection geometry — the marquee, the box it selects with, and the box it draws around what it
// caught. Pure functions, so the multi-select gestures are checkable without a pointer.
// ---------------------------------------------------------------------------------------------

/** A shape at a centre with a size — only the geometry columns matter here. */
const at = (id: number, x: number, y: number, w = 10, h = 10, rot = 0): ShapeRow =>
  ({ id, x, y, w, h, rot, kind: "rect", color: "sky", z: id, area: w * h, updated: id, who: 0, layer: 2 }) as ShapeRow;

test("a marquee is drawn in any direction and catches what it touches", () => {
  // Dragged up-left, the corners arrive reversed; the rectangle must not be empty.
  assert.deepEqual(rectOf(100, 80, 20, 10), { x0: 20, y0: 10, x1: 100, y1: 80 });
  assert.deepEqual(rectOf(20, 10, 100, 80), rectOf(100, 80, 20, 10), "either drag, one rectangle");

  const rows = [at(1, 50, 50), at(2, 200, 50), at(3, 50, 200), at(4, 96, 50)];
  // #4 sits at x=96 with w=10, so its left edge (91) is inside a box ending at 90+1 — touching
  // is enough, the way a brush works.
  assert.deepEqual(marqueeHits(rows, rectOf(0, 0, 92, 100)), [1, 4], "touched, not swallowed whole");
  assert.deepEqual(marqueeHits(rows, rectOf(0, 0, 84, 100)), [1], "and a hair short of it misses");
  assert.deepEqual(marqueeHits(rows, rectOf(0, 0, 400, 400)), [1, 2, 3, 4], "everything, in paint order");
  assert.deepEqual(marqueeHits(rows, rectOf(300, 300, 400, 400)), [], "empty space selects nothing");
});

test("the selection box is the union of what is selected, and origins snapshot it", () => {
  assert.equal(boundsOf([]), null, "nothing selected has no box");
  assert.deepEqual(boundsOf([at(1, 50, 50, 10, 10)]), { x0: 45, y0: 45, x1: 55, y1: 55 });
  assert.deepEqual(
    boundsOf([at(1, 50, 50, 10, 10), at(2, 200, 20, 40, 4)]),
    { x0: 45, y0: 18, x1: 220, y1: 55 },
    "the union, not the first shape's box",
  );

  const rows = [at(1, 50, 50, 10, 10), at(2, 200, 20, 40, 4)];
  const origins = originsOf(rows);
  assert.deepEqual(origins, [
    { id: 1, x: 50, y: 50, w: 10, h: 10, rot: 0 },
    { id: 2, x: 200, y: 20, w: 40, h: 4, rot: 0 },
  ]);
  // The snapshot must not alias the rows: a drag writes new positions every frame, and origins
  // that followed them would compound the delta instead of measuring from the start.
  rows[0].x = 999;
  assert.equal(origins[0].x, 50, "origins are a copy");
});

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

test("the scene is deterministic, and every row is well-formed", () => {
  const a = initialScene();
  const b = initialScene();
  assert.deepEqual(a, b, "same seed, same drawing");
  assert.ok(a.length > 200, `expected a real scene, got ${a.length} rows`);

  const ids = new Set(a.map((r) => r.id));
  assert.equal(ids.size, a.length, "ids are unique");
  const zs = new Set(a.map((r) => r.z));
  assert.equal(zs.size, a.length, "paint order is total (no z ties in the seed)");

  const colors = new Set(PALETTE.map((p) => p.key));
  for (const r of a) {
    assert.ok(colors.has(r.color), `unknown color ${r.color}`);
    assert.ok(r.x >= 0 && r.x <= WORLD_W && r.y >= 0 && r.y <= WORLD_H, `row #${r.id} is off-world`);
    assert.ok(r.w > 0 && r.h > 0);
    assert.equal(r.area, Math.round(r.w * r.h * 10) / 10, `area is maintained for #${r.id}`);
  }
});

test("confetti is inert and takes the id/z/clock ranges it was given", () => {
  const rows = confetti(50, 7, 1000, 2000, 3000);
  assert.equal(rows.length, 50);
  assert.deepEqual(
    rows.map((r) => r.id),
    Array.from({ length: 50 }, (_, i) => 1000 + i),
  );
  for (const r of rows) {
    assert.equal(r.who, CONFETTI_WHO);
    assert.ok(r.z >= 2000 && r.updated >= 3000);
  }
});

function row(over: Partial<ShapeRow> & { id: number }): ShapeRow {
  const base = {
    kind: "rect",
    x: 100,
    y: 100,
    w: 10,
    h: 10,
    rot: 0,
    color: "sky",
    z: over.id,
    area: 100,
    updated: over.id,
    who: 0,
    layer: 2,
    ...over,
  };
  return { ...base, ...cellsOf(base.x, base.y) };
}

// ---------------------------------------------------------------------------------------------
// Writer coalescing (against a recording store — no engine)
// ---------------------------------------------------------------------------------------------

interface Recorded {
  adds: ShapeRow[];
  edits: Array<{ prev: ShapeRow; next: ShapeRow }>;
  removes: ShapeRow[];
  /** Writes to the `selection` table, kept apart so a test can say what SELECTING cost. */
  selAdds: number[];
  selRemoves: number[];
}

function recordingStore(log: Recorded[]): DrawStore {
  return {
    write: async (cb: (tx: unknown) => void) => {
      const rec: Recorded = { adds: [], edits: [], removes: [], selAdds: [], selRemoves: [] };
      cb({
        add: (t: string, r: ShapeRow & { shape?: number }) =>
          t === "selection" ? rec.selAdds.push(r.shape!) : rec.adds.push(r),
        edit: (_t: string, prev: ShapeRow, next: ShapeRow) => rec.edits.push({ prev, next }),
        remove: (t: string, r: ShapeRow & { shape?: number }) =>
          t === "selection" ? rec.selRemoves.push(r.shape!) : rec.removes.push(r),
      });
      log.push(rec);
    },
  } as unknown as DrawStore;
}

test("a frame's pointermoves coalesce to one edit, with area and clock maintained", async () => {
  const log: Recorded[] = [];
  const mirror = new Mirror();
  const writer = new Writer(recordingStore(log), mirror);
  await writer.seed([row({ id: 1, x: 10, y: 10, w: 10, h: 10, updated: 1 })]);

  const muts: Mut[] = [];
  for (let i = 0; i < 16; i++) muts.push({ op: "set", id: 1, patch: { x: 10 + i, y: 20 } });
  muts.push({ op: "set", id: 1, patch: { w: 40, h: 20 } });
  const res = await writer.commit(muts);
  assert.equal(res?.rows, 1, "sixteen moves and a resize are ONE row-write");
  const rec = log[1];
  assert.equal(rec.edits.length, 1);
  assert.equal(rec.edits[0].prev.x, 10, "the edit's old row is the pre-frame row");
  assert.equal(rec.edits[0].next.x, 25);
  assert.equal(rec.edits[0].next.area, 800, "area follows w×h");
  assert.ok(rec.edits[0].next.updated > 1, "the clock advanced");
  assert.equal(mirror.get(1)?.x, 25, "the mirror holds the committed row");
});

test("add+remove in one frame cancels; a patch folds into a same-frame add; raise bumps z", async () => {
  const log: Recorded[] = [];
  const mirror = new Mirror();
  const writer = new Writer(recordingStore(log), mirror);
  await writer.seed([row({ id: 1, z: 5 })]);

  const ghost = writer.draft("rect", 1, 1, 10, 10, "sky", 0);
  const kept = writer.draft("tri", 2, 2, 10, 10, "coral", 0);
  const res = await writer.commit([
    { op: "add", row: ghost },
    { op: "remove", id: ghost.id },
    { op: "add", row: kept },
    { op: "set", id: kept.id, patch: { w: 30 } },
    { op: "raise", id: 1 },
  ]);
  const rec = log[1];
  assert.equal(rec.adds.length, 1, "the ghost never reached the store");
  assert.equal(rec.adds[0].id, kept.id);
  assert.equal(rec.adds[0].w, 30, "the same-frame patch folded into the add");
  assert.equal(rec.adds[0].area, 300);
  assert.equal(rec.edits.length, 1);
  assert.ok(rec.edits[0].next.z > kept.z, "raise lands above every draft");
  assert.equal(res?.rows, 2);
  assert.equal(mirror.get(ghost.id), undefined);
});

test("an eye toggle is ONE layer-row edit; a hide+show in the same frame nets to nothing", async () => {
  const log: Recorded[] = [];
  const mirror = new Mirror();
  for (const l of LAYERS) mirror.addLayer({ ...l });
  const writer = new Writer(recordingStore(log), mirror);

  const cancelled = await writer.commit([
    { op: "layer", id: 3, patch: { visible: 0 } },
    { op: "layer", id: 3, patch: { visible: 1 } }, // last patch wins → no net change
  ]);
  assert.equal(cancelled, null, "a same-frame hide+show never reaches the store");

  const res = await writer.commit([{ op: "layer", id: 3, patch: { visible: 0 } }]);
  assert.equal(res?.rows, 1, "the toggle is one row-write");
  assert.equal(log[0].edits.length, 1);
  assert.equal(mirror.visibleLayer(3), false, "the mirror followed the layer edit");
});

test("selecting writes only what CROSSED in or out — the property a marquee lives on", async () => {
  const log: Recorded[] = [];
  const mirror = new Mirror();
  const writer = new Writer(recordingStore(log), mirror);
  await writer.seed([1, 2, 3, 4, 5].map((id) => row({ id, x: id * 20, y: 10, w: 10, h: 10, updated: id })));
  log.length = 0;

  const sel = (ids: number[], on = true): Mut[] => ids.map((id) => ({ op: "select" as const, id, on }));

  // Frame 1: the brush covers three shapes.
  const first = await writer.commit(sel([1, 2, 3]));
  assert.equal(first?.rows, 3, "three selection rows");
  assert.deepEqual(log[0].selAdds, [1, 2, 3]);
  assert.equal(log[0].adds.length + log[0].edits.length, 0, "and nothing was written to `shape`");

  // Frame 2: the brush grows over a fourth. THIS is the whole design: re-offering the three that
  // were already covered is not a write, so a marquee costs its edge, not its area.
  log.length = 0;
  const second = await writer.commit(sel([1, 2, 3, 4]));
  assert.equal(second?.rows, 1, "only the shape that crossed in");
  assert.deepEqual(log[0].selAdds, [4]);

  // Frame 3: the brush shrinks back off two of them.
  log.length = 0;
  const third = await writer.commit([...sel([1, 2]), ...sel([3, 4], false)]);
  assert.equal(third?.rows, 2, "only the two that crossed out");
  assert.deepEqual(log[0].selRemoves, [3, 4]);
  assert.deepEqual([...[1, 2, 3, 4, 5].filter((id) => mirror.isSelected(id))], [1, 2]);

  // Re-offering the selection unchanged reaches the store not at all.
  assert.equal(await writer.commit(sel([1, 2])), null, "an unchanged selection is not a commit");

  // Select and deselect in ONE frame nets to nothing, like every other coalesce here.
  assert.equal(await writer.commit([...sel([5]), ...sel([5], false)]), null);
  assert.equal(mirror.isSelected(5), false);

  // Deleting a selected shape takes its selection row with it — no row pointing at nothing.
  log.length = 0;
  await writer.commit([{ op: "remove", id: 1 }]);
  assert.deepEqual(log[0].selRemoves, [1], "the delete dropped the selection row too");
  assert.equal(mirror.isSelected(1), false);
});

test("a drop keeps a world-space density: far-out views contain it and close-ups let it overflow", () => {
  const closeView = { x0: 200, y0: 100, x1: 1000, y1: 600 }; // 800 x 500, centred on (600, 350)
  const centre = (r: { x0: number; y0: number; x1: number; y1: number }) => [
    (r.x0 + r.x1) / 2,
    (r.y0 + r.y1) / 2,
  ];

  // A close-up cannot hold even the first press at the chosen density, so its 800 x 500 viewport
  // grows to one 1600 x 1000 scene. Sixteen times the rows needs sixteen times that world area.
  const first = confettiArea(closeView, CONFETTI_PER_SCENE);
  assert.equal(first.x1 - first.x0, WORLD_W);
  assert.equal(first.y1 - first.y0, WORLD_H);
  assert.deepEqual(centre(first), centre(closeView), "the scatter box stays on the camera");
  assert.deepEqual(confettiArea(closeView, 10), first, "small jobs retain the baseline footprint");

  const big = confettiArea(closeView, 16 * CONFETTI_PER_SCENE);
  assert.equal(big.x1 - big.x0, WORLD_W * 4, "16x the rows needs 4x the width");
  assert.equal(big.y1 - big.y0, WORLD_H * 4, "...and 4x the height");

  // A far-out camera already has enough world area even for the largest press. Its viewport is
  // the scatter box, so every generated speck stays on screen instead of spreading farther out.
  const farView = { x0: -5600, y0: -3650, x1: 7200, y1: 4350 }; // 12800 x 8000
  const farArea = confettiArea(farView, 32_000);
  assert.deepEqual(farArea, farView);
  const farRows = confetti(32_000, 3, 1, 1, 1, farArea);
  assert.ok(farRows.every((r) => r.x >= farView.x0 && r.x <= farView.x1));
  assert.ok(farRows.every((r) => r.y >= farView.y0 && r.y <= farView.y1));

  // At a fixed close-up, increasing the job grows its world box with the job. The visible count
  // therefore remains roughly constant instead of all 32,000 rows becoming one dense screen.
  for (const n of [CONFETTI_PER_SCENE, 8000, 32_000]) {
    const area = confettiArea(closeView, n);
    const inView = confetti(n, 3, 1, 1, 1, area).filter(
      (r) => r.x >= closeView.x0 && r.x <= closeView.x1 && r.y >= closeView.y0 && r.y <= closeView.y1,
    ).length;
    assert.ok(inView > 350 && inView < 650, `a ${n}-row close-up showed ${inView} specks, expected about 500`);
  }

  // Every speck lands inside the box it was given, wherever that box is — including a viewport
  // panned off the opening scene into negative world space.
  const away = confettiArea({ x0: -4000, y0: -3000, x1: -3000, y1: -2400 }, 32_000);
  for (const r of confetti(500, 11, 1, 1, 1, away)) {
    assert.ok(r.x >= away.x0 && r.x <= away.x1, `#${r.id} scattered outside the drop at x=${r.x}`);
    assert.ok(r.y >= away.y0 && r.y <= away.y1, `#${r.id} scattered outside the drop at y=${r.y}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The robots
// ---------------------------------------------------------------------------------------------

test("write-rate rungs wake a bounded confetti cohort", () => {
  assert.equal(livingConfettiTarget(0), 0);
  assert.equal(livingConfettiTarget(24), 0, "the opening murmur keeps the base inert");
  assert.equal(livingConfettiTarget(96), 16);
  assert.equal(livingConfettiTarget(384), 32);
  assert.equal(livingConfettiTarget(1536), 64);
  assert.equal(livingConfettiTarget(6144), 128);
  assert.equal(livingConfettiTarget(100_000), 128, "the cohort does not scale with the pile");
  for (let id = 1; id <= 30; id++) assert.ok(isBotOwner(botOwnerFor(id)));
});

test("robots adopt awakened confetti but leave inert confetti alone", () => {
  const mirror = new Mirror();
  const awake = row({ id: 1, layer: LAYER_CONFETTI, who: botOwnerFor(1) });
  const inert = row({ id: 2, layer: LAYER_CONFETTI, who: CONFETTI_WHO });
  mirror.add(awake);
  mirror.add(inert);
  const bots = new Bots(mirror);
  bots.perSec = 600;
  assert.equal(bots.herdSize, 1);

  let awakeMoved = false;
  for (let t = 1; t <= 40; t++) {
    for (const mut of bots.tick(50, t * 50, null)) {
      assert.equal(mut.op, "set");
      assert.equal(mut.id, awake.id, "the inert confetto never entered the herd");
      if (mut.patch.x !== undefined || mut.patch.y !== undefined) awakeMoved = true;
    }
  }
  assert.equal(awakeMoved, true);
});

test("a robot drifts around wherever its shape lives — there is no world edge to bounce off", () => {
  const mirror = new Mirror();
  // Far outside the old WORLD_W x WORLD_H box, negative on one axis. Under the world-box bounce
  // this shape was dragged back to the border of a window that no longer exists — which is the
  // regression this asserts against, since `x` would end up pinned near WORLD_W rather than home.
  const home = { x: 9000, y: -4000 };
  mirror.add(row({ id: 1, x: home.x, y: home.y, w: 20, h: 20, who: 1 }));
  const bots = new Bots(mirror);
  bots.perSec = 600;

  let moves = 0;
  let travelled = 0;
  for (let t = 1; t <= 400; t++) {
    for (const m of bots.tick(50, t * 50, null)) {
      if (m.op !== "set" || m.patch.x === undefined || m.patch.y === undefined) continue;
      moves++;
      const next = { ...mirror.get(1)!, x: m.patch.x, y: m.patch.y };
      mirror.edit(next);
      travelled = Math.max(travelled, Math.abs(next.x - home.x), Math.abs(next.y - home.y));
    }
  }

  const end = mirror.get(1)!;
  assert.ok(moves > 100, `expected the robot to keep writing, got ${moves} moves`);
  assert.ok(travelled > 50, `expected real drift, the shape only moved ${travelled.toFixed(1)} units`);
  assert.ok(
    Math.abs(end.x - home.x) <= ROAM + 1 && Math.abs(end.y - home.y) <= ROAM + 1,
    `the shape roamed outside its own neighbourhood: ${end.x},${end.y} from ${home.x},${home.y}`,
  );
  assert.ok(end.x > WORLD_W, "and it was never pulled back inside the old world box");
});

test("dragging a robot's shape moves its neighbourhood with it, not the shape back", () => {
  const mirror = new Mirror();
  mirror.add(row({ id: 1, x: 400, y: 400, w: 20, h: 20, who: 1 }));
  const bots = new Bots(mirror);
  bots.perSec = 600;

  const step = (t: number): void => {
    for (const m of bots.tick(50, t * 50, null)) {
      if (m.op !== "set" || m.patch.x === undefined || m.patch.y === undefined) continue;
      mirror.edit({ ...mirror.get(1)!, x: m.patch.x, y: m.patch.y });
    }
  };
  for (let t = 1; t <= 40; t++) step(t); // let it settle into its neighbourhood

  // Your hand drags it a long way off — the write goes through the mirror like any other.
  const dropped = { x: 12_000, y: -5_000 };
  mirror.edit({ ...mirror.get(1)!, ...dropped });

  // The very next tick used to clamp it straight back to within ROAM of where it started.
  step(41);
  const after = mirror.get(1)!;
  assert.ok(
    Math.hypot(after.x - dropped.x, after.y - dropped.y) < 100,
    `the robot yanked the shape back: dropped at ${dropped.x},${dropped.y}, next move put it at ${after.x},${after.y}`,
  );

  // And it carries on drifting THERE, around the place you put it.
  for (let t = 42; t <= 200; t++) step(t);
  const end = mirror.get(1)!;
  assert.ok(
    Math.abs(end.x - dropped.x) <= ROAM + 100 && Math.abs(end.y - dropped.y) <= ROAM + 100,
    `the shape drifted away from where it was dropped: ${end.x},${end.y}`,
  );
});

test("new drifters land where the camera is looking, not in the old world box", () => {
  const mirror = new Mirror();
  const bots = new Bots(mirror);
  const writer = new Writer(recordingStore([]), mirror);
  const area = { x0: 20_000, y0: -9_000, x1: 21_600, y1: -8_000 };

  const rows = bots.drifters(24, (...a) => writer.draft(...a), area);
  assert.equal(rows.length, 24);
  for (const r of rows) {
    assert.ok(r.x >= area.x0 && r.x <= area.x1, `#${r.id} spawned at x=${r.x}, outside the viewport`);
    assert.ok(r.y >= area.y0 && r.y <= area.y1, `#${r.id} spawned at y=${r.y}, outside the viewport`);
    assert.ok(r.who >= 1 && r.who <= 3, "a drifter is robot-owned");
    assert.notEqual(r.who, CONFETTI_WHO, "and never confetti");
  }
  assert.ok(new Set(rows.map((r) => r.x)).size > 1, "scattered, not stacked");
});

// ---------------------------------------------------------------------------------------------
// Cells (the infinite canvas's addressing)
// ---------------------------------------------------------------------------------------------

test("a cell id is stable inside its cell and distinct across cells, in every direction", () => {
  // Same cell: the id must not move for points that share one.
  assert.equal(cellAt(0, 10, 10), cellAt(0, CELL0 - 1, CELL0 - 1));
  // Neighbours differ, on both axes.
  assert.notEqual(cellAt(0, 10, 10), cellAt(0, CELL0 + 10, 10));
  assert.notEqual(cellAt(0, 10, 10), cellAt(0, 10, CELL0 + 10));
  // NEGATIVE world coordinates are ordinary — the canvas has no origin corner any more. This is
  // what the coordinate bias exists for, and getting it wrong would fold -1 onto 0.
  assert.notEqual(cellAt(0, -1, -1), cellAt(0, 1, 1));
  assert.equal(cellAt(0, -1, -1), cellAt(0, -CELL0 + 1, -CELL0 + 1));
  assert.notEqual(cellAt(0, -CELL0 - 1, 0), cellAt(0, -1, 0));
  // Ids stay exact integers well inside a double's range (the engine compares them as Int).
  for (const [x, y] of [[0, 0], [-1e6, 1e6], [1e6, -1e6]]) {
    const id = cellAt(0, x, y);
    assert.ok(Number.isSafeInteger(id) && id > 0, `${x},${y} -> ${id}`);
  }
});

test("coarser levels nest: four level-N cells share one level-N+1 cell", () => {
  const s0 = cellSize(0);
  const corners = [
    [0, 0],
    [s0, 0],
    [0, s0],
    [s0, s0],
  ];
  const coarse = new Set(corners.map(([x, y]) => cellAt(1, x, y)));
  assert.equal(coarse.size, 1, "all four land in one level-1 cell");
  const fine = new Set(corners.map(([x, y]) => cellAt(0, x, y)));
  assert.equal(fine.size, 4, "and in four distinct level-0 cells");
  assert.equal(cellSize(1), s0 * 2);
  assert.equal(cellCol(2), "c2");
});

test("the zoom ladder is exactly the level count — 8x out, free in", () => {
  assert.equal(levelForZoom(1), 0, "100% reads the finest column");
  assert.equal(levelForZoom(0.5), 1);
  assert.equal(levelForZoom(0.25), 2);
  assert.equal(levelForZoom(0.125), LEVELS - 1);
  assert.equal(levelForZoom(0.001), LEVELS - 1, "past the floor it clamps, it does not fall off");
  assert.equal(levelForZoom(4), 0, "zooming IN never leaves level 0 — it costs the engine nothing");
});

test("a viewport's cell set covers every point in it, plus a ring for overhang", () => {
  const view = { x0: -300, y0: 120, x1: 900, y1: 700 };
  const set = new Set(cellsForView(0, view.x0, view.y0, view.x1, view.y1));
  // Every point inside the viewport is addressed by some subscribed cell — including the
  // negative-x half, which is the case a naive floor() would drop.
  for (let x = view.x0; x <= view.x1; x += 37) {
    for (let y = view.y0; y <= view.y1; y += 41) {
      assert.ok(set.has(cellAt(0, x, y)), `(${x}, ${y}) is not covered`);
    }
  }
  // And one ring beyond, so a shape whose centre sits just outside but whose body overhangs into
  // view is still found — the canvas indexes by centre, so this ring is what makes big shapes
  // correct without a second index.
  assert.ok(set.has(cellAt(0, view.x0 - CELL0 / 2, view.y0 - CELL0 / 2)), "the ring is subscribed");
  const coarse = cellsForView(2, view.x0, view.y0, view.x1, view.y1);
  assert.ok(coarse.length < set.size, "a coarser level covers the same view with fewer cells");
});

// ---------------------------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------------------------

/** A `PathSink` that records what it was asked to draw — the call names, and the coordinates
 *  they were given — so the SHAPE of a path can be asserted without a canvas. */
function recorder(): PathSink & { calls: string[]; args: number[][] } {
  const calls: string[] = [];
  const args: number[][] = [];
  const rec = (name: string) => (...a: number[]) => {
    calls.push(name);
    args.push(a);
  };
  return {
    calls,
    args,
    rect: rec("rect"),
    ellipse: rec("ellipse"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    closePath: rec("closePath"),
  };
}

const shape = (kind: ShapeRow["kind"], w: number, rot = 0): ShapeRow => ({
  id: 1,
  kind,
  x: 100,
  y: 100,
  w,
  h: w,
  rot,
  area: w * w,
  color: PALETTE[0].key,
  z: 1,
  layer: 1,
  who: CONFETTI_WHO,
  updated: 1,
  ...cellsOf(100, 100),
});

test("every traced shape OPENS its own subpath", () => {
  // The confetti layer appends thousands of shapes to one shared path. A branch that starts
  // drawing without opening a subpath continues the previous shape instead: `ellipse` in
  // particular draws a line from the current point to the arc's start, which spikes across the
  // canvas and fills everything between. `rect` opens one implicitly; everything else must
  // `moveTo` first.
  for (const kind of ["rect", "ellipse", "tri"] as const) {
    for (const px of [1, 1 / 8, 8]) {
      const r = recorder();
      traceShape(r, shape(kind, 20), px);
      assert.ok(
        r.calls[0] === "rect" || r.calls[0] === "moveTo",
        `${kind} at px=${px} began with ${r.calls[0]}, which continues whatever came before`,
      );
    }
  }
});

test("many shapes on one path stay one subpath each", () => {
  const r = recorder();
  const kinds = ["rect", "ellipse", "tri"] as const;
  for (let i = 0; i < 30; i++) traceShape(r, shape(kinds[i % 3], 20), 1);
  const opens = r.calls.filter((c) => c === "rect" || c === "moveTo").length;
  assert.equal(opens, 30, "one subpath opened per shape — no shape joins its neighbour");
});

// The confetti layer's cache policy. `Path2D` is a browser type, so what a Node test can reach
// is the decision itself — which is also the only part that can be WRONG in a way you would not
// see until a speck was drawn where it is not.
{
  const was = { count: 1000, idSum: 500_500, lod: 0 }; // ids 1..1000
  const arrived = (n: number, from: number) => ({
    arrivedCount: n,
    arrivedIdSum: (n * (2 * from + n - 1)) / 2, // from … from+n-1
  });

  test("an unchanged pile is not traced again", () => {
    assert.equal(staticPlan(was, { ...was, arrivedCount: 0, arrivedIdSum: 0 }), "keep");
  });

  test("a batch landing on top of the pile APPENDS — the pile is not re-traced around it", () => {
    // The batched drop, frame by frame: 2,000 fresh ids arrive above the high water and nothing
    // else moves. Re-tracing here would make every batch cost the whole base.
    const a = arrived(2000, 1001);
    const now = { count: 3000, idSum: was.idSum + a.arrivedIdSum, lod: 0, ...a };
    assert.equal(staticPlan(was, now), "append");
  });

  test("a speck LEAVING the layer costs the pile, however many arrived with it", () => {
    // Promoted by your hand, deleted, hidden with its layer, panned out of the subscribed cells:
    // a Path2D cannot drop a subpath, so the pile is traced again. The arrivals must not paper
    // over it — this is the case that would otherwise keep painting a shape that is gone.
    const a = arrived(2000, 1001);
    for (const gone of [1, 7, 1000]) {
      const now = { count: 2999, idSum: was.idSum - gone + a.arrivedIdSum, lod: 0, ...a };
      assert.equal(staticPlan(was, now), "rebuild", `losing id ${gone} must re-trace`);
    }
  });

  test("a promote — one speck out, none in — is a rebuild, not a no-op", () => {
    const now = { count: 999, idSum: was.idSum - 42, lod: 0, arrivedCount: 0, arrivedIdSum: 0 };
    assert.equal(staticPlan(was, now), "rebuild");
  });

  test("crossing the LOD re-traces even when the pile is identical", () => {
    // The paths are traced at a LOD: below ~4 screen pixels a speck is a square whatever its
    // kind, so a half-octave of zoom is a different pile, not a bigger one.
    assert.equal(staticPlan(was, { ...was, lod: 1, arrivedCount: 0, arrivedIdSum: 0 }), "rebuild");
  });

  test("the first frame has nothing to keep", () => {
    // The initial fingerprint is deliberately unmatchable (`lod` is NaN), so the layer cannot
    // start out believing it holds an empty pile it never traced.
    const fresh = { count: -1, idSum: -1, lod: NaN };
    assert.equal(staticPlan(fresh, { count: 0, idSum: 0, lod: 0, arrivedCount: 0, arrivedIdSum: 0 }), "rebuild");
  });
}

test("under ~4 screen pixels every kind degrades to a square", () => {
  for (const kind of ["rect", "ellipse", "tri"] as const) {
    const r = recorder();
    traceShape(r, shape(kind, 3), 1); // 3 world units at 1:1 — under the threshold
    assert.deepEqual(r.calls, ["rect"], `${kind} should be a bare rect when it is sub-pixel`);
  }
});

// ---------------------------------------------------------------------------------------------
// Rotation, the frame, and the eight handles — the gesture machine's arithmetic, without a
// pointer. Every one of these is what a hand does to a selection, written as a function.
// ---------------------------------------------------------------------------------------------

const RIGHT = Math.PI / 2;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const closeTo = (a: number, b: number, msg: string, eps = 1e-6) =>
  assert.ok(near(a, b, eps), `${msg}: ${a} vs ${b}`);

test("a rotated shape's bounding box is the box it is actually drawn in", () => {
  const flat = at(1, 100, 100, 40, 10);
  assert.deepEqual(aabbOf(flat), { x0: 80, y0: 95, x1: 120, y1: 105 });

  // Turned a quarter, a 40x10 shape occupies 10x40 — which is what the marquee, the viewport
  // cull and the selection box all have to agree about, or you can select a shape where it is
  // not and fail to select it where it is.
  const turned = aabbOf(at(1, 100, 100, 40, 10, RIGHT));
  closeTo(turned.x1 - turned.x0, 10, "the long axis is now vertical");
  closeTo(turned.y1 - turned.y0, 40, "…and the short one horizontal");

  // At 45° a square grows to its own diagonal, and not by more.
  const diag = aabbOf(at(1, 0, 0, 10, 10, Math.PI / 4));
  closeTo(diag.x1 - diag.x0, Math.SQRT2 * 10, "a square on its corner is as wide as its diagonal", 1e-9);

  // …and the marquee follows it: a box that misses the un-rotated shape catches the rotated one.
  const rows = [at(1, 100, 100, 40, 10, RIGHT)];
  assert.deepEqual(marqueeHits(rows, rectOf(90, 70, 110, 82)), [1], "the turned shape reaches up to y=80");
  assert.deepEqual(marqueeHits([at(1, 100, 100, 40, 10)], rectOf(90, 70, 110, 82)), [], "the flat one does not");
});

test("the frame is the shape when one is selected, and the union when several are", () => {
  const one = frameOf([at(1, 50, 60, 40, 10, 0.4)])!;
  assert.deepEqual(one, { cx: 50, cy: 60, w: 40, h: 10, rot: 0.4 }, "one shape's frame IS the shape");

  // Several: axis-aligned, because there is no shared angle to speak in — tldraw's rule, and the
  // only frame in which "drag the east edge" means anything for a set.
  const many = frameOf([at(1, 0, 0, 10, 10), at(2, 100, 40, 20, 20, 0.7)])!;
  assert.equal(many.rot, 0, "a set's frame is square to the world");
  const b = boundsOf([at(1, 0, 0, 10, 10), at(2, 100, 40, 20, 20, 0.7)])!;
  closeTo(many.cx, (b.x0 + b.x1) / 2, "centred on the union");
  closeTo(many.w, b.x1 - b.x0, "and as wide as it");
  assert.equal(frameOf([]), null, "nothing selected has no frame");
});

test("eight handles plus a rotate handle, and they turn with the frame", () => {
  const flat: Frame = { cx: 0, cy: 0, w: 200, h: 100, rot: 0 };
  const ids = handlePoints(flat, 1).map((h) => h.id);
  assert.deepEqual(
    [...ids].sort(),
    ["e", "n", "ne", "nw", "rotate", "s", "se", "sw", "w"],
    "four corners, four edges, one rotate",
  );
  // They ride the OUTLINE — the dashed box, a few pixels off the shape — which is where they
  // are drawn, so what you see and what you grab are the same rectangle.
  const byId = new Map(handlePoints(flat, 1).map((h) => [h.id, h]));
  assert.deepEqual({ x: byId.get("se")!.x, y: byId.get("se")!.y }, { x: 104, y: 54 });
  assert.deepEqual({ x: byId.get("n")!.x, y: byId.get("n")!.y }, { x: 0, y: -54 }, "edge handles are midpoints");
  assert.ok(byId.get("rotate")!.y < -54, "the rotate handle floats above the top edge");
  // …but a handle PULLS the frame's own corner, four pixels in from where it is drawn, so the
  // shape does not jump by the padding the moment you touch one.
  assert.deepEqual(handleAnchor(flat, "se"), { x: 100, y: 50 });
  assert.deepEqual(handleAnchor(flat, "n"), { x: 0, y: -50 });

  // A speck's outline stops shrinking, so there is still something to grab it BY: handles on a
  // 3-pixel shape's own corners would cover the whole shape.
  const speck = handlePoints({ cx: 0, cy: 0, w: 3, h: 3, rot: 0 }, 1);
  assert.ok(
    speck.every((h) => Math.abs(h.x) > 3 || Math.abs(h.y) > 3),
    "no handle sits on top of a tiny shape's middle",
  );

  // A quarter turn puts the "se" corner where "ne" was: the handle rides the frame, which is
  // what makes grabbing one do what the box in front of you promises.
  const turned = new Map(handlePoints({ ...flat, rot: RIGHT }, 1).map((h) => [h.id, h]));
  closeTo(turned.get("se")!.x, -54, "se rotated a quarter turn");
  closeTo(turned.get("se")!.y, 104, "…to where the drawing now shows it");
  assert.equal(handleAt({ ...flat, rot: RIGHT }, { x: -54, y: 104 }, 1), "se", "…and is grabbable there");

  // A frame too small on screen keeps its corners and drops the edge handles that would sit on
  // top of them.
  const tiny = handlePoints({ cx: 0, cy: 0, w: 6, h: 6, rot: 0 }, 1).map((h) => h.id);
  assert.deepEqual([...tiny].sort(), ["ne", "nw", "rotate", "se", "sw"], "no room for edge handles");

  // The cursor rotates too — a "ne" corner on a box turned 90° pulls along the other diagonal.
  assert.equal(handleCursor("ne", 0), "nesw-resize");
  assert.equal(handleCursor("ne", RIGHT), "nwse-resize");
  assert.equal(handleCursor("n", 0), "ns-resize");
  assert.equal(handleCursor("n", RIGHT), "ew-resize");
});

test("a handle scales about the opposite side, and an edge handle moves one axis only", () => {
  const frame: Frame = { cx: 0, cy: 0, w: 100, h: 100, rot: 0 };
  const origins = originsOf([at(1, 0, 0, 100, 100)]);

  // Pull the SE corner out to (150, 150) — the NW corner is at (-50, -50), so that is exactly
  // twice the box — and the anchor has not moved.
  const doubled = applyResize(frame, "se", { x: 150, y: 150 }, origins)[0];
  closeTo(doubled.w, 200, "twice as wide");
  closeTo(doubled.h, 200, "twice as tall");
  closeTo(doubled.x - doubled.w / 2, -50, "the anchored corner stayed put");
  closeTo(doubled.y - doubled.h / 2, -50, "on both axes");

  // The WEST edge handle: x moves, y is untouched. This is the whole reason for eight handles.
  const west = applyResize(frame, "w", { x: -100, y: 999 }, origins)[0];
  closeTo(west.w, 150, "the west edge pulled out");
  closeTo(west.h, 100, "and nothing happened vertically");
  closeTo(west.x + west.w / 2, 50, "the east edge is the anchor");

  // The floor is on the FRAME: dragging the handle past its anchor stops at MIN_SIZE rather
  // than flipping, and a tiny member of a set is not inflated to the floor.
  const crushed = applyResize(frame, "se", { x: -9999, y: -9999 }, originsOf([at(1, 0, 0, 100, 100), at(2, 40, 40, 2, 2)]));
  assert.ok(crushed[0].w > 0 && crushed[1].w > 0, "nothing inverted");
  assert.ok(crushed[1].w < 1, "the small one shrank with the set instead of being floored up");

  // A single ROTATED shape scales in its own frame: pulling its "e" handle grows `w`, whatever
  // angle the shape is at on screen.
  const turned: Frame = { cx: 0, cy: 0, w: 100, h: 20, rot: RIGHT };
  const grown = applyResize(turned, "e", { x: 0, y: 100 }, originsOf([at(1, 0, 0, 100, 20, RIGHT)]))[0];
  closeTo(grown.w, 150, "the shape's OWN width grew");
  closeTo(grown.h, 20, "its height did not");
});

test("rotating turns one shape in place and swings a set about its centre", () => {
  // One shape: the frame is the shape, so it turns without moving.
  const solo = applyRotate({ cx: 10, cy: 20, w: 40, h: 10, rot: 0 }, originsOf([at(1, 10, 20, 40, 10)]), RIGHT)[0];
  closeTo(solo.x, 10, "a single shape rotates about itself");
  closeTo(solo.y, 20, "and does not move");
  closeTo(solo.rot, RIGHT, "…by exactly the angle swept");

  // A set: every shape takes the angle AND swings about the frame's centre, so the arrangement
  // turns as one thing rather than each shape spinning where it stands.
  const rows = [at(1, 0, 0, 10, 10), at(2, 100, 0, 10, 10)];
  const pair = applyRotate(frameOf(rows)!, originsOf(rows), RIGHT);
  closeTo(pair[0].x, 50, "swung about the centre");
  closeTo(pair[0].y, -50, "a quarter turn");
  closeTo(pair[1].x, 50, "both of them");
  closeTo(pair[1].y, 50, "about the same centre");

  // ⇧ snaps the FRAME's angle to 15°, so a set stays coherent while it detents.
  const snapped = applyRotate({ cx: 0, cy: 0, w: 10, h: 10, rot: 0 }, originsOf([at(1, 0, 0, 10, 10)]), 0.31, true)[0];
  closeTo(snapped.rot, Math.PI / 12, "0.31 rad snapped to 15°", 1e-9);

  // And the column stays inside one turn however many times you go round.
  const wrapped = applyRotate({ cx: 0, cy: 0, w: 10, h: 10, rot: 6 }, originsOf([at(1, 0, 0, 10, 10, 6)]), 3)[0];
  assert.ok(wrapped.rot >= 0 && wrapped.rot < Math.PI * 2, `rot stayed in [0, 2π): ${wrapped.rot}`);
});

test("the hit test runs in the shape's own frame", () => {
  const flat = at(1, 0, 0, 100, 10);
  assert.ok(hitShape({ x: 40, y: 0 }, flat, 1), "along the long axis");
  assert.ok(!hitShape({ x: 0, y: 40 }, flat, 1), "but not off the short one");

  const turned = at(1, 0, 0, 100, 10, RIGHT);
  assert.ok(!hitShape({ x: 40, y: 0 }, turned, 1), "a quarter turn moves the long axis");
  assert.ok(hitShape({ x: 0, y: 40 }, turned, 1), "…to where the shape is now drawn");

  // A triangle's point: inside its box, outside the triangle — and the rotation carries that
  // exactness around with it.
  const tri = { ...at(1, 0, 0, 100, 100), kind: "tri" } as ShapeRow;
  assert.ok(!hitShape({ x: -45, y: -45 }, tri, 1), "the corner the triangle does not fill");
  assert.ok(hitShape({ x: 0, y: 40 }, tri, 1), "the base it does");
});

test("a rotated shape traces its own outline, one subpath at a time", () => {
  for (const kind of ["rect", "ellipse", "tri"] as const) {
    const r = recorder();
    traceShape(r, shape(kind, 20, 0.9), 1);
    assert.ok(r.calls[0] === "moveTo", `${kind} rotated must open with moveTo, got ${r.calls[0]}`);
  }
  // The ellipse's opening `moveTo` has to land on the arc's start IN THE SHAPE'S FRAME, or the
  // zero-length line it implies becomes a spike across the drawing (the canvas-wash bug).
  const r = recorder();
  traceShape(r, shape("ellipse", 20, RIGHT), 1);
  const [mx, my] = r.args[0];
  closeTo(mx, 100, "angle 0 of a quarter-turned ellipse");
  closeTo(my, 110, "is a quarter turn round its own rim");
  assert.equal(r.args[1][4], RIGHT, "and the arc itself carries the rotation");

  // Sub-pixel specks stay axis-aligned squares whatever their angle: at two pixels there is no
  // rotation to see and the confetti pile is thousands of them.
  const speck = recorder();
  traceShape(speck, shape("tri", 3, 1.2), 1);
  assert.deepEqual(speck.calls, ["rect"], "a speck is a rect at any angle");
});

test("a fit puts the rectangle on screen, centred, and inside the zoom range", () => {
  // 400x200 of world into an 800x800 viewport with a 40px margin: the width is the binding axis
  // — (800 - 80) / 400 — and the rectangle's centre lands in the middle of the screen.
  const fit = fitView({ x0: 0, y0: 0, x1: 400, y1: 200 }, 800, 800, 40, 0.125, 8);
  closeTo(fit.scale, 720 / 400, "scaled to the tighter axis, margin included");
  closeTo(fit.ox + 200 * fit.scale, 400, "centred horizontally");
  closeTo(fit.oy + 100 * fit.scale, 400, "and vertically");

  // A single tiny shape does not zoom to 400x — the ceiling holds.
  assert.equal(fitView({ x0: 0, y0: 0, x1: 2, y1: 2 }, 800, 800, 40, 0.125, 8).scale, 8);
  // …and a drawing bigger than the cell ladder can address stops at the floor.
  assert.equal(fitView({ x0: 0, y0: 0, x1: 1e6, y1: 1e6 }, 800, 800, 40, 0.125, 8).scale, 0.125);
});

// ---------------------------------------------------------------------------------------------
// Undo — the inverse delta, through the same writer
// ---------------------------------------------------------------------------------------------

/** A writer with history wired to it exactly as `DrawApp.boot` wires it, plus a clock the test
 *  controls (the coalescing window is a real part of the behaviour). */
function historyRig(rows: ShapeRow[]) {
  const log: Recorded[] = [];
  const mirror = new Mirror();
  for (const l of LAYERS) mirror.addLayer({ ...l });
  let selection: number[] = [];
  const history = new History(() => selection);
  const writer = new Writer(recordingStore(log), mirror);
  let clock = 0;
  writer.onCommit = (rec) => history.record(rec, clock);
  return {
    log,
    mirror,
    writer,
    history,
    seed: () => writer.seed(rows),
    tick: (ms: number) => (clock += ms),
    select: (ids: number[]) => (selection = ids),
    mark: (tag: string, coalesceMs = 0) => history.mark(tag, clock, coalesceMs),
    /** Apply one direction, the way the app does: commit the delta with `record = false`. */
    step: async (dir: "undo" | "redo") => {
      const d = dir === "undo" ? history.undo() : history.redo();
      if (d) await writer.commit(d.muts, false);
      return d;
    },
  };
}

test("sixty frames of a drag are ONE undo step, and undoing it is a write", async () => {
  const rig = historyRig([row({ id: 1, x: 100, y: 100 })]);
  await rig.seed();

  rig.mark("drag");
  for (let i = 1; i <= 60; i++) {
    await rig.writer.commit([{ op: "set", id: 1, patch: { x: 100 + i, y: 100 } }]);
    rig.tick(16);
  }
  assert.equal(rig.mirror.get(1)!.x, 160, "the drag landed");
  assert.deepEqual(rig.history.depth, { undo: 1, redo: 0 }, "sixty commits, one step");

  const undone = await rig.step("undo");
  assert.equal(undone?.tag, "drag");
  assert.equal(undone?.rows, 1, "one row-write of inverse delta, not sixty");
  assert.equal(rig.mirror.get(1)!.x, 100, "back where the gesture began");
  assert.deepEqual(rig.history.depth, { undo: 0, redo: 1 });

  const redone = await rig.step("redo");
  assert.equal(redone?.rows, 1);
  assert.equal(rig.mirror.get(1)!.x, 160, "and forward again to where it ended");

  // The undo's own commit must not become a step of its own, or ⌘Z would toggle forever.
  assert.deepEqual(rig.history.depth, { undo: 1, redo: 0 });
});

test("an undo rebases onto the other writers: it reverts YOUR columns, not the row", async () => {
  // This is what `CommitRecord.keys` buys. The robots write the whole time you do; an undo that
  // restored whole rows would quietly revert everything they had done to those rows since.
  const rig = historyRig([row({ id: 1, x: 0, y: 0, color: "sky" })]);
  await rig.seed();

  rig.mark("drag");
  await rig.writer.commit([{ op: "set", id: 1, patch: { x: 500 } }]);
  // …meanwhile, a robot recolors the same row. Not recorded — it is not your gesture.
  await rig.writer.commit([{ op: "set", id: 1, patch: { color: "coral" } }], false);

  await rig.step("undo");
  assert.equal(rig.mirror.get(1)!.x, 0, "your move came back out");
  assert.equal(rig.mirror.get(1)!.color, "coral", "and the robot's recolor stayed");
});

test("undo of a delete re-adds the exact row; undo of a draw removes it", async () => {
  const rig = historyRig([row({ id: 1, x: 10, y: 10, z: 5 })]);
  await rig.seed();

  // Draw: an add, then the same gesture's resize folds INTO the add rather than becoming an
  // edit with no "before" to go back to.
  rig.mark("draw");
  const drawn = rig.writer.draft("tri", 40, 40, 8, 8, "mint", 0);
  await rig.writer.commit([{ op: "add", row: drawn }]);
  await rig.writer.commit([{ op: "set", id: drawn.id, patch: { w: 60, h: 60 } }]);
  assert.equal(rig.mirror.get(drawn.id)!.w, 60);
  await rig.step("undo");
  assert.equal(rig.mirror.get(drawn.id), undefined, "the shape you drew is gone");
  await rig.step("redo");
  assert.equal(rig.mirror.get(drawn.id)!.w, 60, "and comes back the size you drew it");

  // Delete: the row goes back with its paint order intact, which is what `z` is doing in the
  // patch type at all.
  rig.mark("delete");
  const before = { ...rig.mirror.get(1)! };
  await rig.writer.commit([{ op: "remove", id: 1 }]);
  assert.equal(rig.mirror.get(1), undefined);
  await rig.step("undo");
  assert.deepEqual(rig.mirror.get(1), before, "the deleted row came back exactly as it was");
});

test("a raise is undone as a raise, and a move-then-delete rewinds to the start of the step", async () => {
  const rig = historyRig([row({ id: 1, z: 1 }), row({ id: 2, z: 2 })]);
  await rig.seed();

  rig.mark("drag");
  await rig.writer.commit([{ op: "raise", id: 1 }]);
  assert.ok(rig.mirror.get(1)!.z > rig.mirror.get(2)!.z, "grabbing raised it to the top");
  await rig.step("undo");
  assert.equal(rig.mirror.get(1)!.z, 1, "…and the inverse put the paint order back");

  // Moved and then deleted inside ONE step: the row must come back where the STEP began, not
  // where it was when it was deleted (its maintained columns re-derived with it).
  rig.mark("cut");
  await rig.writer.commit([{ op: "set", id: 2, patch: { x: 900, y: 900 } }]);
  await rig.writer.commit([{ op: "remove", id: 2 }]);
  await rig.step("undo");
  const back = rig.mirror.get(2)!;
  assert.equal(back.x, 100, "back at the step's starting position");
  assert.deepEqual(
    { c0: back.c0, c1: back.c1, c2: back.c2, c3: back.c3 },
    cellsOf(back.x, back.y),
    "with its cells re-derived",
  );
});

test("what is not yours is not on the stack, and a held key is one step", async () => {
  const rig = historyRig([row({ id: 1 })]);
  await rig.seed();
  assert.equal(rig.history.canUndo, false, "the opening scene is not a step you took");

  // The robots' ticks pass record = false and never reach the history.
  await rig.writer.commit([{ op: "set", id: 1, patch: { x: 42 } }], false);
  assert.equal(rig.history.canUndo, false, "a robot's write is not yours to undo");

  // Selecting writes rows, but not to the drawing: a marquee must not fill the undo stack.
  rig.mark("select");
  await rig.writer.commit([{ op: "select", id: 1, on: true }]);
  assert.equal(rig.history.canUndo, false, "selecting is a write, but not a step");

  // A held arrow key: same tag, inside the window, one step — and a new one once it lapses.
  rig.mark("nudge", 600);
  await rig.writer.commit([{ op: "set", id: 1, patch: { x: 43 } }]);
  rig.tick(100);
  rig.mark("nudge", 600);
  await rig.writer.commit([{ op: "set", id: 1, patch: { x: 44 } }]);
  assert.equal(rig.history.depth.undo, 1, "a run of nudges is one step");
  rig.tick(2000);
  rig.mark("nudge", 600);
  await rig.writer.commit([{ op: "set", id: 1, patch: { x: 45 } }]);
  assert.equal(rig.history.depth.undo, 2, "…and pausing starts another");

  await rig.step("undo");
  assert.equal(rig.mirror.get(1)!.x, 44);
  await rig.step("undo");
  assert.equal(rig.mirror.get(1)!.x, 42, "back to what the robot left, not further");
});

test("a new step forks the timeline: what was redoable is gone", async () => {
  const rig = historyRig([row({ id: 1, x: 0 })]);
  await rig.seed();
  rig.mark("drag");
  await rig.writer.commit([{ op: "set", id: 1, patch: { x: 10 } }]);
  await rig.step("undo");
  assert.equal(rig.history.depth.redo, 1);

  rig.mark("drag");
  await rig.writer.commit([{ op: "set", id: 1, patch: { y: 77 } }]);
  assert.equal(rig.history.depth.redo, 0, "a fresh change drops the redo branch");
  assert.equal(rig.history.depth.undo, 1);
});

test("history restores the selection the step began with, and holds a bounded pile", async () => {
  const rig = historyRig([row({ id: 1 }), row({ id: 2 })]);
  await rig.seed();

  rig.select([2]);
  rig.mark("drag"); // the mark comes BEFORE the click changes the selection
  rig.select([1]);
  await rig.writer.commit([{ op: "set", id: 1, patch: { x: 5 } }]);
  const undone = await rig.step("undo");
  assert.deepEqual(undone?.selection, [2], "undo hands back the selection you had before");
  const redone = await rig.step("redo");
  assert.deepEqual(redone?.selection, [1], "and redo the one the step ended with");

  // The cap is on ROWS, because one confetti press can put tens of thousands into a step.
  const small = new History(() => [], { maxSteps: 3, maxRows: 1_000_000 });
  for (let i = 0; i < 6; i++) {
    small.mark(`s${i}`, i);
    small.record({ adds: [row({ id: 100 + i })], edits: [], removes: [], layers: [] }, i);
  }
  small.close();
  assert.equal(small.depth.undo, 3, "the oldest steps are forgotten past the cap");
  assert.equal(small.rowsHeld, 3, "and their rows with them");
});
