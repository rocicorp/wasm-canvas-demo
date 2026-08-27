// The page. One frame loop:
//
//   1. drain the canvas's gesture muts (coalesced) + the robots' tick → commit, ONE transaction
//      per writer per frame. `store.write` is synchronous-in-effect: when it resolves, every
//      affected view has already folded the delta.
//   2. aim: re-subscribe the cells the camera brought into view, drop the ones it left.
//   3. paint the canvas from the subscribed cells' CURRENT rows, panels from theirs.
//
// Everything the page displays comes out of `DrawApp` (no DOM in it), so the numbers on screen
// are the numbers `test/differential.e2e.ts` asserts on headlessly.

import wasmUrl from "rindle-wasm-bin?url";

import { CONFETTI_BATCH, DrawApp, MAX_SELECTION, type LiveQuery } from "./app.ts";
import { CanvasView, type Tool } from "./canvas.ts";
import { enhanceEditor, highlightQuery } from "./editor.ts";
import { aabbOf, frameOf, handlePoints } from "./geom.ts";
import type { ResultRow } from "./queries.ts";
import type { ShapeRow } from "./mirror.ts";
import { fmtInt, fmtMs, Samples } from "./metrics.ts";
import { CONFETTI_WHO, HEX, PALETTE, YOU } from "./schema.ts";
import type { Mut } from "./write.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const app = new DrawApp();
await app.boot(wasmUrl);
Object.assign(globalThis, { rindleDraw: app });

$("boot").hidden = true;
$("app").hidden = false;

// ---------------------------------------------------------------------------------------------
// Canvas / walkthrough — two readings of the same program
// ---------------------------------------------------------------------------------------------

let walkthroughOpen = false;
let walkThumbsDirty = false;
const walkthrough = $("walkthrough");
const body = $("body");
const foot = $("foot");
const viewTabs = [...document.querySelectorAll<HTMLButtonElement>(".viewtab")];

// The essay's snippets use the same small tokenizer as the live query panels. It is deliberately
// done from their text content: the HTML stays readable source, and the highlighter remains the
// single owner of token colours everywhere code appears on the page.
for (const source of document.querySelectorAll<HTMLElement>(".walk-source")) {
  source.innerHTML = highlightQuery(source.textContent ?? "");
}

function showView(view: "canvas" | "walkthrough", updateLocation = true): void {
  walkthroughOpen = view === "walkthrough";
  walkthrough.hidden = !walkthroughOpen;
  body.inert = walkthroughOpen;
  foot.inert = walkthroughOpen;
  $("app").classList.toggle("walk-mode", walkthroughOpen);
  for (const tab of viewTabs) {
    const on = tab.dataset.view === view;
    tab.classList.toggle("on", on);
    tab.setAttribute("aria-pressed", String(on));
  }
  if (walkthroughOpen) {
    walkThumbsDirty = true;
    walkthrough.scrollTop = 0;
    walkthrough.focus({ preventScroll: true });
  }
  if (updateLocation) {
    const next = walkthroughOpen ? "#walkthrough" : `${location.pathname}${location.search}`;
    history.replaceState(null, "", next);
  }
}

for (const tab of viewTabs) {
  tab.addEventListener("click", () => showView(tab.dataset.view === "walkthrough" ? "walkthrough" : "canvas"));
}
$("walk-open-demo").addEventListener("click", () => showView("canvas"));
showView(location.hash === "#walkthrough" ? "walkthrough" : "canvas", false);

// ---------------------------------------------------------------------------------------------
// Canvas + gestures
// ---------------------------------------------------------------------------------------------

/** Muts queued by the PAGE (palette recolor, delete key) — committed with the gesture muts. */
let extraMuts: Mut[] = [];

const canvas = new CanvasView($<HTMLCanvasElement>("canvas"), {
  // The canvas is no longer one query: it is one per visible cell, merged by z. `app.current`
  // is for a single view; this is the merge of however many the camera has subscribed.
  rows: () => app.cells.rows() as unknown as readonly ResultRow[],
  // The selection's own query — held independently of the camera, so a selection survives being
  // panned away from (see `queries.ts`).
  selectedRows: () => app.selectionRows(),
  selected: () => app.selected,
  draft: (kind, x, y, w, h, color, who) => app.writer.draft(kind, x, y, w, h, color, who),
  select: (ids) => selectAndReport(ids),
  toggle: (id) => void app.toggle(id),
  // One undo step per GESTURE, not per frame: the canvas says when a gesture starts and the
  // sixty commits it makes fold into that one step (`history.ts`).
  mark: (tag) => app.mark(tag),
});

/** Selecting, plus the one thing the app cannot say for itself: when a marquee covered more
 *  shapes than a selection may hold, the page says so instead of quietly selecting fewer.
 *
 *  Reported once per run of clamping, not once per pointermove — a brush dragged across a
 *  confetti drop clamps on every frame, and the status line is not a log. */
let clampSaid = 0;
function selectAndReport(ids: number[]): void {
  void app.select(ids);
  if (app.selectionClamped === 0) {
    clampSaid = 0;
    return;
  }
  if (app.selectionClamped === clampSaid) return;
  clampSaid = app.selectionClamped;
  say(
    `selection clamped to ${fmtInt(MAX_SELECTION)} shapes — the brush covered ` +
      `${fmtInt(app.selectionClamped)} more (an IN of N ids is N seeks, and a drag is N row-writes a frame)`,
  );
}
Object.assign(globalThis, { rindleCanvas: canvas });
// The browser smoke drives the selection's real handles, so it has to know where they are — via
// the same functions the canvas hit-tests with, never a copy of them.
Object.assign(globalThis, { rindleGeom: { frameOf, handlePoints, aabbOf } });

// ---------------------------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------------------------

const TOOLS: Array<{ tool: Tool; label: string; title: string }> = [
  {
    tool: "select",
    label: "grab",
    title:
      "select · shift-click to add · drag empty canvas to brush a group · eight handles scale, " +
      "the one above rotates (⇧ snaps) · ⌘D duplicates · arrows nudge (1 or V)",
  },
  {
    tool: "hand",
    label: "✋",
    title: "pan the camera — or hold space with any tool · two fingers pinch to zoom · ⇧1 fits the drawing, ⇧2 the selection (H)",
  },
  { tool: "rect", label: "▮", title: "draw rectangles (2 or R)" },
  { tool: "ellipse", label: "●", title: "draw ellipses (3 or O)" },
  { tool: "tri", label: "▲", title: "draw triangles (4)" },
];

const toolbar = $("tools");
for (const t of TOOLS) {
  const b = document.createElement("button");
  b.textContent = t.label;
  b.title = t.title;
  b.dataset.tool = t.tool;
  if (t.tool === canvas.tool) b.classList.add("on");
  b.addEventListener("click", () => setTool(t.tool));
  toolbar.appendChild(b);
}

function setTool(tool: Tool): void {
  canvas.tool = tool;
  for (const b of toolbar.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.tool === tool);
  }
}

// Each press doubles the drop (2k → 4k → 8k → 16k → 32k, then 32k a press), so "add shapes
// until you feel the difference" takes five clicks, not fifty. Capped where a tab stops being a
// demo and starts being a stress test.
//
// A press is not one commit any more: `addConfetti` lands it in batches of `CONFETTI_BATCH`, one
// per frame (see `app.ts`). Committing 32,000 rows at once is the one move on this page that
// makes an incremental engine behave like a batch one — the fold is honest work, but so is the
// confetti layer's re-trace and the paint behind it, and all of it on a single frame is a stall
// you can see. Dripping it keeps every frame a normal frame while the pile grows, which is the
// claim the demo is actually making.
const ROWS_CAP = 120_000;
let confettiDrop = 2000;
/** Rows asked for and not yet committed. They are already spoken for against the cap, so a
 *  second press while a drop is still landing cannot overshoot it. */
let dropping = 0;
const confettiBtn = $<HTMLButtonElement>("confetti");
confettiBtn.addEventListener("click", () => {
  // One drop at a time. The button is dark while one lands, so this is belt-and-braces — but the
  // invariant is a DATA one and the disabled attribute is only a DOM fact.
  if (dropping > 0) return;
  const want = Math.min(confettiDrop, ROWS_CAP - app.mirror.size - dropping);
  if (want <= 0) return;
  confettiDrop = Math.min(confettiDrop * 2, 32_000);
  let outstanding = want;
  dropping += outstanding;
  paintConfettiBtn();
  void (async () => {
    try {
      const { ms, rows, commits } = await app.addConfetti(want, canvas.viewport(), (b) => {
        outstanding -= b.rows;
        dropping -= b.rows;
        paintConfettiBtn();
        if (b.done < b.total) {
          say(
            `+${fmtInt(b.done)} of ${fmtInt(b.total)} rows so far — ${fmtInt(CONFETTI_BATCH)} a frame, ` +
              `each one folded into every query before the frame painted (${fmtMs(b.ms)} of engine time so far)`,
          );
        }
      });
      say(
        commits === 1
          ? `+${fmtInt(rows)} rows in ONE commit — every query folded it in ${fmtMs(ms)}`
          : `+${fmtInt(rows)} rows in ${commits} commits of ${fmtInt(CONFETTI_BATCH)}, one a frame — ` +
              `every query folded all of it in ${fmtMs(ms)} of engine time, and no frame carried the whole pile`,
      );
    } finally {
      // Whatever never landed (a batch that threw) stops holding a reservation against the cap.
      dropping -= outstanding;
      outstanding = 0;
      paintConfettiBtn();
    }
  })();
});
function paintConfettiBtn(): void {
  // Rows still in flight count against the cap. The two terms trade off as a drop lands — the
  // mirror grows by exactly what the reservation sheds — so the label holds still instead of
  // counting down and back up over the frames the job spans.
  const remaining = ROWS_CAP - app.mirror.size - dropping;
  if (remaining <= 0) {
    confettiBtn.textContent = "the tab is full";
    confettiBtn.disabled = true;
    return;
  }
  // Dark for the sixteen frames a drop takes. Two overlapping jobs would each commit
  // `CONFETTI_BATCH` rows on the SAME frame — the stall the batching exists to remove, arriving
  // twice as hard as the single commit it replaced — and their history steps would interleave,
  // so one ⌘Z would undo part of one press and part of another. The drop is short enough that
  // the button reads as pressed rather than as broken.
  confettiBtn.disabled = dropping > 0;
  confettiBtn.textContent = `+${fmtInt(Math.min(confettiDrop, remaining))} shapes`;
}
paintConfettiBtn();

// The write-rate dial. The confetti button grows the BASE the queries hold; this cranks the
// WRITE side: deltas folded per second. Same grammar as the confetti button — press until you
// feel it (spoiler: write→visible doesn't move). Capped
// where a frame's fold still costs ~3ms: the top rung must be the engine shrugging, and at 4×
// this rate the folds alone eat most of the frame budget (measured, not guessed).
const BOT_RATES = [24, 96, 384, 1536, 6144];
const botsBtn = $<HTMLButtonElement>("bots");
const paintBots = () =>
  (botsBtn.textContent = app.bots.enabled ? `robots: ${fmtInt(app.bots.perSec)}/s` : "robots: off");
paintBots();
botsBtn.addEventListener("click", () => {
  if (botsBtn.disabled) return; // a spawn commit is in flight
  const i = app.bots.enabled ? BOT_RATES.indexOf(app.bots.perSec) : -1;
  const next = i === BOT_RATES.length - 1 ? 0 : BOT_RATES[i + 1] ?? BOT_RATES[0];
  botsBtn.disabled = true;
  void app.setBotRate(next, canvas.viewport()).then(({ spawned }) => {
    botsBtn.disabled = false;
    paintBots();
    say(
      next === 0
        ? "robots off — the only writer left is you"
        : `robots now writing ${fmtInt(next)} rows/s` +
            (spawned > 0 ? ` (+${fmtInt(spawned)} drifters spawned here to carry the rate)` : "") +
            " — every write folds into every affected view",
    );
  });
});

/** Arrow-key nudge, in world units — tldraw's 1 and 10. */
const NUDGE = 1;
const NUDGE_SHIFT = 10;
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

document.addEventListener("keydown", (e) => {
  // Typing in a custom pane's editor is not a canvas gesture — a stray Backspace must not
  // delete the selected shape.
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  // The essay sits over a still-live canvas, but its keyboard belongs to the reader. Escape is
  // the one useful exception: it returns to the interactive view without letting the same key
  // clear the canvas selection underneath.
  if (walkthroughOpen) {
    if (e.key === "Escape") showView("canvas");
    return;
  }
  const k = e.key.toLowerCase();
  const cmd = e.metaKey || e.ctrlKey;

  // The clipboard-shaped keys first, so ⌘Z is never read as the `z` of a tool shortcut.
  if (cmd && k === "z") {
    e.preventDefault();
    void (e.shiftKey ? redo() : undo());
    return;
  }
  if (cmd && k === "y") {
    e.preventDefault();
    void redo();
    return;
  }
  if (cmd && k === "d") {
    e.preventDefault();
    void app.duplicate().then((res) => {
      if (!res) return;
      say(
        `duplicated ${fmtInt(res.rows)} shape${res.rows === 1 ? "" : "s"} in one commit (${fmtMs(res.ms)}) — ` +
          `⌘Z removes exactly those rows again`,
      );
    });
    return;
  }
  const arrow = ARROWS[e.key];
  if (arrow) {
    e.preventDefault();
    const d = e.shiftKey ? NUDGE_SHIFT : NUDGE;
    void app.nudge(arrow[0] * d, arrow[1] * d);
    return;
  }
  // ⇧1 fits the whole drawing, ⇧2 the selection — tldraw's pair. They come before the tool
  // digits, which are the same keys without shift.
  if (e.shiftKey && (e.key === "!" || e.key === "1")) {
    e.preventDefault();
    zoomToFit();
    return;
  }
  if (e.shiftKey && (e.key === "@" || e.key === "2")) {
    e.preventDefault();
    zoomToSelection();
    return;
  }

  // tldraw's letters alongside the demo's digits: V select, H hand, R rect, O ellipse.
  if (e.key === "1" || k === "v") setTool("select");
  else if (k === "h") setTool("hand");
  else if (e.key === "2" || k === "r") setTool("rect");
  else if (e.key === "3" || k === "o") setTool("ellipse");
  else if (e.key === "4") setTool("tri");
  else if (e.key === "Escape") void app.select([]);
  else if (k === "a" && cmd) {
    // Select all — of what the canvas is HOLDING, which on an unbounded drawing is the only
    // honest reading of "all": there is deliberately no whole-drawing subscription to ask.
    e.preventDefault();
    selectAndReport(app.cells.rows().map((r) => (r as unknown as ShapeRow).id));
    say(`selected ${fmtInt(app.selectedIds.length)} shapes — one query, one seek each`);
  } else if ((e.key === "Delete" || e.key === "Backspace") && app.selectedIds.length > 0) {
    app.mark("delete");
    for (const id of app.selectedIds) extraMuts.push({ op: "remove", id });
    void app.select([]);
  }
});

// ---------------------------------------------------------------------------------------------
// Undo / redo — the inverse delta, committed like any other write
// ---------------------------------------------------------------------------------------------

/** Both directions do the same thing, so they say it the same way: what the step was, how many
 *  row-writes its delta carried, and what the commit cost — which is the entire pitch. An undo
 *  is not a restore: no view re-ran, no query re-registered, and the number beside it is the
 *  same `store.write` wall time every other commit on this page reports. */
async function step(dir: "undo" | "redo"): Promise<void> {
  const done = dir === "undo" ? await app.undo() : await app.redo();
  paintHistory();
  if (!done) {
    say(dir === "undo" ? "nothing left to undo" : "nothing to redo");
    return;
  }
  say(
    `${dir === "undo" ? "undid" : "redid"} “${done.tag}” — ${fmtInt(done.rows)} row-write${done.rows === 1 ? "" : "s"} ` +
      `of ${dir === "undo" ? "inverse" : "forward"} delta, folded into every view in ${fmtMs(done.ms)}. No query re-ran.`,
  );
}

const undo = () => step("undo");
const redo = () => step("redo");

const undoBtn = $<HTMLButtonElement>("undo");
const redoBtn = $<HTMLButtonElement>("redo");
undoBtn.addEventListener("click", () => void undo());
redoBtn.addEventListener("click", () => void redo());

function paintHistory(): void {
  const { undo: u, redo: r } = app.history.depth;
  undoBtn.disabled = u === 0;
  redoBtn.disabled = r === 0;
  undoBtn.title = u === 0 ? "nothing to undo (⌘Z)" : `undo “${app.history.nextTag}” — ${u} step${u === 1 ? "" : "s"} (⌘Z)`;
  redoBtn.title = r === 0 ? "nothing to redo (⇧⌘Z)" : `redo — ${r} step${r === 1 ? "" : "s"} (⇧⌘Z)`;
}
paintHistory();

// ---------------------------------------------------------------------------------------------
// Zoom to fit / to selection
// ---------------------------------------------------------------------------------------------

function zoomToSelection(): void {
  const b = app.selectionBounds();
  if (!b) {
    say("⇧2 zooms to the selection — nothing is selected");
    return;
  }
  canvas.zoomToRect(b);
  say(`zoomed to ${fmtInt(app.selectedIds.length)} selected shape${app.selectedIds.length === 1 ? "" : "s"}`);
}

/** ⇧1. The drawing's extent is not something this page can look up — there is deliberately no
 *  whole-drawing subscription — so it is four `ORDER BY … LIMIT 1` queries, subscribed the first
 *  time you ask and maintained by the engine from then on. The first press pays a hydrate and
 *  says so; every press after it reads four one-row arrays. */
function zoomToFit(): void {
  const { rect, hydrateMs, fresh } = app.contentBounds();
  if (!rect) {
    say("nothing to fit — the drawing is empty");
    return;
  }
  canvas.zoomToRect(rect);
  say(
    fresh
      ? `zoom to fit: the drawing's extent is four ORDER BY … LIMIT 1 queries — subscribed in ${fmtMs(hydrateMs)}, ` +
          `maintained by the engine from here (⇧1 again is free)`
      : `zoom to fit — the extent was already maintained: four one-row views, no scan`,
  );
}

// ---------------------------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------------------------

interface Panel {
  title: string;
  note?: string;
  q: () => LiveQuery<unknown> | null;
  el: HTMLElement;
  body: HTMLElement;
  /** The highlighted code block — null for custom panes, whose textarea IS the code. */
  codeEl: HTMLElement | null;
  deltaEl: HTMLElement;
  renderedSeq: number;
  renderedCode: string;
  /** Show the hydrate time always (custom panes), not just for the re-subscribing pair. */
  alwaysHyd?: boolean;
  /** Repaint trigger for a panel whose subject is a SET of views rather than one: `live.seq`
   *  alone cannot see a cell joining or leaving. Defaults to `live.seq`. */
  seqOf?: () => number;
  render(rows: readonly ResultRow[], body: HTMLElement): void;
}

const panels: Panel[] = [];

function panelMarkup(title: string, note?: string): string {
  return (
    `<header><h2>${title}</h2><span class="ph-right"><span class="hyd"></span>` +
    `<button class="fork" title="fork — copy this query into a pane you can edit">fork</button>` +
    `<button class="check" title="recompute this query from scratch in plain JS and compare">✓</button></span></header>` +
    `<pre class="code"></pre>` +
    `<div class="pbody"></div>` +
    (note ? `<p class="note">${note}</p>` : "") +
    `<div class="delta"></div>`
  );
}

function panel(
  id: string,
  title: string,
  q: () => LiveQuery<unknown> | null,
  render: Panel["render"],
  note?: string,
): Panel {
  const host = $("rail");
  const el = document.createElement("section");
  el.className = "panel";
  el.id = `panel-${id}`;
  el.innerHTML = panelMarkup(title, note);
  host.appendChild(el);
  const p: Panel = {
    title,
    note,
    q,
    el,
    body: el.querySelector(".pbody")!,
    codeEl: el.querySelector(".code")!,
    deltaEl: el.querySelector(".delta")!,
    renderedSeq: -1,
    renderedCode: "",
    render,
  };
  wireCheck(el, q);
  el.querySelector(".fork")!.addEventListener("click", () => {
    const live = q();
    if (!live) {
      say("nothing to fork — select something first");
      return;
    }
    addCustomPane(live.def.code(live.args));
    say(`forked ${live.def.name} — edit the text; ⌘↩ subscribes the new query`);
  });
  panels.push(p);
  return p;
}

/** The ✓: this pane's differential, in front of you. The phrasing names which fresh half ran —
 *  the built-ins' independent JS recompute, or a custom pane's fresh subscription. */
function wireCheck(el: HTMLElement, q: () => LiveQuery<unknown> | null): void {
  el.querySelector(".check")!.addEventListener("click", () => {
    const live = q();
    if (!live) return;
    const { ok, ms } = live.check();
    const fresh = live.def.oracle === "resubscribe" ? "subscribed fresh" : "recomputed from scratch";
    say(
      ok
        ? `${live.def.name}: ${fresh} in ${fmtMs(ms)} — identical to the folded view (${live.checks} checks, ${live.mismatches} mismatches)`
        : `${live.def.name}: MISMATCH — ${live.lastMismatch ?? ""}`,
    );
    flash(el, ok ? "okflash" : "badflash");
  });
}

const asShape = (r: ResultRow) => r as unknown as ShapeRow;

function swatch(color: string): string {
  return `<i class="sw" style="background:${HEX.get(color) ?? "#888"}"></i>`;
}

function whoName(who: number): string {
  return who === YOU ? "you" : who === 9 ? "confetti" : `robot ${who}`;
}

// selection — an EXISTS over the `selection` table, registered once at boot. Selecting writes a
// row; this view folds it. The query text never changes, which is the point.
const selPanel = panel(
  "selection",
  "selection",
  () => app.sel as LiveQuery<unknown>,
  (rows, body) => {
    if (rows.length === 0) {
      body.innerHTML = `<p class="empty">click a shape, or drag a box around several — selecting writes a row, and this query folds it</p>`;
      return;
    }
    if (rows.length > 1) {
      // A set: the card stops being fields and becomes the set's own arithmetic, every number of
      // it folded out of the same query. Drag the group and all of them move at once.
      const shapes = rows.map(asShape);
      const area = shapes.reduce((t, s) => t + s.area, 0);
      const kinds = new Map<string, number>();
      for (const s of shapes) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
      body.innerHTML =
        `<div class="bignum">${fmtInt(shapes.length)} <small>shapes selected</small></div>` +
        `<div class="row">${[...kinds].map(([k, n]) => `${n} ${k}`).join(" · ")}</div>` +
        `<div class="row dim">${fmtInt(area)} total area · ` +
        `${fmtInt(new Set(shapes.map((s) => s.color)).size)} colours</div>` +
        `<div class="prow"><button class="ghost del-sel">delete ${fmtInt(shapes.length)} rows</button>` +
        `<span class="hint">no re-hydrate since boot</span></div>`;
      body.querySelector(".del-sel")?.addEventListener("click", () => {
        app.mark("delete");
        for (const id of app.selectedIds) extraMuts.push({ op: "remove", id });
        void app.select([]);
      });
      return;
    }
    const s = asShape(rows[0]);
    body.innerHTML =
      `<div class="fields">` +
      field("id", `#${s.id}`) +
      field("kind", s.kind) +
      field("color", `${swatch(s.color)}${s.color}`) +
      field("x", String(Math.round(s.x))) +
      field("y", String(Math.round(s.y))) +
      field("w", String(Math.round(s.w))) +
      field("h", String(Math.round(s.h))) +
      field("area", fmtInt(s.area)) +
      field("z", String(s.z)) +
      field("updated", `t${s.updated}`) +
      field("by", whoName(s.who)) +
      `</div>` +
      `<div class="prow"><button class="ghost del-sel">delete row</button>` +
      `<span class="hint">selecting wrote one row</span></div>`;
    body.querySelector(".del-sel")?.addEventListener("click", () => {
      app.mark("delete");
      for (const id of app.selectedIds) extraMuts.push({ op: "remove", id });
      void app.select([]);
    });
  },
  "selection is a TABLE, not a query argument — an EXISTS over it, registered once, so brushing a " +
    "marquee writes only the shapes crossing the box's edge instead of re-registering the query",
);

function field(k: string, v: string): string {
  return `<span class="f"><label>${k}</label><b>${v}</b></span>`;
}

/** The canvas's queries as the rail sees them: one representative view (they differ only in the
 *  cell id), and a seq that moves when ANY of them folds OR the subscribed set changes — a pan
 *  that adds a cell has to repaint the panel even though no single view folded. */
function leadCell(): LiveQuery<unknown> | null {
  return (app.cells.views.values().next().value ?? null) as LiveQuery<unknown> | null;
}

function cellSetSeq(): number {
  let seq = app.cells.views.size;
  for (const v of app.cells.views.values()) seq += v.seq;
  return seq;
}

// viewport — the camera IS the WHERE. There is no rect to drag any more: panning re-aims the
// subscription set, and this panel is that set reporting on itself. The chain below is ONE of the
// cell queries; the number is the union of all of them.
//
// The headline is "what the canvas is painting", NOT "what is on screen" — those differ, and the
// difference is the design: the cell set carries an overhang ring, and a cell you panned off
// stays subscribed through its grace period. Both are stated in the line under it rather than
// rounded away, because a number that quietly counts more than it claims is how a demo starts
// lying about the thing it exists to prove.
const viewportPanel = panel(
  "viewport",
  "viewport",
  leadCell,
  (_rows, body) => {
    const n = app.cells.rows().length;
    const subscribed = app.cells.views.size;
    const cooling = app.cells.coolingDown;
    body.innerHTML =
      `<div class="bignum">${fmtInt(n)} <small>shape${n === 1 ? "" : "s"} the canvas is painting</small></div>` +
      `<div class="row">${fmtInt(subscribed)} cell ${subscribed === 1 ? "query" : "queries"}` +
      (cooling > 0 ? ` · ${fmtInt(cooling)} cooling off` : "") +
      ` · level ${app.cells.level}</div>` +
      `<div class="row dim">${fmtInt(app.cells.subscribes)} subscribed · ${fmtInt(app.cells.teardowns)} torn down since boot</div>`;
  },
  "pan and both numbers move without one query re-running — the edge subscribes, the cells you left cool down and drop",
);
viewportPanel.seqOf = cellSetSeq;
viewportPanel.alwaysHyd = true; // what subscribing ONE cell cost — a seek, not a scan

// tally — the palette IS a GROUP BY
const tallyPanel = panel(
  "tally",
  "palette · tally",
  () => app.tally as LiveQuery<unknown>,
  (rows, body) => {
    const counts = new Map(rows.map((r) => [String((r as { color?: unknown }).color), Number((r as { count?: unknown }).count ?? 0)]));
    body.innerHTML =
      `<div class="chips">` +
      PALETTE.map(
        (p) =>
          `<button class="chip${canvas.brush === p.key ? " on" : ""}" data-color="${p.key}" title="paint with ${p.key}; recolors everything selected">` +
          `<i class="sw" style="background:${p.hex}"></i><b>${fmtInt(counts.get(p.key) ?? 0)}</b></button>`,
      ).join("") +
      `</div>`;
  },
  "each count is one row of the aggregate — recolor a shape and two of them move in the same commit",
);

tallyPanel.body.addEventListener("click", (ev) => {
  const chip = (ev.target as HTMLElement).closest(".chip") as HTMLElement | null;
  if (!chip?.dataset.color) return;
  canvas.brush = chip.dataset.color;
  const rows = app.selectionRows() as unknown as readonly ShapeRow[];
  if (rows.length > 0) app.mark("recolor");
  for (const s of rows) {
    // A recolour promotes a speck out of the cached layer exactly as a drag does
    // (`CanvasView.promote`). The layer is one path PER COLOUR, so which path a speck lives in
    // encodes its colour as surely as the vertices encode its position: recolour one in place and
    // the fingerprint does not move, `staticPlan` says "keep", and it goes on being filled in the
    // colour it used to be. Right in the query, wrong on the glass — and the differential, which
    // checks the query, would say nothing. The writer coalesces both patches into one edit.
    if (s.who === CONFETTI_WHO) extraMuts.push({ op: "set", id: s.id, patch: { who: YOU } });
    extraMuts.push({ op: "set", id: s.id, patch: { color: chip.dataset.color } });
  }
  tallyPanel.renderedSeq = -1; // repaint the chips' "on" state now
});

// layers — the JOIN: each row is a live countAs; the eye edits ONE layer row and the exists
// gate on every painted query fans that single write out to every shape on the layer.
const layersPanel = panel(
  "layers",
  "layers",
  () => app.layers as LiveQuery<unknown>,
  (rows, body) => {
    body.innerHTML = rows
      .map((r) => {
        const l = r as { id: number; name: string; visible: number; shapes: number };
        return (
          `<div class="row lrow${l.visible ? "" : " off"}">` +
          `<button class="eye" data-layer="${l.id}" title="${l.visible ? "hide" : "show"} — ONE row write; the join fans it out">${l.visible ? "👁" : "–"}</button>` +
          `<b>${l.name}</b><span class="num">${fmtInt(l.shapes)} shapes</span></div>`
        );
      })
      .join("");
  },
  "hide a layer: one row write on layer, and every query gated by the exists re-derives its membership in the same commit",
);

layersPanel.body.addEventListener("click", (ev) => {
  const eye = (ev.target as HTMLElement).closest(".eye") as HTMLElement | null;
  if (!eye?.dataset.layer) return;
  const id = Number(eye.dataset.layer);
  const l = app.mirror.getLayer(id);
  if (!l) return;
  app.mark("layer");
  extraMuts.push({ op: "layer", id, patch: { visible: l.visible ? 0 : 1 } });
  say(
    l.visible
      ? `hiding "${l.name}": one layer-row edit — watch how many rows leave the views`
      : `showing "${l.name}": one layer-row edit brings its shapes back into every gated view`,
  );
});

// top — the leaderboard
panel(
  "top",
  "largest",
  () => app.top as LiveQuery<unknown>,
  (rows, body) => {
    const max = rows.length > 0 ? asShape(rows[0]).area : 1;
    body.innerHTML = rows
      .map((r) => {
        const s = asShape(r);
        const pct = Math.max(4, Math.round((s.area / max) * 100));
        return (
          `<div class="row bar"><span class="barfill" style="width:${pct}%"></span>` +
          `${swatch(s.color)}#${s.id} ${s.kind} <span class="dim">${Math.round(s.w)}×${Math.round(s.h)}</span>` +
          `<span class="num">${fmtInt(s.area)}</span></div>`
        );
      })
      .join("");
  },
  "ordered by the maintained area column — grab a corner handle and resize a shape onto this board",
);

// recent — the feed
panel(
  "recent",
  "recent writes",
  () => app.recent as LiveQuery<unknown>,
  (rows, body) => {
    body.innerHTML = rows
      .map((r) => {
        const s = asShape(r);
        return `<div class="row">${swatch(s.color)}#${s.id} ${s.kind} · <span class="dim">t${s.updated}</span><span class="num">${whoName(s.who)}</span></div>`;
      })
      .join("");
  },
  "newest write first — whoever wrote last is on top; the robots never stop",
);

/** The essay renders the same panel component against the same maintained LiveQuery. These are
 *  extra DOM views, not extra subscriptions: no call here materializes or registers a query. */
interface WalkPaneView {
  source: Panel;
  el: HTMLElement;
  body: HTMLElement;
  codeEl: HTMLElement;
  deltaEl: HTMLElement;
  hydEl: HTMLElement;
  renderedSeq: number;
  renderedCode: string;
}

const walkPaneViews: WalkPaneView[] = [];
for (const frame of document.querySelectorAll<HTMLElement>("[data-walk-pane]")) {
  const source = panels.find((p) => p.el.id === `panel-${frame.dataset.walkPane ?? ""}`);
  if (!source) continue;
  const card = document.createElement("section");
  card.className = "panel walk-pane-card";
  card.innerHTML = panelMarkup(source.title, source.note);
  card.inert = true;
  card.setAttribute("aria-hidden", "true");
  frame.replaceChildren(card);
  walkPaneViews.push({
    source,
    el: card,
    body: card.querySelector(".pbody")!,
    codeEl: card.querySelector(".code")!,
    deltaEl: card.querySelector(".delta")!,
    hydEl: card.querySelector(".hyd")!,
    renderedSeq: -1,
    renderedCode: "",
  });
}

function renderWalkPaneViews(): void {
  for (const view of walkPaneViews) {
    const { source } = view;
    const live = source.q();
    if (!live) {
      if (view.renderedSeq !== -2) {
        view.renderedSeq = -2;
        view.codeEl.textContent = "";
        view.deltaEl.textContent = "";
        source.render([], view.body);
      }
      continue;
    }
    const seq = source.seqOf ? source.seqOf() : live.seq;
    if (!walkThumbsDirty && seq === view.renderedSeq) continue;
    if (view.renderedSeq >= 0 && seq !== view.renderedSeq) flash(view.el, "fold");
    view.renderedSeq = seq;
    const code = live.def.code(live.args);
    if (code !== view.renderedCode) {
      view.renderedCode = code;
      view.codeEl.innerHTML = highlightQuery(code);
    }
    source.render(app.current(live), view.body);
    view.deltaEl.textContent = live.lastDelta ? `last delta  ${live.lastDelta}` : "";
    view.hydEl.textContent = source.alwaysHyd ? `hydrated ${fmtMs(live.hydrateMs)}` : "";
  }
  walkThumbsDirty = false;
}

// ---------------------------------------------------------------------------------------------
// The canvas's own query, pinned to the canvas. Every rail panel shows its chain; the canvas is
// the flagship view, so its chain sits on the drawing it paints — flashing when the view folds,
// with the same ✓ every panel has. It ignores the pointer (the ✓ aside), so drawing under it
// still works.
// ---------------------------------------------------------------------------------------------

const canvasQ = $("canvasq");
const canvasDelta = canvasQ.querySelector<HTMLElement>(".delta")!;
const canvasCode = canvasQ.querySelector<HTMLElement>(".code")!;
// The canvas's chip shows ONE of the cell queries — they differ only in the cell id — with the
// live count beside it, because "the canvas is 40 of these" is the whole point.
wireCheck(canvasQ, () => (app.cells.views.values().next().value ?? null) as LiveQuery<unknown> | null);
let paintSeq = -1;
let canvasCodeShown = "";

// ---------------------------------------------------------------------------------------------
// Your own panes — fork any panel, or start from the template. The textarea IS the code pane:
// its text is evaled as the real builder (see custom.ts), ⌘↩ re-subscribes, a bad edit shows
// its error while the previous subscription keeps folding, and ✓ compares the folded view
// against a fresh subscription of the same text.
// ---------------------------------------------------------------------------------------------

const TEMPLATE = `q.shape\n  .where.color("coral")\n  .orderBy("area", "desc").limit(5)`;

const addBtn = document.createElement("button");
addBtn.id = "addpane";
addBtn.className = "ghost";
addBtn.textContent = "+ your own query";
addBtn.title = "open an editable pane — the engine subscribes whatever you write";
addBtn.addEventListener("click", () => addCustomPane(TEMPLATE));
$("rail").appendChild(addBtn);

function addCustomPane(code: string): void {
  const res = app.addCustom(code);
  if (!res.ok) {
    say(`that query didn't take: ${res.error}`);
    return;
  }
  const id = res.id;
  const el = document.createElement("section");
  el.className = "panel custom";
  el.id = `panel-yours-${id}`;
  el.innerHTML =
    `<header><h2>yours · ${id}</h2><span class="ph-right"><span class="hyd"></span>` +
    `<button class="check" title="subscribe this query fresh and compare against the folded view">✓</button>` +
    `<button class="xclose" title="tear this pipeline out">✕</button></span></header>` +
    `<div class="qwrap"><pre class="code qhl" aria-hidden="true"></pre>` +
    `<textarea class="qedit" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>` +
    `<div class="qcomp" hidden></div></div>` +
    `<div class="qerr"></div>` +
    `<div class="prow qactions"><button class="ghost apply">subscribe</button><span class="hint">⌃␣ completes · ⌘↩ applies</span></div>` +
    `<div class="pbody"></div>` +
    `<p class="note">✓ checks the folded view against a fresh subscription of the same query</p>` +
    `<div class="delta"></div>`;
  $("rail").insertBefore(el, addBtn);
  const ta = el.querySelector<HTMLTextAreaElement>(".qedit")!;
  const errEl = el.querySelector<HTMLElement>(".qerr")!;
  ta.value = code;
  fitEditor(ta);
  // Overlay highlighting + schema-aware completions; typing repaints via its own `input` hook.
  enhanceEditor(el.querySelector<HTMLElement>(".qwrap")!).paint();
  const p: Panel = {
    title: `yours · ${id}`,
    note: "✓ checks the folded view against a fresh subscription of the same query",
    q: () => app.customs.find((c) => c.id === id)?.live ?? null,
    el,
    body: el.querySelector(".pbody")!,
    codeEl: null,
    deltaEl: el.querySelector(".delta")!,
    renderedSeq: -1,
    renderedCode: "",
    alwaysHyd: true,
    render: renderGeneric,
  };
  panels.push(p);
  wireCheck(el, p.q);
  const apply = () => {
    const r = app.editCustom(id, ta.value);
    if (!r.ok) {
      errEl.textContent = r.error;
      el.classList.add("qbad");
      return;
    }
    errEl.textContent = "";
    el.classList.remove("qbad");
    fitEditor(ta);
    p.renderedSeq = -1; // the fresh view starts a new seq — force the repaint
    say(`yours · ${id}: subscribed in ${fmtMs(p.q()?.hydrateMs ?? 0)} — the engine folds its deltas from here on`);
    flash(el, "fold");
  };
  el.querySelector(".apply")!.addEventListener("click", apply);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  });
  el.querySelector(".xclose")!.addEventListener("click", () => {
    app.removeCustom(id);
    panels.splice(panels.indexOf(p), 1);
    el.remove();
  });
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  ta.focus();
}

function fitEditor(ta: HTMLTextAreaElement): void {
  ta.rows = Math.min(10, Math.max(3, ta.value.split("\n").length));
}

/** A custom pane's result, rendered without knowing the row shape: a count, then the first few
 *  rows — shape rows the way the built-ins draw them, anything else as key·value cells. */
const GENERIC_ROWS = 8;

function renderGeneric(rows: readonly ResultRow[], body: HTMLElement): void {
  body.innerHTML =
    `<div class="row dim">${fmtInt(rows.length)} row${rows.length === 1 ? "" : "s"}</div>` +
    rows.slice(0, GENERIC_ROWS).map((r) => `<div class="row generic">${genericRow(r)}</div>`).join("") +
    (rows.length > GENERIC_ROWS ? `<div class="row dim">… ${fmtInt(rows.length - GENERIC_ROWS)} more</div>` : "");
}

function genericRow(r: ResultRow): string {
  const rec = r as Record<string, unknown>;
  // The compact shape line only for FULL shape rows — a `.select`ed row is a projection, and
  // the projection is what the pane renders: every column the query asked for, nothing assumed.
  if (
    typeof rec.id === "number" &&
    typeof rec.kind === "string" &&
    typeof rec.color === "string" &&
    typeof rec.updated === "number" &&
    typeof rec.who === "number"
  ) {
    const s = asShape(r);
    return `${swatch(s.color)}#${s.id} ${s.kind} · t${s.updated} · ${whoName(s.who)}`;
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    const shown = typeof v === "number" ? fmtInt(v) : escHtml(String(v));
    const sw = k === "color" && HEX.has(String(v)) ? swatch(String(v)) : "";
    parts.push(`<span class="dim">${escHtml(k)}</span> ${sw}${shown}`);
  }
  return parts.join(" · ");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function flash(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
}

// ---------------------------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------------------------

let notice = "";
let noticeAt = 0;
function say(text: string): void {
  notice = text;
  noticeAt = performance.now();
}
say(
  "everything on this page — the canvas included — renders from live queries. Grab a shape, " +
    "or drag a box around several; space-drag pans.",
);

// ---------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------

// A small window on purpose: the fps chip should reflect the last second or two, not a median
// that takes a minute of slow frames to admit the page is struggling.
const frameDt = new Samples(80);
const spark = $<HTMLCanvasElement>("spark");
const sparkCtx = spark.getContext("2d")!;
const sparkRing: number[] = [];

let lastFrame = performance.now();
let lastHud = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = now - lastFrame;
  lastFrame = now;
  frameDt.add(dt);
  sparkRing.push(dt);
  if (sparkRing.length > 120) sparkRing.shift();

  // 1 — writes. One transaction per writer per frame; the Writer serializes commits internally,
  // so a burst never interleaves two store.write calls.
  const muts = [...canvas.drainMuts(), ...extraMuts];
  extraMuts = [];
  const botMuts = app.bots.enabled ? app.bots.tick(dt, now, canvas.dragging) : [];
  if (muts.length > 0) void app.commit(muts);
  // The robots' commit is NOT recorded: ⌘Z is for what your hand did, and a page where undo
  // stepped back through the ambient writers' drift would never reach your own last gesture.
  if (botMuts.length > 0) void app.commit(botMuts, false);

  // 2 — aim. The camera decides WHICH QUERIES EXIST: `lookAt` subscribes the cells that came
  // into view and drops the ones that left. Almost every frame this is a no-op — the set only
  // changes when the camera crosses a cell boundary or steps a zoom level — and when it does
  // change, only the edge moves. The interior of a pan costs nothing.
  app.lookAt(canvas.viewport(), canvas.zoom, now);

  // 3 — paint. (The differential is on demand only — every panel's ✓, or "check all now". A
  // from-scratch recompute is O(rows), the exact bill the engine exists to avoid, and the
  // headless e2e already enforces the contract after every commit.)
  canvas.render();

  // The canvas's query chip folds on the same beat as the canvas it describes.
  const lead = app.cells.views.values().next().value;
  const canvasSeq = lead ? cellSetSeq() : -1;
  if (canvasSeq !== paintSeq) {
    if (paintSeq >= 0) flash(canvasQ, "fold");
    paintSeq = canvasSeq;
    const code = lead?.def.code(lead.args) ?? "";
    if (code !== canvasCodeShown) {
      canvasCodeShown = code;
      canvasCode.innerHTML = highlightQuery(code);
    }
    canvasDelta.textContent = lead?.lastDelta ? `last delta  ${lead.lastDelta}` : "";
  }

  // 4 — panels & HUD; each panel repaints only when its view actually folded something.
  for (const p of panels) {
    const live = p.q();
    if (!live) {
      if (p.renderedSeq !== -2) {
        p.renderedSeq = -2;
        if (p.codeEl) p.codeEl.textContent = "";
        p.deltaEl.textContent = "";
        p.render([], p.body);
      }
      continue;
    }
    const seq = p.seqOf ? p.seqOf() : live.seq;
    if (seq === p.renderedSeq) continue;
    if (p.renderedSeq >= 0) flash(p.el, "fold");
    p.renderedSeq = seq;
    if (p.codeEl) {
      const code = live.def.code(live.args);
      if (code !== p.renderedCode) {
        p.renderedCode = code;
        p.codeEl.innerHTML = highlightQuery(code);
      }
    }
    p.render(app.current(live), p.body);
    p.deltaEl.textContent = live.lastDelta ? `last delta  ${live.lastDelta}` : "";
    const hyd = p.el.querySelector(".hyd") as HTMLElement;
    // Only the panels whose hydrate cost is a live number show one. The selection's is not: it
    // hydrated once, at boot, empty — selecting has not re-run it since.
    hyd.textContent = p.alwaysHyd ? `hydrated ${fmtMs(live.hydrateMs)}` : "";
  }

  if (walkthroughOpen) renderWalkPaneViews();

  drawSpark();
  if (now - lastHud > 200) {
    lastHud = now;
    hud(now);
  }
}
requestAnimationFrame(frame);

function drawSpark(): void {
  const w = spark.width;
  const h = spark.height;
  sparkCtx.clearRect(0, 0, w, h);
  const bw = w / 120;
  for (let i = 0; i < sparkRing.length; i++) {
    const dt = sparkRing[i];
    const frac = Math.min(dt, 50) / 50;
    sparkCtx.fillStyle = dt < 20 ? "#3ecf8e" : dt < 34 ? "#ffb454" : "#ff6b6b";
    sparkCtx.fillRect(i * bw, h - frac * h, Math.max(1, bw - 1), frac * h);
  }
}

function hud(now: number): void {
  const s = app.stats();
  paintHistory();
  $("hud-writes").textContent = `${fmtInt(s.writesPerSec)} writes/s`;
  $("hud-wv").textContent = Number.isFinite(s.writeVisibleP50)
    ? `write→visible ${fmtMs(s.writeVisibleP50)}`
    : "write→visible —";
  $("hud-rows").textContent = `${fmtInt(s.rows)} shapes`;
  // The canvas's own subscription count. This is the infinite-canvas claim as a number: it stays
  // flat while you pan, because only the edge churns, and a hydrate is a seek not a scan.
  $("hud-cells").textContent =
    `${fmtInt(s.cellsLive)} cells · L${s.cellLevel}` +
    (Number.isFinite(s.cellHydrateP50) ? ` · ${fmtMs(s.cellHydrateP50)}/cell` : "");
  // Median, not mean: one multi-second stall (a tab switch, a screenshot) would poison a mean
  // for the next 240 frames and read as a jank that never happened.
  const dtP50 = frameDt.quantile(0.5);
  $("hud-fps").textContent = Number.isFinite(dtP50) ? `${Math.round(1000 / dtP50)} fps` : "— fps";

  $("hud-fold").textContent =
    `last commit ${s.lastCommitRows} row${s.lastCommitRows === 1 ? "" : "s"} → all views in ${fmtMs(s.lastCommitMs)}`;

  const diff = $("difftotal");
  diff.innerHTML =
    s.mismatches === 0
      ? `<b class="good">${fmtInt(s.checks)} differential checks · 0 mismatches</b>`
      : `<b class="bad">${fmtInt(s.checks)} checks · ${fmtInt(s.mismatches)} MISMATCHES</b>`;

  // engineMsPerSec is ms of `store.write` wall time per second of wall clock — i.e. tenths of
  // a percent of the main thread. Rendered as the percent, which is the unit a reader has.
  $("memline").textContent =
    (s.wasmHeapBytes !== null ? `wasm heap ${(s.wasmHeapBytes / 1048576).toFixed(1)} MB · ` : "") +
    `${fmtInt(s.rows)} rows · engine ${(s.engineMsPerSec / 10).toFixed(1)}% of main thread` +
    // What history costs, when there is any: a step holds the rows its redo would have to put
    // back, and a confetti drop is 32,000 of them.
    (s.undoDepth + s.redoDepth > 0
      ? ` · history ${fmtInt(s.undoDepth + s.redoDepth)} steps / ${fmtInt(s.historyRows)} rows`
      : "");

  const st = $("status");
  st.textContent = notice && now - noticeAt < 8000 ? notice : "";
}

$("checkall").addEventListener("click", () => {
  const t0 = performance.now();
  const { checks, mismatches } = app.checkAll();
  say(
    `recomputed all ${checks} queries from scratch in ${fmtMs(performance.now() - t0)} — ` +
      `${mismatches} mismatches against the folded views`,
  );
});
