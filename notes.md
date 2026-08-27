tldraw parity, as of the rotate/scale/undo pass — what is now in:

- rotate handle (⇧ snaps to 15°), eight scale handles anchored on the opposite side, a single
  shape framed in its OWN rotated box (so a resize runs along the shape's axes)
- ⌘D duplicate, arrow-key nudge (⇧ = 10), ⇧1 zoom-to-fit / ⇧2 zoom-to-selection, two-finger
  touch pinch (trackpad ctrl-wheel already worked)
- undo/redo — as inverse DELTAS through the same commit funnel, never snapshots. One step per
  gesture; inverses are per-COLUMN so they rebase over the robots' concurrent writes; the
  robots' own commits are not on the stack. `src/history.ts` carries the argument.

Still not tldraw, and deliberate for now:

- no copy/paste, no groups (⌘G), no alignment/distribute, no snapping guides
- no flip, no "bring to front / send to back" beyond the raise-on-grab
- no text, no lines/arrows, no freehand draw tool, no styles panel, no minimap
- no edge-auto-scroll while dragging past the viewport
- a rotated shape inside a MULTI selection scales by projecting the world scale onto its own
  axes (`geom.ts`, `applyResize`) — exact at every right angle, an even blend in between. The
  exact answer is a parallelogram, and the schema stores rectangles.

Open questions, unrelated:

- rm differential? / when is it run in app?
- where queries used?
- underscore/lodash/coffeescript style literate overview
