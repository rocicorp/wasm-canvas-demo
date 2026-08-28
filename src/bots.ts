// The robots: three ambient writers that drift the shapes they own, so the page is alive before
// you touch it and OTHER writers' commits keep folding into your views while you work.
//
// They are ordinary writers — their muts go through the same `Writer.commit` funnel as your
// drags, one transaction per tick. They never touch a shape you are holding (`exclude`). Almost
// all confetti stays inert (`who = 9`), but higher write-rate rungs may WAKE a bounded cohort by
// assigning it to a robot first; see `livingConfettiTarget` and the note on `adopt`.
//
// Rate is row-writes per second, budgeted across ticks the same way the old scale demo's
// workload budgeted (never accruing more than one second of work). The default murmur keeps the
// feed ticking and the blooms breathing; the page's "robots" button turns the same knob up to a
// torrent — the WRITE axis of the demo's cost matrix, the way confetti is the base axis.
// Writes coalesce per row per frame, so a rate is only honest
// while the herd outnumbers a frame's budget: `herdFor` prices that, and `drifters` mints the
// extra robot-owned shapes (never confetti) that carry a higher rate.

import type { Mirror, ShapeRow } from "./mirror.ts";
import { rng } from "./scene.ts";
import { PALETTE, WORLD_H, WORLD_W } from "./schema.ts";
import type { Mut, Writer } from "./write.ts";

export const BOT_IDS = [1, 2, 3] as const;

/** The default 24/s murmur animates the opening drawing but leaves every confetto inert. Above
 *  it, each 4x rate rung doubles a small live cohort: 96→16, 384→32, 1536→64, 6144→128.
 *
 *  This is deliberately a TARGET, not a fraction of the pile. A 120k-row stress test must not
 *  silently become 120k per-frame draw calls or 120k velocity records. Once awakened, a speck
 *  stays robot-owned; lowering the rate freezes/slows it rather than returning it to the static
 *  Path2D and forcing another whole-pile rebuild. */
export function livingConfettiTarget(perSec: number): number {
  if (perSec <= 24) return 0;
  return Math.min(128, Math.round(8 * Math.sqrt(perSec / 24)));
}

export function isBotOwner(who: number): boolean {
  return BOT_IDS.includes(who as (typeof BOT_IDS)[number]);
}

/** Stable ownership spreads a cohort evenly without needing another counter in application
 *  state. IDs are monotone, so adjacent confetti naturally round-robin across the three bots. */
export function botOwnerFor(id: number): (typeof BOT_IDS)[number] {
  return BOT_IDS[Math.abs(id) % BOT_IDS.length];
}

/** How far a shape wanders from where the robots first found it, in world units, per axis.
 *
 *  This is NOT a world edge — there is no world edge any more. Drift used to bounce off
 *  `WORLD_W`×`WORLD_H`, which on an unbounded canvas meant every robot shape eventually piled up
 *  along four invisible lines at the border of a window that had stopped existing, and no robot
 *  ever set foot outside the demo's opening screenful. A shape roams its OWN neighbourhood
 *  instead: the composition stays where you left it and the blooms stay recognisable, while
 *  anything living somewhere else on the canvas drifts there in exactly the same way.
 *
 *  Sized a couple of level-0 cells across (`CELL0` is 256) so ambient drift keeps carrying rows
 *  over cell boundaries — the canvas's subscription handoff runs all the time, not only when
 *  your hand drags something across one. */
export const ROAM = 300;

export class Bots {
  enabled = true;
  /** Row-writes per second across all robots. */
  perSec = 24;

  private readonly mirror: Mirror;
  private readonly r = rng(0xb07);
  private readonly velocity = new Map<number, { vx: number; vy: number }>();
  private readonly lastMoved = new Map<number, number>();
  /** The centre of each shape's {@link ROAM} — where the robots last found it standing, which
   *  is not the same as where they first met it: see `drift`. */
  private readonly home = new Map<number, { x: number; y: number }>();
  private herd: number[] = [];
  private cursor = 0;
  private budget = 0;

  constructor(mirror: Mirror) {
    this.mirror = mirror;
    this.adopt();
  }

  get herdSize(): number {
    return this.herd.length;
  }

  /** The herd a rate needs to stay honest: per-frame muts coalesce per row, so the ceiling is
   *  herd × fps. Sized for ~24 fps so the count on the button survives a struggling tab. */
  herdFor(perSec: number): number {
    return Math.ceil(perSec / 24);
  }

  /** Rows for `n` new drifters — small bloom-grade ellipses, owned round-robin by the three
   *  robots, never confetti. The caller commits them, then calls `adopt()`.
   *
   *  They land in `area` — the viewport, when the page asks — for the same reason a confetti drop
   *  does: on an unbounded canvas a fixed scatter box would mint every one of them inside the
   *  demo's opening screenful, so turning the write rate up somewhere else would raise a number
   *  in the HUD and show you nothing. Turn the robots up over an empty stretch of canvas and the
   *  writers arrive where you are looking. */
  drifters(
    n: number,
    draft: Writer["draft"],
    area: { x0: number; y0: number; x1: number; y1: number } = { x0: 0, y0: 0, x1: WORLD_W, y1: WORLD_H },
  ): ShapeRow[] {
    const rows: ShapeRow[] = [];
    // Inset, so a drifter minted at the very edge of the viewport is whole on screen.
    const x0 = area.x0 + 20;
    const y0 = area.y0 + 20;
    const w = Math.max(1, area.x1 - area.x0 - 40);
    const h = Math.max(1, area.y1 - area.y0 - 40);
    for (let i = 0; i < n; i++) {
      const d = 10 + this.r() * 30;
      rows.push(
        draft(
          "ellipse",
          x0 + this.r() * w,
          y0 + this.r() * h,
          d,
          d * (0.7 + this.r() * 0.6),
          PALETTE[Math.floor(this.r() * PALETTE.length)].key,
          BOT_IDS[i % BOT_IDS.length],
        ),
      );
    }
    return rows;
  }

  /** (Re)collect the robots' shapes from the mirror. Call after seeding.
   *
   *  A robot owns every row whose `who` is 1–3: the opening scene, drifters, and the bounded
   *  confetti cohort DrawApp has explicitly awakened. Inert confetti remains `who = 9` and is
   *  never adopted. That distinction is load-bearing: `who = 9` rows paint from a Path2D cache
   *  keyed on membership, not position, so moving one in place would leave its pixels behind.
   *  Waking a speck changes its owner FIRST, taking it permanently out of that static layer. */
  adopt(): void {
    this.herd = [];
    for (const row of this.mirror.all()) {
      if (isBotOwner(row.who)) this.herd.push(row.id);
    }
    const live = new Set(this.herd);
    for (const id of this.velocity.keys()) {
      if (live.has(id)) continue; // deleted since the last adopt: let its state go
      this.velocity.delete(id);
      this.lastMoved.delete(id);
      this.home.delete(id);
    }
    for (const id of this.herd) {
      if (this.velocity.has(id)) continue;
      const speed = 8 + this.r() * 26; // world units / second
      const ang = this.r() * Math.PI * 2;
      this.velocity.set(id, { vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed });
      const row = this.mirror.get(id)!;
      this.home.set(id, { x: row.x, y: row.y });
    }
  }

  /** Advance by `dtMs`; returns this tick's muts (commit them as one transaction). */
  tick(dtMs: number, now: number, exclude: ReadonlySet<number> | null): Mut[] {
    if (!this.enabled || this.herd.length === 0) return [];
    this.budget += (this.perSec * Math.min(dtMs, 1000)) / 1000;
    const n = Math.floor(this.budget);
    if (n < 1) return [];
    this.budget -= n;

    const muts: Mut[] = [];
    for (let i = 0; i < n && muts.length < this.herd.length; i++) {
      const id = this.herd[this.cursor++ % this.herd.length];
      if (exclude?.has(id)) continue; // never fight the shapes your hand is on
      const row = this.mirror.get(id);
      if (!row) continue;

      // Mostly drift; occasionally a recolor, so the tally moves without your help too.
      if (this.r() < 0.04) {
        muts.push({ op: "set", id, patch: { color: PALETTE[Math.floor(this.r() * PALETTE.length)].key } });
        continue;
      }
      muts.push({ op: "set", id, patch: this.drift(row, now) });
    }
    return muts;
  }

  private drift(row: ShapeRow, now: number): { x: number; y: number } {
    const last = this.lastMoved.get(row.id) ?? now - 250;
    const dt = Math.min(now - last, 2000) / 1000;
    this.lastMoved.set(row.id, now);
    const v = this.velocity.get(row.id)!;
    // Where the neighbourhood is centred — re-read from the SHAPE, not just remembered.
    //
    // A shape can only be sitting outside its own territory because something other than this
    // drift put it there: your hand, a group drag, a resize that swung its centre. The robot's
    // own step is clamped below, so it can never start a tick outside. So finding it outside
    // means the shape has moved house, and the territory follows it — a neighbourhood, not a
    // leash. Anchoring on where the robot first ADOPTED the shape is what made dragging one
    // across the canvas snap it back on the very next tick.
    let h = this.home.get(row.id);
    if (!h || Math.abs(row.x - h.x) > ROAM || Math.abs(row.y - h.y) > ROAM) {
      this.home.set(row.id, (h = { x: row.x, y: row.y }));
    }
    let x = row.x + v.vx * dt;
    let y = row.y + v.vy * dt;
    if (x < h.x - ROAM || x > h.x + ROAM) {
      v.vx = -v.vx;
      x = Math.min(h.x + ROAM, Math.max(h.x - ROAM, x));
    }
    if (y < h.y - ROAM || y > h.y + ROAM) {
      v.vy = -v.vy;
      y = Math.min(h.y + ROAM, Math.max(h.y - ROAM, y));
    }
    return { x, y };
  }
}
