// The differential: `view-after-write == fresh-query`.
//
// The engine's core contract is that the changes a view folds, applied in order, always equal
// running the query from scratch. This file is the "from scratch" half — and it is deliberately
// the DUMBEST possible implementation: no incrementality, no engine code, no shared operators.
// Just the shape's `recompute` over the JS mirror, and a structural compare.
//
// A mismatch here is a real finding, and the demo treats it as one: it names the shape, the key,
// and the first differing path, rather than incrementing a counter nobody can act on.

export interface Mismatch {
  /** JSON-ish path to the first difference, e.g. `[0].posts[2].score`. */
  path: string;
  view: unknown;
  fresh: unknown;
}

/** Structural compare of a folded view against a freshly computed result. Key ORDER is
 *  irrelevant (the engine's row objects and the oracle's spread literals need not agree on it);
 *  key SET and every value must match exactly. Returns the first difference, or null. */
export function diff(view: readonly unknown[], fresh: readonly unknown[]): Mismatch | null {
  return walk(view, fresh, "");
}

function walk(a: unknown, b: unknown, path: string): Mismatch | null {
  if (a === b) return null;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path, view: a, fresh: b };
    if (a.length !== b.length) return { path: `${path}.length`, view: a.length, fresh: b.length };
    for (let i = 0; i < a.length; i++) {
      const m = walk(a[i], b[i], `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }

  if (isRecord(a) && isRecord(b)) {
    // Compare the union of keys, so a key present on only one side is reported as a difference
    // rather than skipped.
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const m = walk(a[k], b[k], path ? `${path}.${k}` : k);
      if (m) return m;
    }
    return null;
  }

  return { path, view: a, fresh: b };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Render a mismatch for a card or a console line. */
export function describeMismatch(m: Mismatch): string {
  return `at ${m.path || "<root>"}: view ${short(m.view)} · fresh ${short(m.fresh)}`;
}

function short(v: unknown): string {
  if (v === undefined) return "<missing>";
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
