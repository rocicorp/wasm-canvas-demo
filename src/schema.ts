// Three tables: the drawing, its layers, and what is selected. The demo's whole argument is
// about the READ side —
// every piece of UI on the page is a live query over these — so the schema stays as small as a
// drawing needs and no smaller:
//
//   * `area` is maintained on every resize (w × h at write time) because the leaderboard sorts on
//     it, and the engine sorts on columns, not on expressions. An app would do the same.
//   * `c0`–`c3` are maintained on every move, for the same reason and by the same rule: the
//     canvas is one query per visible cell, and the engine seeks on columns, not on expressions.
//   * `updated` is a logical clock bumped on every write to the row. It is what "recent" means
//     here, and what the feed's window orders by.
//   * `z` is paint order. Grabbing a shape raises it — an ordinary edit that the paint query
//     re-seats, which is the point: even "bring to front" is just a write some query folds.
//   * `who` names the writer (0 = you, 1+ = a robot, 9 = inert confetti) so the feed can say
//     whose write moved a row, and the robots can find their own shapes without a scan.
//   * `layer` points a shape at its `layer` row. Visibility lives on the LAYER — one row for
//     thousands of shapes — and the queries reach it through the `onLayer` relationship, which
//     is what makes hiding a layer a JOIN's fan-out instead of a mass update.

import { createSchema, number, rel, string, table } from "@rindle/client";

export const shapeTable = table("shape")
  .columns({
    id: number(),
    kind: string(), // "rect" | "ellipse" | "tri"
    x: number(), // center, world units (the world is WORLD_W × WORLD_H)
    y: number(),
    w: number(),
    h: number(),
    // Rotation about the centre, radians, `[0, 2π)`. A plain column like any other: the rotate
    // handle writes it, the painter and the hit test read it, and NOTHING derived has to move
    // because of it — `area` is w × h either way, and `c0`–`c3` come from the centre, which a
    // rotation about that centre does not touch. That is the whole reason rotation was cheap to
    // add here: it is orthogonal to every maintained column on the row.
    rot: number(),
    color: string(), // a PALETTE key
    z: number(), // paint order; raised on grab
    area: number(), // w × h, maintained on write — the leaderboard's ORDER BY
    updated: number(), // logical clock, bumped on every write to this row
    who: number(), // 0 = you · 1+ = robot id · 9 = confetti (inert)
    layer: number(), // → layer.id
    // The spatial columns: this shape's cell at each zoom level, from its centre (`cell.ts`).
    // The camera picks ONE of them per frame and the canvas subscribes a query per visible
    // cell, so `where.c1(id)` is what draws. A column per level rather than one packed column
    // because which cell matters is a function of the CAMERA, not of the shape.
    c0: number(),
    c1: number(),
    c2: number(),
    c3: number(),
  })
  .primaryKey("id");

export const layerTable = table("layer")
  .columns({
    id: number(),
    name: string(),
    visible: number(), // 0 | 1 — the one bit a layers panel eye toggles
  })
  .primaryKey("id");

/** What is selected: one row per selected shape, and nothing else.
 *
 *  A TABLE rather than a `selected` column on `shape`, for two reasons. The engine one: it keeps
 *  the selection query's ARGS constant — `where(exists(onSelection))` is registered once at boot
 *  and never again, so changing the selection is a delta the engine folds instead of a query it
 *  re-registers. (Encoding the selected ids into the query's args is the version of this that
 *  looks reasonable and is not: every change re-hydrates the whole pipeline, which on a marquee
 *  is a new subscription per frame.) The modelling one: selection is per-viewer, ephemeral
 *  state, and writing it onto the shared shape row is the shape of a bug in any app with a
 *  second person in it — two collaborators would fight over one column. Here it also keeps
 *  selecting off `shape.updated`, so the feed stays a feed of drawing, not of clicking. */
export const selectionTable = table("selection")
  .columns({
    shape: number(), // → shape.id
  })
  .primaryKey("shape");

export const schema = createSchema({ tables: [shapeTable, layerTable, selectionTable] });

/** shape.layer → layer.id — the EXISTS gate every painted query walks. */
export const onLayer = rel(shapeTable, layerTable, { layer: "id" });
/** layer.id → shape.layer — the layers panel's countAs direction. */
export const layerShapes = rel(layerTable, shapeTable, { id: "layer" });
/** shape.id → selection.shape — the EXISTS the selection query is. */
export const onSelection = rel(shapeTable, selectionTable, { id: "shape" });

export const LAYER_BACKDROP = 1;
export const LAYER_DRAWING = 2;
export const LAYER_CONFETTI = 3;

/** The seed layers, all visible. `name` is what the panel shows. */
export const LAYERS = [
  { id: LAYER_BACKDROP, name: "backdrop", visible: 1 },
  { id: LAYER_DRAWING, name: "drawing", visible: 1 },
  { id: LAYER_CONFETTI, name: "confetti", visible: 1 },
];

export type DrawSchema = typeof schema;
export type DrawCols = DrawSchema extends { __cols: infer C } ? C : never;

/** The fixed drawing plane, in world units. The canvas scales to fit it; shape coordinates are
 *  world coordinates, so the scene is the same scene in any window. */
export const WORLD_W = 1600;
export const WORLD_H = 1000;

export type Kind = "rect" | "ellipse" | "tri";
export const KINDS: Kind[] = ["rect", "ellipse", "tri"];

/** The palette. Color is a string COLUMN (`shape.color`), so the tally panel can be a real
 *  `GROUP BY color` aggregate; hex is presentation only. */
export const PALETTE: Array<{ key: string; hex: string }> = [
  { key: "coral", hex: "#ff6b6b" },
  { key: "amber", hex: "#ffb454" },
  { key: "lemon", hex: "#ffe66d" },
  { key: "mint", hex: "#4ecdc4" },
  { key: "sky", hex: "#59a5ff" },
  { key: "violet", hex: "#a78bfa" },
  { key: "pink", hex: "#f472b6" },
];

export const HEX = new Map(PALETTE.map((p) => [p.key, p.hex]));

/** Writer ids. */
export const YOU = 0;
export const CONFETTI_WHO = 9;
