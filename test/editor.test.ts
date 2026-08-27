// The pane editor's pure half (`src/editor.ts`): the tokenizer that colors both the built-in
// code blocks and the custom pane's overlay, and the completion engine's context detection —
// including the paren-depth scan that flips the column table inside a relationship lambda.
// The DOM half (overlay painting, the popup's keys) is exercised by using the page.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILDER_METHODS, completionContext, highlightQuery } from "../src/editor.ts";

// Schema order — the spatial cell columns (`c0`-`c3`) are ordinary queryable columns, so the
// pane editor offers them like any other: you can fork a panel into `q.shape.where.c1(...)`.
const SHAPE_COLS = ["id", "kind", "x", "y", "w", "h", "rot", "color", "z", "area", "updated", "who", "layer", "c0", "c1", "c2", "c3"];
const LAYER_COLS = ["id", "name", "visible"];

/** Option labels at the end of `text` (or at `caret`), null when no popup would show. */
function labels(text: string, caret = text.length): string[] | null {
  return completionContext(text, caret)?.options.map((o) => o.label) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------------------------

test("the highlighter classifies every token family and escapes html", () => {
  const html = highlightQuery(`const result = q.shape.where.color("coral").orderBy("area", "desc").limit(5) < ge\n// live view`);
  assert.match(html, /<i class="t-key">const<\/i>/, "language keywords read as keywords");
  assert.match(html, /<i class="t-fn">q<\/i>/, "the root is a fn token");
  assert.match(html, /<i class="t-col">shape<\/i>/, "schema names read as schema");
  assert.match(html, /<i class="t-m">where<\/i>/, "builder verbs read as api");
  assert.match(html, /<i class="t-str">"coral"<\/i>/);
  assert.match(html, /<i class="t-num">5<\/i>/);
  assert.match(html, /<i class="t-comment">\/\/ live view<\/i>/, "comments stay one muted token");
  assert.match(html, /&lt;/, "raw < is escaped");
});

// ---------------------------------------------------------------------------------------------
// Completion contexts
// ---------------------------------------------------------------------------------------------

test("q. offers the tables; a prefix narrows and moves `from`", () => {
  assert.deepEqual(labels("q."), ["shape", "layer", "selection"]);
  assert.deepEqual(labels("q.sh"), ["shape"]);
  assert.equal(completionContext("q.sh", 4)?.from, 2, "replace just the typed prefix");
});

test("a chain dot offers the builder methods; .where. offers the chain's columns", () => {
  assert.deepEqual(labels("q.shape."), BUILDER_METHODS);
  assert.deepEqual(labels(`q.shape.groupBy("color").count().`), BUILDER_METHODS, "after a call too");
  assert.deepEqual(labels("q.shape.where."), SHAPE_COLS);
  assert.deepEqual(labels("q.layer\n  .where."), LAYER_COLS, "multiline chains resolve the same");
});

test("a relationship lambda flips the table until its paren closes", () => {
  assert.deepEqual(labels("q.shape.where(exists(onLayer, l => l.where."), LAYER_COLS);
  assert.deepEqual(labels("q.shape.where(exists(onLayer, l => l.where.visible(1))).where."), SHAPE_COLS);
  assert.deepEqual(labels(`q.layer.countAs("inside", layerShapes, s => s.where.`), SHAPE_COLS);
});

test("string arguments complete where a column (or direction) belongs, and only there", () => {
  assert.deepEqual(labels(`q.shape.orderBy("a`), ["area"]);
  assert.deepEqual(labels(`q.shape.orderBy("area", "`), ["asc", "desc"]);
  assert.deepEqual(labels(`q.shape.groupBy("`), SHAPE_COLS);
  assert.deepEqual(labels(`q.shape.select("x", "c`), ["color", "c0", "c1", "c2", "c3"]);
  assert.equal(labels(`q.shape.where.color("cor`), null, "a value string is the visitor's own");
  assert.equal(labels(`q.layer.countAs("sh`), null, "the countAs label is the visitor's own");
});

test("an open paren offers what THAT call accepts, unprompted", () => {
  assert.deepEqual(labels("q.shape.where("), ["exists"], "the join gate is discoverable at .where(");
  assert.deepEqual(labels("q.shape\n  .where(  "), ["exists"], "whitespace after the paren is still the argument");
  assert.deepEqual(labels("q.shape.where(exists("), ["onLayer", "layerShapes", "onSelection"]);
  assert.deepEqual(labels("q.shape.where.x("), ["ge", "le"], "a column call takes the range helpers");
  assert.deepEqual(labels("q.shape.where(exists(onLayer, l => l.where.visible("), ["ge", "le"]);
  assert.equal(labels("q.shape.limit("), null, "a number argument has no offer");
});

test("the string-taking calls offer their columns pre-quoted, commas included", () => {
  const quoted = SHAPE_COLS.map((c) => `"${c}"`);
  assert.deepEqual(labels("q.shape.select("), quoted);
  assert.deepEqual(labels("q.shape.orderBy("), quoted);
  assert.deepEqual(labels(`q.layer.groupBy(`), LAYER_COLS.map((c) => `"${c}"`));
  assert.deepEqual(
    labels(`q.shape.select("x", `),
    quoted.filter((c) => c !== `"x"`),
    "a later argument drops the columns already taken",
  );
  assert.deepEqual(labels(`q.shape.orderBy("area", `), [`"asc"`, `"desc"`], "orderBy's second argument is the direction");
  assert.equal(labels(`q.shape.orderBy("area", "desc", `), null, "orderBy has no third argument");
  assert.equal(labels(`q.layer.groupBy("name", `), null, "groupBy takes one column");
  assert.deepEqual(labels("q.shape.select(co"), [`"color"`], "a raw prefix matches through the quotes");
});

test("bare identifiers offer the eval scope, once typing starts or on ctrl+space (force)", () => {
  assert.deepEqual(labels("q.shape.where(ex"), ["exists"]);
  assert.deepEqual(labels("q.shape.where(exists(on"), ["onLayer", "onSelection"]);
  const forced = completionContext("", 0, true);
  assert.deepEqual(
    forced?.options.map((o) => o.label),
    ["q", "exists", "ge", "le", "onLayer", "layerShapes", "onSelection"],
    "ctrl+space browses the whole scope with nothing typed",
  );
});

test("nothing useful, no popup", () => {
  assert.equal(labels(""), null);
  assert.equal(labels("q.shape.where.color"), null, "the prefix already IS the only match");
  assert.equal(labels("q.shape.limit(5."), null, "5. is a number, not a chain");
  assert.deepEqual(labels(`q.shape.orderBy("z", "asc")`, 2), ["shape", "layer", "selection"], "mid-text carets work");
});
