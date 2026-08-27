// Browser smoke test — the one thing the Node e2e cannot cover.
//
// `differential.e2e.ts` proves the ENGINE is right, in Node. This proves the PAGE works: the
// bundler-resolved wasm URL, `instantiateStreaming` over fetch, whether the production bundle
// keeps what the dev build ran — and (the load-bearing one) whether `engine.ts`'s heap probe and
// `@rindle/wasm`'s own `initWasm` resolve `pkg/rindle.js` to the SAME module instance once a
// bundler has had its way with them. That last one is verified by GROWTH: thousands of rows go
// in, and the probe's reading must move. A handle to some second, accidental instance would sit
// still and fail here rather than reporting a wrong number silently forever.
//
// No browser ⇒ skipped (exit 0), same convention as `@rindle/wasm`'s smoke test — EXCEPT where
// `RINDLE_BROWSER_REQUIRED` is set, which CI does. A lane whose whole job is to be the only place
// the gesture machine meets a real pointer must not be able to pass by finding no pointer at all:
// on a runner without a browser this is a failure to fix, not a test to skip.
//
//   npm run test:browser

import { access } from "node:fs/promises";
import { join } from "node:path";

import { DIST, launch, locateChromium, serve } from "./cdp.mjs";

function fail(msg) {
  process.stderr.write(`\n❌ ${msg}\n`);
  process.exitCode = 1;
}

const chromium = await locateChromium();
if (!chromium) {
  if (process.env.RINDLE_BROWSER_REQUIRED) {
    fail("no Chrome/Chromium found, and RINDLE_BROWSER_REQUIRED is set — install one or set CHROME_BIN");
    process.exit(1);
  }
  process.stdout.write("browser smoke: no Chrome/Chromium found (set CHROME_BIN) — skipped\n");
  process.exit(0);
}
try {
  await access(join(DIST, "index.html"));
} catch {
  fail("dist/index.html is missing — run `npm run build` first");
  process.exit(1);
}

const site = await serve(DIST);
const { cdp, stop } = await launch(chromium);

try {
  const url = `http://127.0.0.1:${site.port}/`;
  process.stdout.write(`browser smoke: ${chromium}\n  ${url}\n`);
  await cdp.navigate(url);

  if (!(await cdp.waitFor("globalThis.rindleDraw && globalThis.rindleDraw.ready", 60_000))) {
    const diag = await cdp.eval(`JSON.stringify({
      bootHidden: document.getElementById('boot')?.hidden,
      readyState: document.readyState,
    })`);
    process.stderr.write(`\n--- page state ---\n${diag}\n`);
    throw new Error("the demo did not boot within 60 s");
  }

  // Let the loop run: the robots write, the canvas paints.
  const report = await cdp.eval(`
    (async () => {
      const app = globalThis.rindleDraw;
      const heapBefore = app.stats().wasmHeapBytes;

      // A real user gesture, minus the pointer: move one seeded shape through the writer.
      const first = [...app.mirror.all()][0];
      await app.commit([{ op: "set", id: first.id, patch: { x: 123, y: 456 } }]);

      // Grow the base hard enough that the heap handle MUST move if it is the live instance.
      await app.addConfetti(2000);
      await app.addConfetti(2000);

      // Give the frame loop a moment (robots, panel paints).
      await new Promise((r) => setTimeout(r, 2500));

      // Pan the camera across several cell boundaries. The canvas must RE-AIM, not re-run: the
      // subscribed set changes, stays bounded, and every cell view stays exact. A real wheel
      // event, so the page's own input path is what drives it.
      const cv = document.getElementById('canvas');
      const cellsBeforePan = app.stats().cellsLive;
      const subsBeforePan = app.stats().cellSubscribes;
      for (let i = 0; i < 16; i++) {
        cv.dispatchEvent(new WheelEvent('wheel', { deltaX: 140, deltaY: 60, bubbles: true, cancelable: true }));
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 400));
      const afterPan = app.stats();
      const panSweep = app.checkAll();

      // And zoom out, which steps the level and re-addresses every cell.
      const levelBeforeZoom = app.stats().cellLevel;
      for (let i = 0; i < 20; i++) {
        cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 400));
      const afterZoom = app.stats();
      const zoomSweep = app.checkAll();

      const sweep = app.checkAll();
      const s = app.stats();
      const moved = app.mirror.get(first.id);
      return {
        rows: s.rows,
        heapBefore,
        heapAfter: s.wasmHeapBytes,
        writeVisibleP50: s.writeVisibleP50,
        writesPerSec: s.writesPerSec,
        checks: s.checks,
        mismatches: s.mismatches,
        sweepMismatches: sweep.mismatches,
        cellsBeforePan,
        cellsAfterPan: afterPan.cellsLive,
        panSubscribed: afterPan.cellSubscribes - subsBeforePan,
        panMismatches: panSweep.mismatches,
        levelBeforeZoom,
        levelAfterZoom: afterZoom.cellLevel,
        zoomMismatches: zoomSweep.mismatches,
        movedX: moved ? moved.x : null,
        panels: document.querySelectorAll('#rail .panel').length,
        canvasQ: document.querySelector('#canvasq .code')?.textContent ?? '',
        canvasPainted: (() => {
          const c = document.getElementById('canvas');
          return c && c.width > 0 && c.height > 0;
        })(),
        hudText: document.getElementById('hud-rows')?.textContent ?? '',
      };
    })()
  `);

  // The literate view is a second reading of this SAME running program. Opening it must expose
  // the paired code/prose layout without collapsing the canvas underneath (which would churn
  // cell subscriptions), and leaving it must return to the exact maintained query objects.
  const walkthrough = await cdp.eval(`
    (async () => {
      const app = globalThis.rindleDraw;
      const queryViews = app.queries().map((q) => q.view);
      const canvasRect = document.getElementById('canvas').getBoundingClientRect();
      document.querySelector('[data-view="walkthrough"]').click();
      await new Promise((r) => requestAnimationFrame(r));

      const essay = document.getElementById('walkthrough');
      const first = document.querySelector('.walk-step');
      const code = first.querySelector('.walk-code').getBoundingClientRect();
      const prose = first.querySelector('.walk-copy').getBoundingClientRect();
      const opened = {
        visible: !essay.hidden,
        mode: document.getElementById('app').classList.contains('walk-mode'),
        steps: document.querySelectorAll('.walk-step').length,
        paired: code.right < prose.left && Math.abs(code.top - prose.top) < 20,
        highlighted: !!first.querySelector('.walk-source .t-m'),
        bodyInert: document.getElementById('body').inert,
        canvasHeldSize: canvasRect.width > 0 && document.getElementById('canvas').getBoundingClientRect().width === canvasRect.width,
      };

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
      return {
        ...opened,
        closed: essay.hidden && !document.getElementById('body').inert,
        sameViews: queryViews.every((view, i) => app.queries()[i]?.view === view),
      };
    })()
  `);

  // The custom-pane flow, as clicks: fork a built-in, edit it, apply, break it, close it.
  const custom = await cdp.eval(`
    (async () => {
      const pick = (s) => document.querySelector(s);
      pick('#panel-tally .fork').click();
      const pane = pick('.panel.custom');
      const ta = pane?.querySelector('.qedit');
      const forkedCode = ta ? ta.value : null;

      ta.value = 'q.shape.groupBy("kind").count()';
      pane.querySelector('.apply').click();
      await new Promise((r) => setTimeout(r, 300)); // let the frame loop paint the new view
      const rowsText = pane.querySelector('.pbody')?.textContent ?? '';
      const errAfterGood = pane.querySelector('.qerr')?.textContent ?? '';

      pane.querySelector('.check').click(); // the fresh-subscription differential
      const sweep = globalThis.rindleDraw.checkAll();

      // A selection set: the pane renders exactly the selected columns (plus the riding pk).
      ta.value = 'q.shape.select("color", "area").orderBy("area", "desc").limit(3)';
      pane.querySelector('.apply').click();
      await new Promise((r) => setTimeout(r, 300));
      const selectText = pane.querySelector('.pbody')?.textContent ?? '';

      ta.value = 'q.shape.where.';
      pane.querySelector('.apply').click();
      const errAfterBad = pane.querySelector('.qerr')?.textContent ?? '';
      const stillLive = globalThis.rindleDraw.customs.length === 1;

      pane.querySelector('.xclose').click();
      return {
        forkedCode,
        rowsText,
        selectText,
        errAfterGood,
        errAfterBad,
        stillLive,
        sweepMismatches: sweep.mismatches,
        customsAfterClose: globalThis.rindleDraw.customs.length,
        paneGone: !document.querySelector('.panel.custom'),
      };
    })()
  `);

  // Multi-select, as real pointer gestures: brush a group out of the drawing, drag the group,
  // shift-click one more in, then check that space-drag still pans instead of brushing. This is
  // the only place the gesture machine runs against a real pointer, so it drives the events
  // rather than calling `app.select` — a hook wired to the wrong gesture has to fail here.
  const gestures = await cdp.eval(`
    (async () => {
      const app = globalThis.rindleDraw;
      const canvas = globalThis.rindleCanvas;
      const cv = document.getElementById('canvas');
      // Synthetic pointers have no capture to take; the page's own call would throw on them.
      cv.setPointerCapture = () => {};
      cv.releasePointerCapture = () => {};

      // The selection view must be the SAME object at the end of the session as at the start:
      // selecting writes rows, it does not re-register the query.
      const selQueryAtStart = app.sel;
      const selViewAtStart = app.sel.view;

      // The robots would move shapes out from under the assertions below.
      await app.setBotRate(0);
      await new Promise((r) => setTimeout(r, 120));

      const box = cv.getBoundingClientRect();
      const dpr = cv.width / box.width;
      const toClient = (wx, wy) => {
        const v = canvas.viewport();
        const z = canvas.zoom;
        return { clientX: box.left + ((wx - v.x0) * z) / dpr, clientY: box.top + ((wy - v.y0) * z) / dpr };
      };
      const send = (type, wx, wy, init = {}) => {
        const c = toClient(wx, wy);
        cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true, cancelable: true, ...c, ...init }));
      };
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const settle = async (n = 4) => { for (let i = 0; i < n; i++) await frame(); await new Promise((r) => setTimeout(r, 120)); };
      const covers = (s, r) => !(s.x + s.w / 2 < r.x0 || s.x - s.w / 2 > r.x1 || s.y + s.h / 2 < r.y0 || s.y - s.h / 2 > r.y1);
      const inView = () => app.cells.rows().filter((s) => covers(s, canvas.viewport()));
      // The page's own hit test, so the smoke knows what a pointerdown at a point will grab —
      // starting a "marquee" on top of a confetti speck is a click, and tests nothing.
      const topmostAt = (x, y) => {
        const rows = app.cells.rows();
        const p = 1 / canvas.zoom;
        for (let i = rows.length - 1; i >= 0; i--) {
          const s = rows[i];
          const hw = Math.max(s.w / 2, 4 * p);
          const hh = Math.max(s.h / 2, 4 * p);
          // In the SHAPE's frame — the page's hit test is, and a smoke that tested a different
          // one would grab shapes the page does not.
          const c = Math.cos(-(s.rot || 0));
          const sn = Math.sin(-(s.rot || 0));
          const ox = x - s.x;
          const oy = y - s.y;
          const dx = ox * c - oy * sn;
          const dy = ox * sn + oy * c;
          if (Math.abs(dx) > hw || Math.abs(dy) > hh) continue;
          if (s.kind === 'ellipse' && (dx / hw) ** 2 + (dy / hh) ** 2 > 1) continue;
          if (s.kind === 'tri' && dy < ((Math.abs(dx) / hw) * 2 - 1) * hh) continue;
          return s;
        }
        return null;
      };

      // The pan/zoom leg above left the camera far out and off the drawing. Put it back over
      // something to brush: 1:1, centred on a shape the canvas is still holding.
      canvas.zoomAt(1 / canvas.zoom, box.left + box.width / 2, box.top + box.height / 2);
      const anchorRow = app.cells.rows()[0] ?? [...app.mirror.all()][0];
      {
        const v = canvas.viewport();
        canvas.panBy(((v.x0 + v.x1) / 2 - anchorRow.x) * canvas.zoom, ((v.y0 + v.y1) / 2 - anchorRow.y) * canvas.zoom);
      }
      await settle(3);

      // Find a patch of the drawing with a few shapes in it, growing the box until it has some.
      const seed = inView()[0] ?? anchorRow;
      let half = 40;
      let rect = null;
      let expected = [];
      for (let i = 0; i < 14 && expected.length < 3; i++, half *= 1.6) {
        rect = { x0: seed.x - half, y0: seed.y - half, x1: seed.x + half, y1: seed.y + half };
        expected = app.cells.rows().filter((s) => covers(s, rect)).map((s) => s.id);
      }

      // The marquee has to START on empty canvas, or it is a click on whatever is under it —
      // which with thousands of confetti specks about is most points. Back the corner off until
      // nothing is under it, then take the box it actually swept.
      let start = { x: rect.x0, y: rect.y0 };
      for (let k = 0; k < 60 && topmostAt(start.x, start.y) !== null; k++) {
        start = { x: rect.x0 - k * 6, y: rect.y0 - k * 6 };
      }
      const swept = { x0: Math.min(start.x, rect.x1), y0: Math.min(start.y, rect.y1), x1: Math.max(start.x, rect.x1), y1: Math.max(start.y, rect.y1) };
      expected = app.cells.rows().filter((s) => covers(s, swept)).map((s) => s.id);

      // 1 — brush it. Dragging EMPTY canvas is the marquee now, not a pan.
      const vpBeforeBrush = canvas.viewport().x0;
      send('pointerdown', start.x, start.y);
      send('pointermove', (start.x + rect.x1) / 2, (start.y + rect.y1) / 2);
      await frame();
      send('pointermove', rect.x1, rect.y1);
      await frame();
      send('pointerup', rect.x1, rect.y1);
      await settle();
      const brushed = app.selectedIds.length;
      const brushedRows = app.sel.data.length; // the VIEW's own rows, not the intent-merged read
      const brushClamped = app.selectionClamped;
      const brushPanned = Math.abs(canvas.viewport().x0 - vpBeforeBrush) > 0.5;
      const cardText = document.querySelector('#panel-selection .pbody')?.textContent ?? '';
      const cardCode = document.querySelector('#panel-selection .code')?.textContent ?? '';

      // 2 — drag the group by grabbing ONE of its shapes: all of them move by the same delta.
      // The grab point must be one where the TOPMOST shape is itself in the selection, or the
      // plain click replaces the selection instead of keeping it (which is also correct).
      const before = app.selectionRows().map((r) => ({ id: r.id, x: r.x, y: r.y }));
      const grab = [...before].reverse().find((b) => {
        const top = topmostAt(b.x, b.y);
        return top && app.selected.has(top.id);
      }) ?? before[before.length - 1];
      send('pointerdown', grab.x, grab.y);
      send('pointermove', grab.x + 30, grab.y + 18);
      await frame();
      send('pointerup', grab.x + 30, grab.y + 18);
      await settle();
      const after = new Map(app.selectionRows().map((r) => [r.id, r]));
      let movedTogether = before.length > 1;
      for (const b of before) {
        const a = after.get(b.id);
        if (!a || Math.abs(a.x - (b.x + 30)) > 0.2 || Math.abs(a.y - (b.y + 18)) > 0.2) movedTogether = false;
      }

      // 3 — shift-click a shape outside the group adds it; shift-clicking it again takes it out.
      const outside = inView().find((s) => {
        const top = topmostAt(s.x, s.y);
        return top && top.id === s.id && !app.selected.has(s.id);
      });
      let added = null;
      let removed = null;
      if (outside) {
        send('pointerdown', outside.x, outside.y, { shiftKey: true });
        send('pointerup', outside.x, outside.y, { shiftKey: true });
        await settle(2);
        added = app.selectedIds.length;
        send('pointerdown', outside.x, outside.y, { shiftKey: true });
        send('pointerup', outside.x, outside.y, { shiftKey: true });
        await settle(2);
        removed = app.selectedIds.length;
      }

      // 4 — space-drag pans the camera and must NOT touch the selection.
      const selBeforePan = app.selectedIds.length;
      const vpBeforePan = canvas.viewport().x0;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      send('pointerdown', start.x, start.y);
      send('pointermove', start.x - 120, start.y);
      await frame();
      send('pointerup', start.x - 120, start.y);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
      await settle(2);
      const spacePanned = Math.abs(canvas.viewport().x0 - vpBeforePan) > 0.5;
      const selAfterPan = app.selectedIds.length;

      // 5 — the selection's own chrome, driven by a real pointer: a corner handle, the rotate
      // handle above the box, then the keyboard's ⌘D / arrows / ⌘Z / ⇧⌘Z, a two-finger pinch,
      // and ⇧1. Everything a hand can reach that no other lane can test.
      const geom = globalThis.rindleGeom;
      const handleReport = { resized: null, rotated: null, duplicated: null, nudged: null };

      // One unrotated shape big enough to have edge handles, so the frame IS the shape.
      const solo = inView().find((s) => {
        const top = topmostAt(s.x, s.y);
        return top && top.id === s.id && !s.rot && s.w > 24 && s.h > 24;
      }) ?? inView().find((s) => { const t = topmostAt(s.x, s.y); return t && t.id === s.id; });
      await app.select([solo.id]);
      await settle(2);

      // a — pull the SE corner out by 40 world units: the shape grows and its NW corner holds.
      {
        const s0 = { ...app.selectionRows()[0] };
        const f = geom.frameOf(app.selectionRows());
        const h = geom.handlePoints(f, 1 / canvas.zoom).find((p) => p.id === 'se');
        send('pointerdown', h.x, h.y);
        send('pointermove', h.x + 40, h.y + 40);
        await frame();
        send('pointerup', h.x + 40, h.y + 40);
        await settle();
        const s1 = app.selectionRows()[0];
        handleReport.resized = {
          grewW: s1.w - s0.w,
          grewH: s1.h - s0.h,
          anchorMoved: Math.abs((s1.x - s1.w / 2) - (s0.x - s0.w / 2)) + Math.abs((s1.y - s1.h / 2) - (s0.y - s0.h / 2)),
        };
      }

      // b — swing the rotate handle a quarter turn: it sits above the box, so dragging it to
      // the box's right side is +90°.
      {
        const f = geom.frameOf(app.selectionRows());
        const h = geom.handlePoints(f, 1 / canvas.zoom).find((p) => p.id === 'rotate');
        const r = Math.hypot(h.x - f.cx, h.y - f.cy);
        send('pointerdown', h.x, h.y);
        send('pointermove', f.cx + r, f.cy);
        await frame();
        send('pointerup', f.cx + r, f.cy);
        await settle();
        handleReport.rotated = app.selectionRows()[0].rot;
      }

      // c — ⌘D, then an arrow nudge, then ⌘Z twice and ⇧⌘Z once. The keyboard's whole surface.
      {
        const key = (k, init = {}) =>
          document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
        const rowsBefore = app.mirror.size;
        const idBefore = app.selectedIds[0];
        key('d', { metaKey: true });
        await settle();
        const copyId = app.selectedIds[0];
        handleReport.duplicated = { added: app.mirror.size - rowsBefore, isNew: copyId !== idBefore };

        const y0 = app.selectionRows()[0].y;
        key('ArrowUp');
        await settle();
        const y1 = app.selectionRows()[0].y;
        key('z', { metaKey: true }); // undo the nudge
        await settle();
        const y2 = app.selectionRows()[0].y;
        key('z', { metaKey: true }); // undo the duplicate
        await settle();
        const afterUndo = app.mirror.size;
        key('z', { metaKey: true, shiftKey: true }); // redo it
        await settle();
        handleReport.nudged = {
          moved: y0 - y1,
          undone: Math.abs(y2 - y0) < 0.001,
          copyRemoved: afterUndo === rowsBefore,
          copyBack: app.mirror.size === rowsBefore + 1,
        };
      }

      // d — two fingers: a pinch zooms and pans the camera together, and writes nothing.
      //
      // Both fingers land on EMPTY canvas with nothing selected, so "writes nothing" is a real
      // claim about the pinch rather than about where the fingers happened to fall: one finger
      // on a shape is a drag (as it should be), and one on empty canvas with a selection live
      // would clear it, which is also a write.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(2);
      const zoomBeforePinch = canvas.zoom;
      const rowsBeforePinch = app.writer.totalRows;
      {
        const touch = (type, id, cx, cy) =>
          cv.dispatchEvent(new PointerEvent(type, {
            pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true, clientX: cx, clientY: cy,
          }));
        // An empty patch of canvas, in client coordinates.
        let mid = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        for (let k = 0; k < 80; k++) {
          const v = canvas.viewport();
          const wx = v.x0 + ((mid.x - box.left) * dpr) / canvas.zoom;
          const wy = v.y0 + ((mid.y - box.top) * dpr) / canvas.zoom;
          if (topmostAt(wx, wy) === null && topmostAt(wx - 60 / canvas.zoom, wy) === null && topmostAt(wx + 60 / canvas.zoom, wy) === null) break;
          mid = { x: mid.x, y: mid.y + 7 };
        }
        touch('pointerdown', 11, mid.x - 60, mid.y);
        touch('pointerdown', 12, mid.x + 60, mid.y);
        touch('pointermove', 11, mid.x - 120, mid.y);
        touch('pointermove', 12, mid.x + 120, mid.y);
        await frame();
        touch('pointerup', 11, mid.x - 120, mid.y);
        touch('pointerup', 12, mid.x + 120, mid.y);
        await settle(2);
      }
      const pinch = { zoomed: canvas.zoom / zoomBeforePinch, wrote: app.writer.totalRows - rowsBeforePinch };

      // e — ⇧1: the extent queries subscribe on first use and join the differential sweep.
      // Count the EXTENT queries, not the whole sweep: fitting the view changes the camera, and
      // the camera changes how many cell queries are subscribed.
      const extentQueries = () => app.queries().filter((q) => q.def.name === 'extent').length;
      const queriesBeforeFit = extentQueries();
      const zoomBeforeFit = canvas.zoom;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', shiftKey: true, bubbles: true }));
      await settle(2);
      const fit = {
        newQueries: extentQueries() - queriesBeforeFit,
        zoomChanged: Math.abs(canvas.zoom - zoomBeforeFit) > 1e-9,
        holdsDrawing: (() => {
          const v = canvas.viewport();
          let inside = 0;
          let total = 0;
          for (const r of app.mirror.all()) {
            if (!app.mirror.visibleLayer(r.layer)) continue;
            total++;
            if (r.x >= v.x0 && r.x <= v.x1 && r.y >= v.y0 && r.y <= v.y1) inside++;
          }
          return total > 0 && inside === total;
        })(),
      };

      // 6 — Escape clears it, and the whole session still checks out.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(2);
      const cleared = app.selectedIds.length;
      const sweep = app.checkAll();

      return {
        expected: expected.length,
        brushed,
        brushedRows,
        brushClamped,
        brushPanned,
        cardText,
        cardCode,
        movedTogether,
        added,
        removed,
        spacePanned,
        selBeforePan,
        selAfterPan,
        cleared,
        handleReport,
        pinch,
        fit,
        undoDepth: app.history.depth.undo,
        resubscribes: (app.sel === selQueryAtStart ? 0 : 1) + (app.sel.view === selViewAtStart ? 0 : 1),
        selRowsAfterClear: app.selectionRows().length,
        mismatches: sweep.mismatches,
      };
    })()
  `);

  // The confetti layer's cache, as WORK DONE. A drop lands CONFETTI_BATCH rows a frame, and the
  // layer must append those to the paths it already holds rather than trace the pile again around
  // each batch — an O(base) bill per frame for an O(delta) change is the mistake the engine
  // underneath spends its whole design refusing to make, and it would be just as real made here.
  //
  // Then the part a counter cannot prove: the SAME PIXELS either way. The layer is hidden and
  // shown again, which throws every path away and builds them fresh, and the canvas must come
  // back byte-identical to the one that was appended to a batch at a time. A speck missed by an
  // append, or traced twice, is a different picture — and nothing else on the page would say so,
  // because the QUERY was right the whole time.
  const layer = await cdp.eval(`
    (async () => {
      const app = globalThis.rindleDraw;
      const cv = globalThis.rindleCanvas;
      const el = document.getElementById('canvas');
      const frames = (n) => new Promise((r) => { let i = 0; const t = () => (++i >= n ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      // A moving picture cannot be compared with itself: the ambient writers have to stop.
      await app.setBotRate(0);
      await frames(3);
      const hash = () => {
        const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) { h ^= d[i] + d[i+1] * 7 + d[i+2] * 13 + d[i+3] * 17; h = Math.imul(h, 16777619); }
        return h >>> 0;
      };
      const still = hash();
      await frames(3);
      const stillAgain = hash();

      const before = { ...cv.staticWork };
      const drop = await app.addConfetti(8000);
      await frames(3);
      const after = { ...cv.staticWork };
      const appended = hash();

      await app.commit([{ op: 'layer', id: 3, patch: { visible: 0 } }], false);
      await frames(3);
      const hidden = hash();
      await app.commit([{ op: 'layer', id: 3, patch: { visible: 1 } }], false);
      await frames(3);
      const rebuilt = hash();

      // A speck EDITED without being dragged. The layer knows which specks it holds, never where
      // they are, so every gesture that moves one has to promote it out of the layer first — an
      // arrow key as much as a drag. If it does not, the pile goes on painting the speck where it
      // used to be, and only the pixels would ever say so.
      const speck = app.cells.rows().find((r) => r.who === 9);
      let nudged = 0, nudgedFresh = 0, promoted = null;
      if (speck) {
        await app.select([speck.id]);
        await app.nudge(300, 300);
        await frames(3);
        nudged = hash();
        promoted = app.mirror.get(speck.id)?.who ?? null;
        await app.commit([{ op: 'layer', id: 3, patch: { visible: 0 } }], false);
        await frames(3);
        await app.commit([{ op: 'layer', id: 3, patch: { visible: 1 } }], false);
        await frames(3);
        nudgedFresh = hash();
        await app.select([]);
      }

      // The same rule through the PAGE's write path rather than the app's, and for a write that
      // neither moves nor reshapes anything. The layer is one path PER COLOUR, so which path a
      // speck was traced into encodes its colour exactly as the vertices encode its position: a
      // recolour in place leaves the fingerprint unmoved, staticPlan says "keep", and the speck
      // goes on being filled in the colour it used to be. The chip is clicked for real — this
      // exercises the handler in main.ts, which is the one that got it wrong.
      const speck2 = app.cells.rows().find((r) => r.who === 9);
      let recolored = null, recoloredWho = null, recoloredHash = 0, recoloredFresh = 0;
      if (speck2) {
        const chips = [...document.querySelectorAll('#panel-tally .chip')];
        const chip = chips.find((c) => c.dataset.color !== speck2.color);
        await app.select([speck2.id]);
        chip.click();
        await frames(3);
        const row = app.mirror.get(speck2.id);
        recolored = row ? row.color : null;
        recoloredWho = row ? row.who : null;
        recoloredHash = hash();
        await app.commit([{ op: 'layer', id: 3, patch: { visible: 0 } }], false);
        await frames(3);
        await app.commit([{ op: 'layer', id: 3, patch: { visible: 1 } }], false);
        await frames(3);
        recoloredFresh = hash();
        await app.select([]);
      }

      return {
        speck: speck ? speck.id : null,
        promoted,
        nudged,
        nudgedFresh,
        speck2: speck2 ? speck2.id : null,
        wasColor: speck2 ? speck2.color : null,
        recolored,
        recoloredWho,
        recoloredHash,
        recoloredFresh,
        stable: still === stillAgain,
        commits: drop.commits,
        rebuilds: after.rebuilds - before.rebuilds,
        appends: after.appends - before.appends,
        traced: after.traced - before.traced,
        held: after.held,
        appended, hidden, rebuilt,
        mismatches: app.checkAll().mismatches,
      };
    })()
  `);

  // ONE drop at a time, as the button. Two jobs landing at once would each commit CONFETTI_BATCH
  // rows on the SAME frame — twice the stall the batching exists to remove — and their history
  // steps would interleave, so a single ⌘Z would undo part of one press and part of another.
  // Three clicks in a row must land exactly one drop's worth.
  const drop = await cdp.eval(`
    (async () => {
      const app = globalThis.rindleDraw;
      const btn = document.getElementById('confetti');
      const want = Number((btn.textContent.match(/[0-9,]+/) || ['0'])[0].replace(/,/g, ''));
      const before = app.mirror.size;
      btn.click();
      const armed = btn.disabled; // dark on the same tick the press lands, before a frame passes
      btn.click();
      btn.click();
      for (let i = 0; i < 400 && btn.disabled; i++) await new Promise((r) => setTimeout(r, 25));
      // …and then a settle window, so a run where the presses DID overlap is caught by the row
      // count rather than by the loop above exiting on the first tick and measuring nothing.
      await new Promise((r) => setTimeout(r, 500));
      return { want, armed, released: btn.disabled, landed: app.mirror.size - before };
    })()
  `);

  process.stdout.write(
    `  ${report.rows} rows · wasm heap ${fmtMB(report.heapBefore)} → ${fmtMB(report.heapAfter)}\n` +
      `  write→visible p50 ${report.writeVisibleP50.toFixed(2)} ms\n` +
      `  differential ${report.checks} checks, ${report.mismatches} mismatches\n` +
      `  walkthrough: ${walkthrough.steps} paired code/prose sections, same live query objects on return\n` +
      `  custom pane: forked, edited, broke, closed — ${JSON.stringify(custom.rowsText)}\n` +
      `  multi-select: brushed ${gestures.brushed} of ${gestures.expected}, dragged as a group, ` +
      `shift-click ${gestures.added}→${gestures.removed}, space-pan kept ${gestures.selAfterPan}, ` +
      `${gestures.resubscribes} re-subscriptions\n` +
      `  handles: +${gestures.handleReport.resized.grewW.toFixed(1)}w on the corner, ` +
      `rotated to ${((gestures.handleReport.rotated * 180) / Math.PI).toFixed(0)}°, ` +
      `⌘D +${gestures.handleReport.duplicated.added} row, ⌘Z/⇧⌘Z round-tripped, ` +
      `pinch ×${gestures.pinch.zoomed.toFixed(2)}, ⇧1 subscribed ${gestures.fit.newQueries} extent queries\n` +
      `  confetti layer: ${layer.commits} batches appended ${layer.traced} specks in ` +
      `${layer.appends} appends / ${layer.rebuilds} re-traces into a layer holding ${layer.held}\n` +
      `  one drop at a time: 3 presses landed ${drop.landed} rows (one drop is ${drop.want})\n`,
  );

  if (!(report.rows > 4200)) fail(`expected the seeded scene plus 4,000 confetti, got ${report.rows} rows`);
  if (report.movedX !== 123) fail(`the scripted drag did not land (x = ${report.movedX})`);
  if (report.mismatches > 0) fail(`${report.mismatches} differential mismatches in the browser`);
  if (report.sweepMismatches > 0) fail(`${report.sweepMismatches} mismatches on the full sweep`);
  if (!(report.checks > 0)) fail("the differential never ran");
  if (!(report.writeVisibleP50 > 0)) fail("no write→visible samples — nothing was written");
  if (report.panels !== 6) fail(`expected 6 panels, got ${report.panels}`);
  if (!/orderBy\("z", "asc"\)/.test(report.canvasQ)) {
    fail(`the canvas is not showing its own query: ${JSON.stringify(report.canvasQ)}`);
  }
  if (!walkthrough.visible || !walkthrough.mode || !walkthrough.closed) {
    fail(`the walkthrough did not open and close cleanly: ${JSON.stringify(walkthrough)}`);
  }
  if (walkthrough.steps !== 6 || !walkthrough.paired) {
    fail(`the walkthrough is not six paired code/prose sections: ${JSON.stringify(walkthrough)}`);
  }
  if (!walkthrough.highlighted) fail("the walkthrough source was not syntax highlighted");
  if (!walkthrough.bodyInert) fail("the canvas remained keyboard-accessible behind the walkthrough");
  if (!walkthrough.canvasHeldSize) fail("opening the walkthrough collapsed the canvas underneath it");
  if (!walkthrough.sameViews) fail("opening the walkthrough replaced a maintained query view");
  if (!/groupBy\("color"\)/.test(custom.forkedCode ?? "")) {
    fail(`the fork did not seed the tally's code: ${JSON.stringify(custom.forkedCode)}`);
  }
  if (!/3 rows/.test(custom.rowsText) || !/kind/.test(custom.rowsText)) {
    fail(`the edited pane did not render the kind aggregate: ${JSON.stringify(custom.rowsText)}`);
  }
  if (custom.errAfterGood !== "") fail(`a good edit showed an error: ${JSON.stringify(custom.errAfterGood)}`);
  if (!/3 rows/.test(custom.selectText) || !/color/.test(custom.selectText) || !/area/.test(custom.selectText)) {
    fail(`the select pane did not render the projection: ${JSON.stringify(custom.selectText)}`);
  }
  if (/kind|updated|robot/.test(custom.selectText)) {
    fail(`the select pane rendered columns outside the selection: ${JSON.stringify(custom.selectText)}`);
  }
  if (!custom.errAfterBad) fail("a broken edit showed no error");

  // -- the multi-select gestures ---------------------------------------------------------------
  const MAX_SELECTION = 512; // mirrors src/app.ts
  if (gestures.expected < 3) fail(`the smoke could not find a patch of drawing to brush (${gestures.expected} shapes)`);
  const wantBrushed = Math.min(gestures.expected, MAX_SELECTION);
  if (gestures.brushed !== wantBrushed) {
    fail(`the marquee selected ${gestures.brushed}, expected ${wantBrushed} of ${gestures.expected}`);
  }
  if (gestures.brushedRows !== gestures.brushed) {
    fail(`the selection view folded ${gestures.brushedRows} rows for ${gestures.brushed} selected ids`);
  }
  if (gestures.expected > MAX_SELECTION && gestures.brushClamped !== gestures.expected - MAX_SELECTION) {
    fail(`the clamp did not report what it dropped (${gestures.brushClamped})`);
  }
  if (gestures.brushPanned) fail("dragging empty canvas panned the camera — it must brush a selection");
  if (!/shapes selected/.test(gestures.cardText)) {
    fail(`the selection card did not render the set: ${JSON.stringify(gestures.cardText)}`);
  }
  if (!/exists\(onSelection\)/.test(gestures.cardCode)) {
    fail(`the selection panel is not showing the EXISTS query it registered: ${JSON.stringify(gestures.cardCode)}`);
  }
  if (gestures.resubscribes !== 0) {
    fail(`the selection query re-subscribed ${gestures.resubscribes} times — selecting must be a write it FOLDS`);
  }
  if (!gestures.movedTogether) fail("dragging one selected shape did not move the whole selection with it");
  if (gestures.added !== null && gestures.added !== gestures.brushed + 1) {
    fail(`shift-click added ${gestures.added - gestures.brushed} shapes, expected 1`);
  }
  if (gestures.removed !== null && gestures.removed !== gestures.brushed) {
    fail(`shift-clicking it again left ${gestures.removed}, expected ${gestures.brushed}`);
  }
  if (!gestures.spacePanned) fail("space-drag did not pan the camera");

  // The handles, the keyboard and the pinch — the gestures that exist nowhere else but here.
  const hr = gestures.handleReport;
  if (!(hr.resized.grewW > 20 && hr.resized.grewH > 20)) {
    fail(`the corner handle did not scale the shape (+${hr.resized.grewW}w, +${hr.resized.grewH}h)`);
  }
  if (hr.resized.anchorMoved > 0.4) {
    fail(`the opposite corner moved by ${hr.resized.anchorMoved} — a scale handle must anchor it`);
  }
  if (Math.abs(hr.rotated - Math.PI / 2) > 0.05) {
    fail(`the rotate handle turned the shape to ${hr.rotated} rad, expected ~${Math.PI / 2}`);
  }
  if (hr.duplicated.added !== 1 || !hr.duplicated.isNew) {
    fail(`⌘D added ${hr.duplicated.added} rows and ${hr.duplicated.isNew ? "did" : "did not"} select the copy`);
  }
  if (!(hr.nudged.moved > 0.9 && hr.nudged.moved < 1.1)) fail(`an arrow key nudged by ${hr.nudged.moved}, expected 1`);
  if (!hr.nudged.undone) fail("⌘Z did not undo the nudge");
  if (!hr.nudged.copyRemoved) fail("⌘Z did not undo the duplicate");
  if (!hr.nudged.copyBack) fail("⇧⌘Z did not redo the duplicate");
  if (!(gestures.pinch.zoomed > 1.5)) fail(`a two-finger pinch zoomed ×${gestures.pinch.zoomed}, expected to spread`);
  if (gestures.pinch.wrote !== 0) fail(`a pinch wrote ${gestures.pinch.wrote} rows — the camera writes nothing`);
  if (gestures.fit.newQueries !== 4) fail(`⇧1 subscribed ${gestures.fit.newQueries} extent queries, expected 4`);
  if (!gestures.fit.zoomChanged) fail("⇧1 did not move the camera");
  if (!gestures.fit.holdsDrawing) fail("⇧1 left part of the drawing off screen");
  if (gestures.selAfterPan !== gestures.selBeforePan) {
    fail(`a space-pan changed the selection (${gestures.selBeforePan} → ${gestures.selAfterPan})`);
  }
  if (gestures.cleared !== 0 || gestures.selRowsAfterClear !== 0) {
    fail(`Escape left ${gestures.cleared} selected / ${gestures.selRowsAfterClear} rows in the view`);
  }
  if (gestures.mismatches > 0) fail(`${gestures.mismatches} mismatches after the multi-select session`);
  if (!custom.stillLive) fail("a broken edit tore out the previous subscription");
  if (custom.sweepMismatches > 0) fail(`${custom.sweepMismatches} mismatches with the custom pane in the sweep`);
  if (custom.customsAfterClose !== 0 || !custom.paneGone) fail("closing the pane did not tear it out");
  if (!report.canvasPainted) fail("the canvas has no backing store");
  // The infinite canvas: panning re-aims a BOUNDED set of live queries and stays exact.
  if (!(report.cellsBeforePan > 0)) fail("the canvas subscribed no cells");
  if (!(report.panSubscribed > 0)) fail("panning across cell boundaries subscribed nothing");
  if (report.cellsAfterPan > report.cellsBeforePan * 3) {
    fail(`panning leaked subscriptions: ${report.cellsBeforePan} → ${report.cellsAfterPan}`);
  }
  if (report.panMismatches > 0) fail(`${report.panMismatches} mismatches after panning`);
  if (!(report.levelAfterZoom > report.levelBeforeZoom)) {
    fail(`zooming out did not step the cell level (${report.levelBeforeZoom} → ${report.levelAfterZoom})`);
  }
  if (report.zoomMismatches > 0) fail(`${report.zoomMismatches} mismatches after zooming`);
  if (!/shapes/.test(report.hudText)) fail(`the HUD did not render: ${JSON.stringify(report.hudText)}`);

  // -- the confetti layer's cache ---------------------------------------------------------------
  if (layer.commits < 2) fail(`the drop did not batch (${layer.commits} commits) — nothing to append`);
  if (!layer.stable) fail("the canvas was still moving with the robots off — the pixel check cannot mean anything");
  if (layer.rebuilds !== 0) {
    fail(`a batched drop re-traced the confetti pile ${layer.rebuilds} times — arrivals must append`);
  }
  if (layer.appends < layer.commits) fail(`${layer.commits} batches landed but only ${layer.appends} appended`);
  // One trace per speck that ARRIVED, not one per speck in the pile per batch.
  if (layer.traced > layer.held) {
    fail(`the layer traced ${layer.traced} specks to hold ${layer.held} — it is re-tracing what it already had`);
  }
  if (layer.appended === layer.hidden) fail("hiding the confetti layer changed nothing on screen — the check is blind");
  if (layer.appended !== layer.rebuilt) {
    fail(`the appended layer and a freshly traced one paint differently (${layer.appended} vs ${layer.rebuilt})`);
  }
  if (layer.mismatches > 0) fail(`${layer.mismatches} mismatches after the confetti-layer session`);
  if (layer.speck2 === null) fail("no confetti in the subscribed cells — the recolour check never ran");
  if (layer.recolored === layer.wasColor) fail("the palette chip did not recolour the selected speck");
  if (layer.recoloredWho === 9) {
    fail("the palette recoloured a confetti speck without promoting it out of the layer — it will paint in the old colour");
  }
  if (layer.recoloredHash !== layer.recoloredFresh) {
    fail(`a recoloured speck paints in its old colour (${layer.recoloredHash} vs ${layer.recoloredFresh})`);
  }
  if (!drop.armed) fail("the shapes button stayed live while a drop was landing — two presses can overlap");
  if (drop.released) fail("the shapes button never came back after the drop landed");
  if (drop.landed !== drop.want) {
    fail(`three presses landed ${drop.landed} rows, not the ${drop.want} of one drop — presses overlapped`);
  }
  if (layer.speck === null) fail("no confetti in the subscribed cells — the promote check never ran");
  if (layer.promoted === 9) fail("an arrow key moved a confetti speck without promoting it out of the layer");
  if (layer.nudged !== layer.nudgedFresh) {
    fail(`a nudged speck is painted where it was, not where it is (${layer.nudged} vs ${layer.nudgedFresh})`);
  }
  // The heap probe: 4,000 rows into the engine MUST move the live instance's memory reading —
  // this is the bundling hazard (two module instances of pkg/rindle.js) made into a hard failure.
  if (report.heapBefore === null || report.heapAfter === null) {
    fail("the wasm heap probe returned null in the built bundle");
  } else if (!(report.heapAfter > report.heapBefore) && report.heapBefore < 8 * 1048576) {
    fail(`the heap reading never moved (${fmtMB(report.heapBefore)} → ${fmtMB(report.heapAfter)}) — a dead handle?`);
  }

  if (!process.exitCode) {
    process.stdout.write(
      `\n✅ the page boots, draws, pans, zooms, writes and self-checks in a real browser` +
        ` (${report.cellsAfterPan} cells live, +${report.panSubscribed} across the pan,` +
        ` level ${report.levelBeforeZoom}→${report.levelAfterZoom})\n`,
    );
  }
} catch (err) {
  fail(String(err?.stack ?? err));
} finally {
  if (process.exitCode && cdp.log.length) {
    process.stderr.write(`\n--- page console ---\n${cdp.log.join("\n")}\n`);
  }
  await stop();
  site.close();
}

function fmtMB(bytes) {
  return bytes === null ? "null" : `${(bytes / 1048576).toFixed(1)} MB`;
}
