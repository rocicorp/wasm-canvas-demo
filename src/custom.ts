// Your own panes: query text a visitor types, evaluated as the REAL fluent builder — no parser,
// no DSL. `new Function` hands the text the same root and helpers the built-in panes' `query()`
// closures close over, so what runs is exactly what a pane's code block shows. This is a
// client-only demo evaluating the visitor's own text in their own tab — not a security boundary
// — but it does mean a deployment with a CSP needs `unsafe-eval`.
//
// A custom pane has no hand-written JS oracle, so its differential is the other from-scratch
// path: subscribe the same text as a brand-new pipeline and compare the folded view against the
// fresh hydration. That is the product contract (`view-after-write == fresh-query`) checked by
// the engine's own from-scratch path — fold and hydrate are different code paths — rather than
// by an independent implementation; the built-ins keep the stronger mirror oracle.

import { exists, ge, le } from "@rindle/client";
import type { AnyQuery, ArrayView } from "@rindle/client";

import type { DrawStore } from "./engine.ts";
import type { QueryDef, ResultRow, Root } from "./queries.ts";
import { layerShapes, onLayer, onSelection } from "./schema.ts";

/** The lexicon a pane's text may use — exactly the names the built-in code blocks display.
 *  Exported because the pane editor's completions are derived from these same objects
 *  (`editor.ts`), so what the popup offers cannot drift from what `evalQuery` accepts. */
export const SCOPE = { exists, ge, le, onLayer, layerShapes, onSelection };
const NAMES = Object.keys(SCOPE) as Array<keyof typeof SCOPE>;

/** Evaluate query text against the live root. Throws (a SyntaxError, a builder error, or "not a
 *  query") — the caller turns that into the pane's inline error. */
export function evalQuery(code: string, q: Root): AnyQuery {
  const build = new Function("q", ...NAMES, `"use strict";\nreturn (\n${code}\n);`);
  const built: unknown = build(q, ...NAMES.map((n) => SCOPE[n]));
  if (!isQuery(built)) throw new Error("not a query — write a q.… builder chain");
  return built as AnyQuery;
}

function isQuery(v: unknown): v is AnyQuery {
  return typeof (v as { materialize?: unknown } | null)?.materialize === "function";
}

/** A `QueryDef` for user text: `query()` evals it, `recompute()` is the fresh-subscription
 *  oracle described above. */
export function makeCustomDef(name: string, code: string, store: DrawStore): QueryDef<void> {
  return {
    name,
    oracle: "resubscribe",
    code: () => code,
    query: (root) => evalQuery(code, root),
    recompute: () => {
      const view = evalQuery(code, store.query).materialize() as ArrayView<ResultRow>;
      try {
        // Snapshot into plain data that outlives the fresh view's destroy.
        return view.data.map((r) => plain(r) as ResultRow);
      } finally {
        view.destroy();
      }
    },
  };
}

function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = plain(val);
    return out;
  }
  return v;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
