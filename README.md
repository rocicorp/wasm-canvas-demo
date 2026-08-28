# wasm-canvas-demo

An infinite drawing canvas that makes incremental view maintenance visible.

Every UI read is a live query over an in-tab WebAssembly engine. A component declares its data as a query. The query stays current as state changes.

**Query once → write state → every view is current.**

## UI = F(state)

### 01 / Declare the view

```ts
const recent = q.shape
  .where(exists(
    onLayer,
    (layer) => layer.where.visible(1)
  ))
  .orderBy("updated", "desc")
  .limit(8)
  .materialize();
```

The query does not fetch eight rows and then become stale. It creates a maintained view of the newest eight visible shapes.

The view stays current for as long as the component needs it.

### 02 / Render current state

```ts
function RecentWrites() {
  return recent.data.map((shape) =>
    row(shape.id, shape.kind, shape.updated)
  );
}
```

The component reads the current query rows. The binding schedules a render when the query changes.

Application code does not calculate the change or patch the collection. Initial loading and later maintenance use the same abstraction.

Once materialized, `recent.data` contains the current answer.

### 03 / Change state once

```ts
const mutators = {
  canvasFrame: shared(args, function* (tx, a) {
    for (const next of a.shapeUpdates) {
      yield tx.update("shape", next);
    }
  })
};

await mutate.canvasFrame({
  shapeUpdates: [{ id, x, y }]
});

// Every affected view is current here.
recent.data;
largest.data;
palette.data;
```

Dragging sends the shape’s primary key and its new coordinates. The application does not fetch or send the old row. During the same call, the client resolves the keyed update and the engine updates every affected query.

When the promise resolves, the next paint has the correct data.

### 04 / Let queries do the bookkeeping

```ts
const palette = q.shape
  .groupBy("color").count();

const largest = q.shape
  .orderBy("area", "desc").limit(6);

const recent = q.shape
  .orderBy("updated", "desc").limit(8);

const cell = q.shape
  .where.c1(cellId).orderBy("z", "asc");
```

One row can affect many derived views:

- A color change moves a count between palette groups.
- A size change can move a shape on the leaderboard.
- Any edit moves the shape to the top of the recent-writes view.
- A drag across a cell boundary moves the shape between canvas queries.

These are four declarations, not four update handlers.

### 05 / Model relationships, not effects

```ts
const visible = exists(onLayer,
  (layer) => layer.where.visible(1)
);

const painted = q.shape
  .where(visible)
  .orderBy("z", "asc");

await mutate.canvasFrame({
  layerUpdates: [{ id, visible: 0 }]
});
```

Shape visibility depends on layer visibility. One layer-row change updates every dependent query with the correct shapes.

Application code does not walk the shapes, clear caches, or notify panels. The relationship already describes the result.

### 06 / Change data, not query identity

```ts
const selected = q.shape
  .where(exists(onSelection))
  .orderBy("z", "asc")
  .materialize();

// Selection changes data, not the query.
await mutate.canvasFrame({
  selectionAdds: [id]
});
```

The selected IDs live in a table. A selection-box drag writes only the rows that cross its edge.

The query stays registered while selection data changes. The engine updates all affected views in the same transaction.

That is the full loop: declare what each component sees, then write what happened. The engine keeps the two connected.

## Run

```sh
npm install
npm run dev
```

Open `http://localhost:5173`.

The application is a static site. Run `npm run build` to create `dist/`.

## Test

```sh
npm test
npm run typecheck
npm run test:browser
```

The browser test builds the site and drives the real page in Chrome.

## Scope

This demo runs one engine in one browser tab. It does not include synchronization, collaboration, or a server.

The raw local WASM `Store` still consumes full old/new deltas internally. `src/write.ts` constructs
those only in its terminal engine adapter. The named mutator and its callers use keyed
`insert`/`update`/`delete` operations, matching the application-facing `@rindle/client` API.
