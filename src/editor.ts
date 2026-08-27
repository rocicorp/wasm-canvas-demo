// The code-as-text plane: one tiny tokenizer colors BOTH the built-in panels' code blocks and
// the custom pane's editor, and one pure context function drives the editor's completions.
//
// The editor itself is the classic overlay: the same `highlightQuery` output painted on a `pre`
// sitting behind a transparent-text textarea, so the pane the visitor types in IS the code block
// the built-ins display — same tokens, same colors. No editor dependency; the grammar is the
// fluent chain plus five helpers, and that's small enough to own.
//
// Completions are derived from the live objects, not a word list: table/column names come from
// `schema.tables`, the lambda-flipping relationships from the `SCOPE` map `evalQuery` actually
// passes (a relationship knows its child table), so the popup cannot offer a name the eval
// wouldn't resolve.

import { isRelationship, tableMeta } from "@rindle/client";

import { SCOPE } from "./custom.ts";
import { schema } from "./schema.ts";

// ---------------------------------------------------------------------------------------------
// Highlighting (moved here from main.ts so the overlay and the code blocks share it)
// ---------------------------------------------------------------------------------------------

/** Highlight a panel's query — the ACTUAL builder chain `query()` registers, not a SQL
 *  translation. The grammar is tiny (the fluent chain plus `ge`/`le`), so one tokenizing pass
 *  is the whole highlighter: strings, numbers, builder methods, and schema accessors — the
 *  last two split on membership, so `shape`/`x`/`color` read as YOUR schema, not as API. */
export const BUILDER_METHODS = ["where", "orderBy", "limit", "groupBy", "count", "countAs", "select"];
const METHOD_SET = new Set(BUILDER_METHODS);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function highlightQuery(code: string): string {
  // Tokenize the RAW text and escape per piece — escaping first would re-tokenize the entities,
  // and the overlay needs output glyphs to match input glyphs one-for-one for the caret to line up.
  let out = "";
  let last = 0;
  for (const m of code.matchAll(/"[^"]*"|\d+(?:\.\d+)?|[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    out += esc(code.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('"')) out += `<i class="t-str">${esc(tok)}</i>`;
    else if (/^\d/.test(tok)) out += `<i class="t-num">${tok}</i>`;
    else if (code[m.index - 1] !== ".") out += `<i class="t-fn">${tok}</i>`; // `q`, `ge`, `le`
    else out += METHOD_SET.has(tok) ? `<i class="t-m">${tok}</i>` : `<i class="t-col">${tok}</i>`;
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last));
}

// ---------------------------------------------------------------------------------------------
// The lexicon, read off the live objects
// ---------------------------------------------------------------------------------------------

/** table name → its column names, from the same schema the root queries. */
const TABLES = new Map(Object.entries(schema.tables).map(([name, m]) => [name, Object.keys(m.columns)]));

/** relationship name → the table its lambda ranges over (`exists(onLayer, l => …)` puts `l` on
 *  the rel's CHILD table). */
const RELS = new Map(
  Object.entries(SCOPE)
    .filter(([, v]) => isRelationship(v))
    .map(([name, v]) => [name, tableMeta((v as { child: Parameters<typeof tableMeta>[0] }).child).name]),
);

/** Every bare name the eval scope resolves, plus the root itself. */
const BARE: Option[] = [
  { label: "q", kind: "root" },
  ...Object.keys(SCOPE).map((label): Option => ({ label, kind: RELS.has(label) ? "rel" : "helper" })),
];

// ---------------------------------------------------------------------------------------------
// Context detection (pure — unit-tested in test/editor.test.ts)
// ---------------------------------------------------------------------------------------------

export interface Option {
  label: string;
  kind: "table" | "column" | "method" | "helper" | "rel" | "root" | "dir";
}

export interface Completions {
  /** Replace `[from, caret)` with the chosen label. */
  from: number;
  options: Option[];
}

const cols = (labels: readonly string[]): Option[] => labels.map((label) => ({ label, kind: "column" }));
const ALL_COLUMNS = [...new Set([...TABLES.values()].flat())];

/** What the pane's text could say next at `caret`. Null when there is nothing useful to offer —
 *  including "the prefix already IS the only match", so accepting never rewrites nothing.
 *  `force` (ctrl+space) waives the typed-prefix gate on the bare-identifier fallback, so the
 *  full scope is browsable anywhere; the argument positions below open with no prefix at all. */
export function completionContext(text: string, caret: number, force = false): Completions | null {
  const before = text.slice(0, caret);
  const prefix = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(before)?.[0] ?? "";
  const head = before.slice(0, before.length - prefix.length);
  const options = optionsFor(head, prefix !== "" || force);
  if (!options) return null;
  // Match through a label's quotes, so a raw `select(co` still narrows to `"color"` — and
  // accepting repairs the quoting.
  const matched = options.filter((o) => o.label.replace(/"/g, "").startsWith(prefix));
  if (matched.length === 0 || (matched.length === 1 && matched[0].label === prefix)) return null;
  return { from: caret - prefix.length, options: matched };
}

function optionsFor(head: string, typing: boolean): Option[] | null {
  // Inside a string literal (odd quote count) only the column-as-string argument spots
  // complete; everything else in quotes is the visitor's own text.
  if ((head.match(/"/g)?.length ?? 0) % 2 === 1) {
    if (/\.orderBy\(\s*"[^"]*"\s*,\s*"$/.test(head)) return [{ label: "asc", kind: "dir" }, { label: "desc", kind: "dir" }];
    if (/\.orderBy\(\s*"$/.test(head) || /\.(groupBy|select)\(\s*(?:"[^"]*"\s*,\s*)*"$/.test(head))
      return cols(chainColumns(head));
    return null;
  }
  if (head.endsWith(".")) {
    const dot = head.slice(0, -1);
    if (/\d$/.test(dot)) return null; // `5.` is a number, not a chain
    const recv = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(dot)?.[0];
    if (recv === "q") return [...TABLES.keys()].map((label): Option => ({ label, kind: "table" }));
    if (recv === "where") return cols(chainColumns(head));
    return BUILDER_METHODS.map((label): Option => ({ label, kind: "method" }));
  }
  // The string-taking calls complete BETWEEN quotes too: at `select(` (or after a completed
  // argument's comma) offer the columns pre-quoted, so accepting one lands the whole argument.
  const strCall = /\.(orderBy|groupBy|select)\(\s*((?:"[^"]*"\s*,\s*)*)$/.exec(head);
  if (strCall !== null) {
    const [, fn, prior] = strCall;
    const taken = [...prior.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (fn === "orderBy" && taken.length === 1)
      return [{ label: '"asc"', kind: "dir" }, { label: '"desc"', kind: "dir" }];
    if (taken.length === 0 || fn === "select")
      return chainColumns(head)
        .filter((c) => !taken.includes(c))
        .map((c): Option => ({ label: `"${c}"`, kind: "column" }));
    return null;
  }
  // An open paren is an unambiguous argument position: offer what THAT call accepts, unprompted
  // — this is how a visitor who doesn't know the lexicon discovers `exists` at `.where(`.
  const callee = /([A-Za-z_$][A-Za-z0-9_$]*)\(\s*$/.exec(head)?.[1];
  if (callee !== undefined) {
    if (callee === "where") return [{ label: "exists", kind: "helper" }];
    if (callee === "exists") return [...RELS.keys()].map((label): Option => ({ label, kind: "rel" }));
    if (chainColumns(head).includes(callee)) return [{ label: "ge", kind: "helper" }, { label: "le", kind: "helper" }];
  }
  // A bare identifier elsewhere: only once something is typed (or on ctrl+space) — the popup
  // must not chase every space and newline.
  return typing ? BARE : null;
}

/** The table the chain at the end of `head` ranges over — a paren-depth scan, because a
 *  relationship lambda (`exists(onLayer, l => …)`) flips the table until its `)` closes. */
function chainColumns(head: string): string[] {
  const toks = head.match(/"[^"]*"?|=>|[()]|\.|[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  let cur: string | null = null;
  const stack: Array<string | null> = [];
  let pendingRel: string | null = null;
  let prev = "";
  for (const t of toks) {
    if (t === "(") stack.push(cur);
    else if (t === ")") cur = stack.pop() ?? null;
    else if (t === "=>") {
      if (pendingRel !== null) cur = RELS.get(pendingRel) ?? cur;
      pendingRel = null;
    } else if (RELS.has(t)) pendingRel = t;
    else if (prev === "." && TABLES.has(t)) cur = t;
    prev = t;
  }
  return (cur !== null && TABLES.get(cur)) || ALL_COLUMNS;
}

// ---------------------------------------------------------------------------------------------
// The DOM half: overlay + popup, wired onto one pane's `.qwrap`
// ---------------------------------------------------------------------------------------------

/** The popup reuses the highlighter's token colors: an option looks like the token it becomes. */
const KIND_CLASS: Record<Option["kind"], string> = {
  table: "t-col",
  column: "t-col",
  rel: "t-col",
  method: "t-m",
  helper: "t-fn",
  root: "t-fn",
  dir: "t-str",
};

/** Wire highlighting + completion onto a custom pane's editor wrapper (`.qwrap` holding the
 *  `.qhl` pre, the `.qedit` textarea, and the `.qcomp` popup). Returns `paint` for the caller
 *  to run after it sets `value` programmatically (`input` covers everything typed). */
export function enhanceEditor(wrap: HTMLElement): { paint(): void } {
  const ta = wrap.querySelector<HTMLTextAreaElement>(".qedit")!;
  const hl = wrap.querySelector<HTMLElement>(".qhl")!;
  const box = wrap.querySelector<HTMLElement>(".qcomp")!;
  let opts: Option[] = [];
  let from = 0;
  let sel = 0;

  const paint = () => {
    // The trailing newline keeps a final empty line the same height the textarea gives it.
    hl.innerHTML = highlightQuery(ta.value) + "\n";
    hl.scrollTop = ta.scrollTop;
  };

  const close = () => {
    box.hidden = true;
    opts = [];
  };

  const render = () => {
    box.innerHTML = opts
      .map(
        // A pre-quoted label IS the string it becomes — paint it like one, whatever its kind.
        (o, i) =>
          `<div class="qopt${i === sel ? " sel" : ""}" data-i="${i}">` +
          `<i class="${o.label.startsWith('"') ? "t-str" : KIND_CLASS[o.kind]}">${o.label}</i>` +
          `<span>${o.kind}</span></div>`,
      )
      .join("");
    box.hidden = false;
    box.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };

  const refresh = (force = false) => {
    const ctx =
      ta.selectionStart === ta.selectionEnd ? completionContext(ta.value, ta.selectionStart, force) : null;
    if (!ctx) return close();
    opts = ctx.options;
    from = ctx.from;
    sel = 0;
    render();
  };

  const accept = (i: number) => {
    const o = opts[i];
    if (!o) return;
    const caret = ta.selectionEnd;
    ta.setSelectionRange(from, caret);
    // execCommand keeps the native undo stack; setRangeText is the (undo-breaking) fallback.
    if (!document.execCommand("insertText", false, o.label)) ta.setRangeText(o.label, from, caret, "end");
    close();
    paint();
  };

  ta.addEventListener("input", () => {
    paint();
    refresh();
  });
  ta.addEventListener("scroll", () => (hl.scrollTop = ta.scrollTop));
  ta.addEventListener("blur", close);
  ta.addEventListener("click", () => {
    if (!box.hidden) refresh(); // a caret move invalidates the popup's context
  });
  ta.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === " ") {
      e.preventDefault();
      refresh(true);
      return;
    }
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
      render();
    } else if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      accept(sel);
    } else if (e.key === "Enter") {
      close(); // ⌘↩ — fall through to the pane's subscribe with the popup gone
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      close();
    }
  });
  box.addEventListener("mousedown", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".qopt");
    if (!opt) return;
    e.preventDefault(); // keep focus (and the blur-close) off until the accept lands
    accept(Number(opt.dataset.i));
  });

  return { paint };
}
