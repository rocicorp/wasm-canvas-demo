# wasm-canvas-demo

An **infinite** drawing canvas where **every piece of UI is a live query** — the canvas included —
over an in-tab wasm IVM engine. Your pointer writes rows; what you see is the fold. The shape
follows your hand because the write, the derivation of every affected pipeline, and the fold of
every affected view all complete **inside `store.write()`, before the frame paints**.

And the canvas is not one query. It is **one live query per visible cell**, merged by `z`.
Panning does not re-run anything: it subscribes the cells coming into view and drops the ones
that left, so the interior of a pan is free and only the edge costs a hydrate.

The controls are **tldraw's**, so most hands already know them: click a shape to select it,
shift-click to add or remove one, drag empty canvas to brush a group, drag any selected shape to
move the whole set, pull any of the **eight handles** to scale it about the opposite side, and
turn it with the handle above the box (⇧ snaps to 15°). One shape selected is framed in its own
rotated box, so a resize runs along the shape's axes rather than the screen's; a set is framed
square to the world, which is the only frame in which "drag the east edge" means anything shared.
`⌘D` duplicates, the arrow keys nudge (⇧ by ten), `⌘Z` / `⇧⌘Z` undo and redo, `⌘A` selects
everything the canvas is holding, `Escape` clears. The camera is wheel to pan, ⌘/ctrl-wheel (or a
trackpad pinch, or two fingers on a touchscreen) to zoom, space-drag / middle-drag / the hand
tool (`H`) to pan, and `⇧1` / `⇧2` to fit the drawing or the selection.

This is the wasm engine's own argument, distinct from the throughput/scale story: in a browser, the thing
an IVM engine buys you is the **next frame already being right** — felt in the wrist, not read
off a chart.

```sh
npm install
npm run dev        # → http://localhost:5173
```

The engine arrives as two published packages — `@rindle/client` and `@rindle/wasm`, the latter
carrying the compiled `pkg/rindle_bg.wasm`. Nothing here builds Rust.

It deploys as a **static site** — `npm run build` emits `dist/`, and there is no server tier to
add, because there is no server. `vercel.json` pins the Vite preset, so a Vercel project pointed
at this repo needs no further configuration.

## The page is six queries and a canvas made of forty more

The canvas is the sixth-and-a-half: `q.shape.where.c1(<cell>)` × however many cells are on
screen. Every one of them is a live subscription, and the visible cells are merged by `z`.

| where you see it | the query |
|---|---|
| the canvas | `q.shape.where.c1(<cell>).where(exists(onLayer, l => l.where.visible(1))).orderBy("z", "asc")` — **one per visible cell**, merged by `z`. An EQUALITY on the cell column, not a range over x/y, because equality is what the engine can **seek**: the `where` yields a `PushGuard`, the leaf turns it into a seek over a `(cell, z, id)` index, and the scan breaks at the cell edge. The same window as `.where.x(ge(…)).where.x(le(…))` would be a full table scan per subscription — the shape this one exists to avoid |
| the viewport panel | *the same cell query again*, not a seventh — one of the live ones, with the SET's own arithmetic beside it: how many shapes the canvas is painting, how many cell queries are subscribed (and how many of those are cooling off after leaving the view), and the subscribe/teardown totals since boot. Pan and every one of those numbers moves without a single query re-running |
| the layers panel | `q.layer.countAs("shapes", layerShapes).orderBy("id", "asc")` — one row per layer with a live correlated `count(*)` of its shapes |
| the palette | `q.shape.groupBy("color").count()` — a real top-level aggregate; recolor a shape and two counters move in the same commit. Deliberately ungated: it is the drawing's inventory, hidden layers included |
| "largest" | `q.shape.where(exists(onLayer, …)).orderBy("area", "desc").limit(6)` — grab a corner handle and resize onto the board |
| "recent writes" | `q.shape.where(exists(onLayer, …)).orderBy("updated", "desc").limit(8)` |
| `⇧1`, zoom to fit | `q.shape.where(exists(onLayer, …)).orderBy("x", "asc").limit(1)` — and three more like it (`x desc`, `y asc`, `y desc`). The drawing's extent, on a page with deliberately no whole-drawing subscription to ask: four `ORDER BY … LIMIT 1` windows the engine's `take` keeps true through every write. Subscribed **lazily**, the first time you press ⇧1 — four extra orderings are four extra indexes over the base, and a page that never asks to fit should not pay for them — and maintained from then on, so the second press reads four one-row arrays |
| the selection card | `q.shape.where(exists(onSelection)).orderBy("z", "asc")` — **registered once, at boot, and never again.** What is selected lives in a `selection` TABLE, so selecting is a *write* this view folds, exactly like every other write on the page: brushing a marquee across the drawing costs the shapes crossing the box's edge, not the whole set. Ungated by layer visibility — hiding is not deselecting. It is also the only view held independently of the camera, which is what lets a selection survive being panned away from |

Every panel shows the builder chain it registered — the actual query, args inlined, not a SQL
translation — flashes when its view folds a delta, and prints the last delta it folded.

**And you can write the seventh.** Every panel has a **fork** button (and the rail ends in
"+ your own query"): it opens a pane whose textarea is the code block, seeded with that panel's
current chain. The text is evaled as the real builder — same root, same helpers, no parser
(`src/custom.ts`) — so what runs is exactly what the pane shows; ⌘↩ re-subscribes. A bad edit
(a syntax error, an unsupported shape, a non-query) prints the engine's error inline while the
previous subscription keeps folding. The demo's claim stops being about our six queries and
becomes falsifiable: write one we didn't anticipate and watch the robots' writes fold into it.

**The join is the layers panel's eye toggle.** `visible` lives on the `layer` row — one row for
thousands of shapes — and every painted query reaches it through the `onLayer` relationship
(`shape.layer → layer.id`). Hiding a layer is therefore ONE row-write whose consequences the
engine's joins fan out: every gated query re-derives its membership in the same commit. (One
engine edge, honestly noted: an `EXISTS` inside a top-level aggregate's `where` isn't lowered
yet, which is why the palette stays an ungated inventory.)

**The selection is the same trick pointed at the pointer.** What is selected is a `selection`
table, and the card is `exists(onSelection)` — so the query's text is fixed forever and selecting
is a row-write it folds. The alternative that looks reasonable is to put the selected ids in the
query (`where.id(inList([…]))`); it even seeks, because the builder lowers `IN` to a multi-value
`PushGuard`. But it makes the selection part of the query's *identity*, so every change
re-registers the pipeline. Measured on one 60-frame marquee over 4,230 rows:

| | ids in the query | selection as a table |
|---|---|---|
| re-subscriptions | 60 | **0** |
| hydration | 767 ms | **0 ms** |
| work done | 22,847 seeks | 512 row-writes |
| `pointermove` p50 | 17.8 ms | **0.3 ms** |

Same engine, same gesture, same final 512 rows selected. The difference is entirely whether the
thing that changed was the query or the data — which is the argument this whole page exists to
make, so it would be a strange one to lose at the pointer.

**Undo is the same argument again, pointed at time.** There is no snapshot anywhere in this app.
A history of documents is the worst thing you could build on an IVM engine: restoring one tells
every view that everything changed, so every pipeline re-derives from scratch and undoing a
one-pixel nudge costs the whole drawing — the re-registration mistake the selection design
already refused, wearing a different hat. So a step here is a **delta**: the inverse of the
gesture you made, committed through the same `Writer.commit` funnel your hand uses. Nothing on
the page knows undo exists — the canvas's cells, the palette's `GROUP BY`, the layer join's
counts, the leaderboard, the feed and any pane you wrote yourself all just fold another write.
Undoing a 512-shape drag is 512 row-writes; undoing a 32,000-row confetti drop is 32,000 removes
in one commit; and `view-after-undo` follows the same live-query contract as every other write,
without a snapshot or refresh path.

Two details carry it. A step is a **gesture, not a commit** — the page commits once per frame, so
a drag is sixty commits that fold into one step (first-seen `before`, last-seen `after`, per
column). And an inverse is made of **columns, not rows**: the writer records which columns each
commit actually moved, so an undo puts yours back on top of whatever the row says now. The robots
are writing the whole time you are, and an undo that restored whole rows would silently revert
everything they had done to those rows in between — which is exactly what a second person in the
room would be doing, if this demo had one.

Things to do, in the order they teach:

1. **Grab a shape and drag it.** The HUD ticks writes/s and write→visible; the selection card's
   fields update live; the feed puts your shape on top.
1. **Drag a box around a handful of them and move the group.** Watch the selection panel's query
   while you brush: it does not change. Selection is a `selection` table and the card is an
   `EXISTS` over it, so sweeping the marquee writes one row per shape crossing the box's edge and
   the view folds those — the query is never re-registered. Then one drag writes the whole set in
   one commit per frame, and every query folds all of it. A selection is capped at 512 shapes,
   which the page says out loud when a brush covers more: dragging N shapes is N row-writes a
   frame, and that is the one selection cost that recurs.
2. **Keep dragging, past a cell boundary.** One live query sheds the row and its neighbour
   takes it, on the exact frame the center crosses — and you see nothing, which is the point.
   Nothing re-ran; one delta moved one row between two pipelines.
3. **Pan off the edge of the drawing, then zoom out.** The HUD's cell chip and the **viewport**
   panel are the whole infinite-canvas argument as numbers: the cell count stays flat while you
   pan, because only the edge of the subscription set churns. Watch the panel's "cooling off"
   figure as you go — a cell you left keeps folding for a grace period, so a jittery drag does
   not tear pipelines out and build them again, and its shapes stay in the painted count until
   it drops. Zooming out steps the **cell level** — a coarser column addresses bigger cells, so
   the count stays flat there too. That is the one camera move that is not incremental: a
   different column means every subscription is a different query, and the re-subscribe cost is
   visible when it happens.
4. **Resize a shape onto the leaderboard.** `area` is a maintained column; the board re-seats as
   you pull.
5. **Press "+2,000 shapes"** (each press doubles). One commit carries two thousand rows through
   every query; the status line prints what it cost. Past the first press a drop is a JOB rather
   than a transaction: it lands in **batches of 2,000, one per frame**, so a 32,000-row press is
   sixteen ordinary frames instead of one long stall. The engine's bill is the same rows either
   way — what batching buys is that the page keeps painting, panning and drawing while the pile
   grows, which is the claim the demo is here to make. Committing the whole pile at once is the
   one move on this page that would make an incremental engine behave like a batch one. The drop
   lands in the space you are **looking at**, so pan somewhere empty and fill it — on an
   unbounded canvas a fixed scatter box would put most of the base off screen forever.
6. **Hide the confetti layer** (the eye in the layers panel). ONE row-write on `layer` — and
   every gated view sheds tens of thousands of rows in the same commit, because the `exists`
   join fans that single edit out. Show it again: same single write, the other direction. This
   is what a join buys under IVM — a small write with a huge, exactly-derived consequence.
7. **Turn the robots up** (each press quadruples the write rate, up to 6,144 row-writes/s; one
   more press is off). This is the write axis, the one IVM's pitch lives on: the HUD's
   writes/s climbs 256× and write→visible p50 stays put, because maintained cost scales with
   the delta stream, not the base. Higher rates first spawn more robot-owned drifters — writes
   coalesce per row per frame, so a rate is only honest while the herd outnumbers a frame's
   budget — and they are minted **where you are looking**, like a confetti drop, so turning the
   writers up over an empty stretch of canvas shows you the writers rather than just a number.
   Each robot shape then roams its own neighbourhood; there is no world edge for it to bounce
   off, so the far side of the canvas is as alive as the opening scene.
8. **Undo something big.** Drag a group of shapes, or press "+2,000 shapes", then ⌘Z. The status
   line prints what the inverse delta was and what committing it cost — a count of row-writes,
   not a document, and the same write→visible the HUD reports for every other write. A batched
   drop is still ONE step, because a step is a gesture and you made one press: the frames it
   spanned fold into the same step the way a drag's sixty commits do. Then ⇧⌘Z.
   The robots' drift is deliberately not on the stack: ⌘Z is for what your hand did.
9. **Fork a panel and edit its query.** Narrow the feed's window, group by `kind` instead of
   `color`, invent a window nothing on the page subscribes — the engine hydrates
   your text as a new pipeline (timed, like every subscription) and folds every write into it
   from then on. `.select("color", "area")` masks the rows to just those columns (plus the
   primary key, which always rides along), and the pane renders exactly the projection.

## One honesty rule

Confetti rows never change (grabbing one first *promotes* it to a live row), so they paint from
a cached layer; live shapes paint per frame. The per-frame paint cost stays proportional to the
shapes that can actually move, so what you feel as the base and the write rate grow is the
engine's bill — never a rendering artifact.

The layer is maintained the way the views under it are: **incrementally**. Specks that arrive are
appended to the paths already traced, so a drop landing 2,000 rows a frame costs 2,000 traces on
each of those frames rather than re-tracing the whole pile around every batch. An O(base) bill for
an O(delta) change is precisely the mistake the engine spends its design refusing to make, and a
renderer is just as capable of making it. A speck *leaving* the layer — promoted, deleted, hidden
with its layer, carried out of the subscribed cells by a pan — still costs the pile, because a
`Path2D` has no way to drop a subpath; that is the one direction this cache cannot do
incrementally, and it is the rare one.

This is also why **the robots leave confetti alone** — the one category of shape they will not
touch. That cached layer is keyed on the pile's membership, not on where its specks are, so a
robot nudging one would leave it drawn at its old position; and re-keying the cache on position
would put a 64k-path re-trace on the frame every ambient write lands, which is exactly the
rendering artifact the layer exists to keep out of the demo's numbers. Confetti is the BASE axis
— it is meant to sit still and cost the queries something. Your hand is the one thing that brings
a speck to life: every write that changes anything the traced path encodes — a drag, a handle, an
arrow key, and a palette recolour, since the layer is one path *per colour* — promotes it out of
the layer first, which is what keeps the cache honest without the cache having to watch positions.

Writes are coalesced per frame — sixteen pointermoves between two paints commit as one edit with
the last position, which is what an app would write, and it keeps writes/s an honest count of
committed row-writes rather than mouse events. All commits serialize through one writer; two
in-flight commits would interleave at the `await`, hand the engine a stale `old` row, and
desynchronize the views — the browser smoke test caught exactly that on its first
run.

## Testing

The unit suite covers the scene, geometry, write coalescing, selection deltas, and undo/redo.
The browser smoke test builds the bundle and drives the real page through panning, zooming,
selection, gestures, layer visibility, custom panes, writes, and history. It also verifies that
the built bundle observes the live wasm heap as rows are added.

```sh
npm test
npm run test:browser
```

There is deliberately **no whole-drawing subscription** on the page. A live query over every row
in an unbounded drawing is the exact shape the cell design exists to avoid. The browser smoke
test instead verifies the observable behavior of the live subscriptions while it drives a real
wheel-pan, zoom, multi-select gesture, handle resize, rotation, duplicate, nudge, undo/redo,
pinch, and extent fit.

## Layout

```
src/
  schema.ts    three tables (shape, layer, selection) + the onLayer/layerShapes/onSelection
               relationships, the palette, the world constants
  cell.ts      the spatial columns: c0-c3, the zoom ladder, and a viewport's cell set
  scene.ts     the opening composition + confetti batches, deterministic
  mirror.ts    app-side rows (shapes, layers, selection), including every edit's `old` row
  queries.ts   the live Rindle queries
  geom.ts      the selection's geometry — oriented frames, the eight handles, the resize/rotate
               transforms, zoom-to-fit — pure functions over rows, so a gesture is testable
               without a pointer
  history.ts   undo/redo as INVERSE DELTAS, committed like any other write (no snapshots)
  custom.ts    your panes: query text evaled as the real builder
  write.ts     the single write funnel: coalesce → store.write (timed) → mirror, serialized
  bots.ts      the ambient writers: a write-rate dial from a murmur to ~6k row-writes/s
  app.ts       everything above wired together, headless — no DOM, so CI drives the same code;
               CellViews (the canvas's subscription set) lives here
  engine.ts    wasm boot + the live WebAssembly.Memory handle
  canvas.ts    renderer over query results + the pointer-gesture machine (tldraw's) + the camera
  main.ts      the page: one frame loop, panels, HUD
  metrics.ts   bounded sample rings, sliding rates
test/
  units.test.ts       scene determinism, coalescing (selection deltas included), marquee and
                      selection-box geometry, rotation, handle transforms, and undo behavior
  browser-smoke.mjs   the built page in real headless Chromium
  cdp.mjs             a dependency-free CDP harness
```

## The engine dependency

`@rindle/client` and `@rindle/wasm` are pinned to **exact** `0.10.2`, not `^0.10.2`, on purpose:
`@rindle/wasm` depends on `@rindle/client` exactly, so a floating range here would let the two
drift apart and install a second copy of the client — one instance building the schema, another
behind the `Store`. Bump both together.

`src/engine.ts` explains the other constraint worth knowing: the app imports `pkg/rindle.js`
directly (for the live `WebAssembly.Memory` handle) *and* through `@rindle/wasm`, and both
importers must land on the same ES module instance. `npm run test:browser` asserts it — the
wasm-heap reading has to move as rows go in, so a bundler resolving those two specifiers to two
instances fails the smoke test rather than silently reporting a wrong number.

## What this demo does not claim

- **It is not a synced app.** One tab, one engine, no server. The robots are local writers, not
  collaborators. The three-tier (browser IVM + API authority + daemon) story lives in the engine's
  own repo, not here.
- **It holds the rows twice** — once in wasm and once in the JS mirror used to build safe writes.
