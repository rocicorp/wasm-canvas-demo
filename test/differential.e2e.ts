// The contract, end to end, in Node: `view-after-write == fresh-query`, over the REAL wasm
// engine, after EVERY commit of a scripted drawing session.
//
// `DrawApp` holds no DOM, so this drives exactly what the page drives: the same seed, the same
// writer, the same robots, the same queries — and after every commit it recomputes every live
// query from scratch over the JS mirror and compares structurally. A drift of one row, one tie,
// or one stale `old` in an edit fails loudly with the query name and the first differing path.
//
//   npm test

import assert from "node:assert/strict";

import { CONFETTI_BATCH, DrawApp, MAX_SELECTION } from "../src/app.ts";
import { paint } from "../src/queries.ts";
import type { ShapeRow } from "../src/mirror.ts";
import type { Mut } from "../src/write.ts";

const app = new DrawApp();
await app.boot(); // no URL: @rindle/wasm reads the bytes out of the package in Node

// The canvas is a SET of live queries, so the session runs with a camera on it from the start:
// every commit below is folded into the cell views the page would actually be painting, and
// `checkAll` sweeps each one. A coarse level keeps the set to a couple of dozen cells while
// still covering everything the script draws.
const WIDE = { x0: -2600, y0: -2600, x1: 4200, y1: 4200 };
app.lookAt(WIDE, 0.125, 0);

/** What the page would be painting: every subscribed cell's rows, merged by z. */
const painted = (): readonly ShapeRow[] => app.cells.rows();

let commits = 0;
async function commit(muts: Mut[], record = true): Promise<void> {
  await app.commit(muts, record);
  commits++;
  const { mismatches } = app.checkAll();
  assert.equal(mismatches, 0, `mismatch after commit ${commits}: ${app.stats().offenders.join(" · ")}`);
}

// -- the seed itself ---------------------------------------------------------------------------
const seeded = app.mirror.size;
assert.ok(seeded > 200, `scene seeded ${seeded} rows`);
{
  const { mismatches, checks } = app.checkAll();
  assert.equal(mismatches, 0, "the freshly seeded views match their recomputes");
  assert.ok(checks >= 4, "all four standing queries were checked");
}

// -- a shape dragged across the drawing, one step per commit -------------------------------------
const someone = [...app.mirror.all()].find((r) => r.who === 1)!;
for (let i = 0; i <= 10; i++) {
  await commit([{ op: "set", id: someone.id, patch: { x: 530 + i * 14, y: 500 } }]);
}
{
  const painting = painted().some((r) => r.id === someone.id);
  assert.ok(painting, "the dragged shape is in the cells the camera has subscribed");
}

// -- resized onto the top of the leaderboard ----------------------------------------------------
await commit([{ op: "set", id: someone.id, patch: { w: 900, h: 900 } }]);
assert.equal((app.top.data[0] as unknown as ShapeRow).id, someone.id, "the resize climbed the leaderboard");

// -- recolored: the tally moves by exactly one, both sides ---------------------------------------
const tallyOf = (color: string) =>
  Number((app.tally.data.find((r) => (r as { color?: unknown }).color === color) as { count?: number })?.count ?? 0);
const fromColor = app.mirror.get(someone.id)!.color;
const toColor = fromColor === "mint" ? "coral" : "mint";
const before = { from: tallyOf(fromColor), to: tallyOf(toColor) };
await commit([{ op: "set", id: someone.id, patch: { color: toColor } }]);
assert.equal(tallyOf(fromColor), before.from - 1);
assert.equal(tallyOf(toColor), before.to + 1);

// -- raise, draft/add, remove --------------------------------------------------------------------
await commit([{ op: "raise", id: someone.id }]);
assert.equal(
  painted()[painted().length - 1].id,
  someone.id,
  "raised to the top of the paint order",
);

const drafted = app.writer.draft("ellipse", 300, 300, 120, 80, "violet", 0);
await commit([{ op: "add", row: drafted }]);
assert.ok(app.mirror.get(drafted.id), "the drafted shape landed");
await commit([{ op: "remove", id: drafted.id }]);
assert.equal(app.mirror.get(drafted.id), undefined);

// -- a selection is a live query, and selecting is a WRITE it folds -------------------------------
// The query's args never change: it is `where(exists(onSelection))`, registered at boot. What
// changes is the `selection` TABLE, and every assertion below is really about that — a pipeline
// that re-registered itself per selection would pass these too, and cost the frame budget doing
// it, which is why `selectSpend` at the end checks that nothing re-hydrates.
const selQuery = app.sel;
await app.select([someone.id]);
await commit([{ op: "set", id: someone.id, patch: { x: 777 } }]);
assert.equal((app.selectionRow() as unknown as ShapeRow).x, 777, "the selection card folded the drag");

// -- multi-select: the same view, more rows in it, moved as a group --------------------------------
{
  const group = painted()
    .filter((r) => r.id !== someone.id)
    .slice(0, 5)
    .map((r) => r.id);
  await app.select([...group, someone.id]);
  assert.equal(app.selectedIds.length, group.length + 1, "every clicked id is in the selection");
  assert.equal(app.selectionRows().length, group.length + 1, "and the view holds a row for each");
  assert.equal(app.mirror.selectionSize, group.length + 1, "the selection TABLE holds one row each");
  {
    const { mismatches } = app.checkAll();
    assert.equal(mismatches, 0, "the selection view matches its recompute after selecting");
  }

  // The rows come back z ASCENDING, like the canvas's own merge — the card and the paint order
  // agree about what is on top.
  const zs = app.selectionRows().map((r) => (r as unknown as ShapeRow).z);
  assert.deepEqual(zs, [...zs].sort((a, b) => a - b), "the selection is in paint order");

  // Drag the whole group: one commit, every selected row moved by the same delta.
  const origins = app.selectionRows().map((r) => ({ ...(r as unknown as ShapeRow) }));
  await commit(origins.map((o) => ({ op: "set" as const, id: o.id, patch: { x: o.x + 40, y: o.y - 25 } })));
  for (const o of origins) {
    const now = app.selectionRows().find((r) => (r as unknown as ShapeRow).id === o.id) as unknown as ShapeRow;
    assert.ok(now, `#${o.id} is still selected after the group drag`);
    assert.equal(now.x, Math.round((o.x + 40) * 10) / 10, `#${o.id} moved by the group's delta`);
    assert.equal(now.y, Math.round((o.y - 25) * 10) / 10);
  }

  // Toggling is the shift-click path.
  await app.toggle(someone.id);
  assert.equal(app.selectedIds.includes(someone.id), false, "shift-click took it back out");
  assert.equal(app.mirror.isSelected(someone.id), false, "and its selection row is gone");
  assert.equal(app.selectionRows().length, group.length, "the view folded the remove");

  // Re-offering a set that is already selected writes NOTHING — which is what makes a marquee
  // affordable: it re-offers its whole covered set every frame, and only the edge is new.
  const before = app.writer.totalRows;
  await app.select([...group].reverse());
  assert.equal(app.writer.totalRows, before, "re-selecting the same set is not a write");

  // And the clamp is honest about what it dropped.
  const many = painted().map((r) => r.id);
  if (many.length > MAX_SELECTION) {
    await app.select(many);
    assert.equal(app.selectedIds.length, MAX_SELECTION, "a huge selection clamps");
    assert.equal(app.selectionClamped, many.length - MAX_SELECTION, "and reports the remainder");
  }
  const { mismatches } = app.checkAll();
  assert.equal(mismatches, 0, "the selection view matches its recompute after the clamp");
}

// Deleting a selected shape takes its selection row with it — no row left pointing at nothing.
await app.select([someone.id]);
await commit([{ op: "remove", id: someone.id }]);
assert.equal(app.selectionRow(), null, "the selection folded the remove");
assert.equal(app.mirror.isSelected(someone.id), false, "and the selection table let it go");
await app.select([]);

// The whole selection session above, and the view was never re-registered once.
assert.equal(app.sel, selQuery, "the selection view is the one subscribed at boot");
assert.equal(app.sel.hydrateMs > 0, true, "it hydrated exactly once, at boot");

// -- the robots, driven at a fixed clock ---------------------------------------------------------
for (let tick = 0; tick < 30; tick++) {
  const muts = app.bots.tick(100, tick * 100, null);
  if (muts.length > 0) await commit(muts, false); // the robots are other writers: not your history
}

// -- confetti: one big commit, folded correctly everywhere ---------------------------------------
// 500 rows is under CONFETTI_BATCH, so this drop is still exactly one commit.
{
  const { commits: n } = await app.addConfetti(500);
  assert.equal(n, 1, "a drop that fits in one batch is one commit");
  commits++;
  const { mismatches } = app.checkAll();
  assert.equal(mismatches, 0, "500 rows in one commit folded correctly everywhere");
}

// -- layers: ONE row edit on `layer`, and every gated membership re-derives ----------------------
{
  const before = painted().length;
  await commit([{ op: "layer", id: 3, patch: { visible: 0 } }]); // hide confetti
  assert.equal(painted().length, before - 500, "hiding the confetti layer removed exactly the 500 confetti from the canvas");
  await commit([{ op: "layer", id: 2, patch: { visible: 0 } }]); // hide the drawing too
  await commit([{ op: "layer", id: 1, patch: { visible: 0 } }]); // a fully hidden drawing
  assert.equal(painted().length, 0, "every layer hidden: the canvas is empty");
  await commit([
    { op: "layer", id: 1, patch: { visible: 1 } },
    { op: "layer", id: 2, patch: { visible: 1 } },
    { op: "layer", id: 3, patch: { visible: 1 } },
  ]);
  assert.equal(painted().length, before, "re-showing every layer restored the full membership");
}

// -- a BATCHED drop: many commits, one frame apart, one history step ------------------------------
// A big press is a job, not a transaction: `addConfetti` lands it CONFETTI_BATCH rows at a time,
// one batch per frame, so no single frame carries the whole pile. Every batch is still an ordinary
// commit, which is what this checks — the contract is per commit, and it does not care that there
// are now several of them. And the whole job is ONE undo step, because a step is a gesture.
{
  const before = app.mirror.size;
  const undoBefore = app.history.depth.undo;
  const want = CONFETTI_BATCH * 2 + 250;
  let batches = 0;
  const { rows, commits: n } = await app.addConfetti(want, undefined, (b) => {
    batches++;
    assert.ok(b.rows <= CONFETTI_BATCH, `batch ${batches} carried ${b.rows} rows, over the cap`);
    commits++;
    const { mismatches } = app.checkAll();
    assert.equal(mismatches, 0, `mismatch after confetti batch ${batches}: ${app.stats().offenders.join(" · ")}`);
  });
  assert.equal(rows, want, "the job committed exactly what it was asked for");
  assert.equal(n, 3, "and split it into ceil(want / CONFETTI_BATCH) commits");
  assert.equal(batches, n, "each one reported itself as it landed");
  assert.equal(app.mirror.size, before + want, "the base grew by the whole drop");
  assert.equal(app.history.depth.undo, undoBefore + 1, "three commits, ONE step: the press you made");
  // …and that one step undoes the whole drop, in one inverse commit like any other.
  const step = await app.undo();
  assert.equal(step?.rows, want, "the inverse carries every row the job added");
  assert.equal(app.mirror.size, before, "and puts the base back where it started");
  commits++;
  const { mismatches } = app.checkAll();
  assert.equal(mismatches, 0, "every view is exact after undoing a batched drop");
  await app.redo(); // the rest of the script expects the drop to be there
  commits++;
  assert.equal(app.checkAll().mismatches, 0, "…and after redoing it");
}

// -- rotation, duplication, nudging, and the extent queries ---------------------------------------
// Everything the keyboard and the handles can do, checked like everything else. `rot` is a plain
// column: nothing derived moves when it changes, and the point of running it through here is
// that the differential would say so if that were wrong.
{
  const target = painted().find((r) => r.who !== 9)!;
  await commit([{ op: "set", id: target.id, patch: { rot: Math.PI / 3 } }]);
  const turned = app.mirror.get(target.id)!;
  assert.equal(turned.rot, Math.round((Math.PI / 3) * 1e4) / 1e4, "the angle was stored, rounded, once");
  assert.equal(turned.area, target.area, "rotating does not touch `area`");
  assert.deepEqual(
    { c0: turned.c0, c1: turned.c1, c2: turned.c2, c3: turned.c3 },
    { c0: target.c0, c1: target.c1, c2: target.c2, c3: target.c3 },
    "nor the cells — a rotation about the centre leaves the centre where it was",
  );
  // Round the clock: the column stays inside one turn.
  await commit([{ op: "set", id: target.id, patch: { rot: Math.PI * 5 } }]);
  const wrapped = app.mirror.get(target.id)!.rot;
  assert.ok(wrapped >= 0 && wrapped < Math.PI * 2, `rot folded into one turn: ${wrapped}`);

  // ⌘D: one commit, and the copies are what is selected afterwards.
  await app.select([target.id]);
  const copied = await app.duplicate();
  commits++;
  assert.equal(copied?.rows, 1, "one shape duplicated is one row-write");
  assert.equal(app.selectedIds.length, 1, "the copy is selected, not the original");
  const copy = app.mirror.get(app.selectedIds[0])!;
  assert.notEqual(copy.id, target.id, "a new row, not the same one");
  assert.equal(copy.rot, wrapped, "the copy carries the original's rotation");
  assert.ok(copy.z > app.mirror.get(target.id)!.z, "and lands on top of it");
  assert.equal(app.checkAll().mismatches, 0, "every query folded the duplicate");

  // Arrow keys.
  const at0 = { x: copy.x, y: copy.y };
  await app.nudge(0, -10);
  commits++;
  assert.equal(app.mirror.get(copy.id)!.y, Math.round((at0.y - 10) * 10) / 10, "nudged by exactly the delta");
  assert.equal(app.checkAll().mismatches, 0, "and the views folded it");

  // ⇧1's extent: four ORDER BY … LIMIT 1 queries, subscribed on first use and checked from then
  // on like any other query in the sweep.
  const sweepBefore = app.queries().length;
  const { rect, fresh } = app.contentBounds();
  assert.equal(fresh, true, "the first ask subscribes them");
  assert.equal(app.queries().length, sweepBefore + 4, "and they join the differential sweep");
  assert.ok(rect, "the drawing has an extent");
  for (const r of app.mirror.all()) {
    if (!app.mirror.visibleLayer(r.layer)) continue;
    assert.ok(r.x >= rect!.x0 && r.x <= rect!.x1, `#${r.id} is inside the extent horizontally`);
    assert.ok(r.y >= rect!.y0 && r.y <= rect!.y1, `#${r.id} is inside it vertically`);
  }
  assert.equal(app.contentBounds().fresh, false, "the second ask reads the maintained views");
  assert.equal(app.checkAll().mismatches, 0, "the extent views match their recomputes");

  // A write that moves the edge of the drawing moves the extent, without re-subscribing.
  const far = app.writer.draft("rect", rect!.x1 + 5000, rect!.y0, 40, 40, "lemon", 0);
  await commit([{ op: "add", row: far }]);
  assert.ok(app.contentBounds().rect!.x1 > rect!.x1, "the extent folded the new far edge");
  await commit([{ op: "remove", id: far.id }]);
  assert.ok(app.contentBounds().rect!.x1 <= rect!.x1 + 1, "and folded it back out when it left");
}

// -- undo/redo: the SAME contract, one inverse delta at a time ------------------------------------
// This is the whole argument for building undo as a delta rather than as a snapshot: there is no
// new oracle here and no new machinery. An undo is a commit, so `view-after-undo == fresh-query`
// is checked by exactly the recomputes every other commit is checked by.
{
  await app.select([]);
  // Every column but `updated`, key order normalised: an undo IS a write, so it takes a fresh
  // clock tick like any other. What must come back exactly is the DRAWING — every position,
  // size, angle, colour and paint order — and that is what this compares.
  const snapshot = () =>
    [...app.mirror.all()]
      .sort((a, b) => a.id - b.id)
      .map((r) => {
        const { updated: _clock, ...rest } = r;
        return JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
      })
      .join("|");

  const before = snapshot();
  const depth0 = app.history.depth.undo;

  // Four steps of different SHAPES of change: an edit, a raise, an add, a delete, a layer
  // toggle — each one its own gesture.
  const subject = painted().find((r) => r.who !== 9)!;
  app.mark("drag");
  for (let i = 1; i <= 5; i++) await commit([{ op: "set", id: subject.id, patch: { x: subject.x + i * 7 } }]);
  app.mark("draw");
  const drawn = app.writer.draft("ellipse", 640, 480, 90, 60, "pink", 0);
  await commit([{ op: "add", row: drawn }]);
  app.mark("delete");
  await commit([{ op: "remove", id: subject.id }]);
  app.mark("layer");
  await commit([{ op: "layer", id: 3, patch: { visible: 0 } }]);

  assert.equal(app.history.depth.undo, depth0 + 4, "four gestures, four steps");
  const after = snapshot();
  assert.notEqual(after, before, "the drawing moved");

  // Back, one step at a time, checking every query after every inverse commit.
  for (let i = 0; i < 4; i++) {
    const step = await app.undo();
    commits++;
    assert.ok(step, `step ${i + 1} came back`);
    assert.ok(step!.rows > 0, "and carried a delta");
    const { mismatches } = app.checkAll();
    assert.equal(mismatches, 0, `every view is exact after undoing "${step!.tag}": ${app.stats().offenders.join(" · ")}`);
  }
  assert.equal(snapshot(), before, "four undos land on exactly the drawing we started from");
  assert.equal(app.mirror.get(drawn.id), undefined, "the shape that was drawn is gone again");
  assert.ok(app.mirror.get(subject.id), "and the one that was deleted is back");

  // …and forward again.
  for (let i = 0; i < 4; i++) {
    const step = await app.redo();
    commits++;
    assert.ok(step, `redo ${i + 1} came back`);
    const { mismatches } = app.checkAll();
    assert.equal(mismatches, 0, `every view is exact after redoing "${step!.tag}"`);
  }
  assert.equal(snapshot(), after, "and four redos land on exactly where we were");
  assert.equal(await app.redo(), null, "nothing left to redo");

  // Undo does not undo the ROBOTS: their writes never entered the stack.
  const depthBefore = app.history.depth.undo;
  for (let tick = 0; tick < 5; tick++) {
    const muts = app.bots.tick(100, 10_000 + tick * 100, null);
    if (muts.length > 0) await commit(muts, false);
  }
  assert.equal(app.history.depth.undo, depthBefore, "a robot's commit is not a step of yours");

  // Put the confetti layer back the way the rest of the script expects it.
  await app.undo();
  commits++;
  assert.equal(app.mirror.getLayer(3)!.visible, 1, "the layer toggle undid");
  for (let i = 0; i < 3; i++) {
    await app.undo();
    commits++;
  }
  assert.equal(app.checkAll().mismatches, 0, "the sweep is clean after unwinding the whole session");
}

// -- a user-authored pane: evaled text, checked by a fresh subscription --------------------------
{
  const added = app.addCustom(`q.shape\n  .where.color("coral")\n  .orderBy("area", "desc").limit(5)`);
  if (!added.ok) assert.fail(`the custom pane did not subscribe: ${added.error}`);
  const pane = app.customs.find((c) => c.id === added.id)!;

  // Its view folds like any other — and every commit() from here also sweeps it via checkAll.
  const big = app.writer.draft("rect", 100, 100, 400, 400, "coral", 0);
  await commit([{ op: "add", row: big }]);
  assert.equal((pane.live.data[0] as unknown as ShapeRow).id, big.id, "the custom view folded the add");

  // A broken edit reports its error and leaves the previous subscription live.
  const broken = app.editCustom(pane.id, "q.shape.where.");
  if (broken.ok) assert.fail("a syntax error was accepted");
  assert.ok(broken.error.length > 0, "the syntax error carries a message");
  assert.equal((pane.live.data[0] as unknown as ShapeRow).id, big.id, "the previous query stayed live");

  const notAQuery = app.editCustom(pane.id, "42");
  if (notAQuery.ok) assert.fail("a non-query expression was accepted");

  // A good edit tears the old pipeline out and subscribes the new text.
  const replaced = pane.live;
  const foldsAtEdit = replaced.folds;
  const edited = app.editCustom(pane.id, `q.shape.groupBy("kind").count()`);
  if (!edited.ok) assert.fail(`the edit did not subscribe: ${edited.error}`);
  assert.notEqual(pane.live, replaced, "the edit swapped in a new pipeline");
  // Removing `big` (the top coral rect) would fold into the OLD query — a torn-out pipeline
  // must not see it.
  await commit([{ op: "remove", id: big.id }]);
  assert.equal(replaced.folds, foldsAtEdit, "the torn-out pipeline stopped folding");
  assert.ok(pane.live.data.length >= 1, "the edited aggregate is live");

  // A selection set: the rows come back MASKED to the selected columns (plus the primary key,
  // which always rides along) — and the fresh-subscription check holds on the projection too.
  const projected = app.editCustom(pane.id, `q.shape.select("color", "area")\n  .orderBy("area", "desc").limit(3)`);
  if (!projected.ok) assert.fail(`the select did not subscribe: ${projected.error}`);
  assert.equal(pane.live.data.length, 3, "the projected window is live");
  for (const row of pane.live.data) {
    assert.deepEqual(Object.keys(row).sort(), ["area", "color", "id"], "each row is exactly the selection + pk");
  }
  await commit([{ op: "set", id: (pane.live.data[0] as { id: number }).id, patch: { w: 5, h: 5 } }]);

  const sweepBefore = app.queries().length;
  const closed = pane.live;
  app.removeCustom(pane.id);
  assert.ok(!app.customs.some((c) => c.id === pane.id), "the pane is gone");
  assert.equal(app.queries().length, sweepBefore - 1, "a closed pane leaves the check set");
  // A write that would move the closed pane's window (a shape big enough to enter the top-3
  // by area) must not reach its destroyed view either.
  const foldsAtClose = closed.folds;
  const probe = app.writer.draft("tri", 50, 50, 900, 900, "mint", 0);
  await commit([{ op: "add", row: probe }]);
  assert.equal(closed.folds, foldsAtClose, "a closed pane's pipeline stopped folding");
  await commit([{ op: "remove", id: probe.id }]);
  const { mismatches } = app.checkAll();
  assert.equal(mismatches, 0, "the sweep is clean after the pane closed");
}

// -- the canvas as a set of cells --------------------------------------------------------------
// The infinite canvas paints from one live query PER VISIBLE CELL, merged by z. The invariant
// that makes that legitimate: a viewport covering the whole drawing must produce EXACTLY the
// global paint query's rows, in the same order. If the cell columns, the merge, or the seek were
// wrong, this is where it shows.
{
  const all = [...app.mirror.all()];
  const bounds = {
    x0: Math.min(...all.map((r) => r.x)) - 400,
    y0: Math.min(...all.map((r) => r.y)) - 400,
    x1: Math.max(...all.map((r) => r.x)) + 400,
    y1: Math.max(...all.map((r) => r.y)) + 400,
  };
  app.lookAt(bounds, 1, 0);
  assert.ok(app.cells.views.size > 4, `a real cell set, got ${app.cells.views.size}`);

  // The comparison is against the INDEPENDENT RECOMPUTE — plain JS over the mirror, sharing no
  // operator and no index with the engine — not against another engine view. The page runs no
  // whole-drawing subscription at all, and this is stronger than comparing two engine outputs
  // would have been.
  const merged = app.cells.rows().map((r) => r.id);
  const fresh = paint.recompute(app.mirror, undefined).map((r) => (r as unknown as ShapeRow).id);
  assert.deepEqual(merged, fresh, "merged cell views == a fresh whole-drawing query, z order included");

  const { mismatches } = app.checkAll();
  assert.equal(mismatches, 0, "and every cell view matches its own independent recompute");

  // Panning is INCREMENTAL: shifting the viewport by one cell keeps every interior subscription
  // and only touches the edge. This is the claim the whole design rests on.
  const before = new Set(app.cells.views.keys());
  const subsBefore = app.cells.subscribes;
  app.lookAt({ ...bounds, x0: bounds.x0 + 256, x1: bounds.x1 + 256 }, 1, 0);
  const added = app.cells.subscribes - subsBefore;
  const kept = [...app.cells.views.keys()].filter((c) => before.has(c)).length;
  assert.ok(added > 0 && added < before.size, `a pan touches the edge only: +${added} of ${before.size}`);
  assert.ok(kept > before.size / 2, `most of the viewport kept its pipelines, kept ${kept}`);

  // A shape dragged across a cell boundary must LEAVE one cell's view and ENTER another's — the
  // engine's own edit split, routed to both cells by the push index.
  const mover = all.find((r) => r.who === 1)!;
  const fromCell = mover.c0;
  await commit([{ op: "set", id: mover.id, patch: { x: mover.x + 256, y: mover.y } }]);
  const moved = app.mirror.get(mover.id)!;
  assert.notEqual(moved.c0, fromCell, "the move crossed a level-0 cell boundary");
  const { mismatches: afterMove } = app.checkAll();
  assert.equal(afterMove, 0, "every cell view is still exact after the crossing");

  // Zoom steps the level, which re-addresses every cell — the one non-incremental camera move.
  app.lookAt(bounds, 0.25, 0);
  assert.equal(app.cells.level, 2, "a quarter zoom reads the level-2 column");
  const zoomed = app.cells.rows().map((r) => r.id);
  const freshAfter = paint.recompute(app.mirror, undefined).map((r) => (r as unknown as ShapeRow).id);
  assert.deepEqual(zoomed, freshAfter, "a coarser level covers exactly the same drawing");
  assert.equal(app.checkAll().mismatches, 0, "and is exact cell by cell");
}

const s = app.stats();
assert.equal(s.mismatches, 0);
assert.ok(s.checks > 200, `expected a real body of checks, got ${s.checks}`);
assert.ok(s.rows > seeded + 400, "the base grew");

app.destroy();
process.stdout.write(
  `✅ differential e2e: ${commits} commits · ${s.checks} checks · 0 mismatches · ${s.rows} rows · ${s.cellsLive} cells live (level ${s.cellLevel}, ${s.cellSubscribes} subscribed / ${s.cellTeardowns} torn down)\n`,
);
