// Small, honest measurement primitives.
//
// Every number the demo shows comes from one of these, and every one of them is a *sample over a
// bounded recent window* rather than a lifetime average — a lifetime mean silently reports the
// startup ramp forever, so dragging a slider appears to do nothing for a minute and then does
// something. The window is stated wherever a figure is shown.

/** A fixed-capacity ring of samples with percentiles. Not a t-digest — at these window sizes an
 *  exact sort is cheaper than being clever, and being exactly right about p99 matters more here
 *  than the microseconds the sort costs. */
export class Samples {
  private readonly buf: Float64Array;
  private n = 0;
  private next = 0;

  constructor(capacity = 512) {
    this.buf = new Float64Array(capacity);
  }

  add(v: number): void {
    this.buf[this.next] = v;
    this.next = (this.next + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }

  get count(): number {
    return this.n;
  }

  reset(): void {
    this.n = 0;
    this.next = 0;
  }

  /** `p` in [0,1]. Nearest-rank. NaN when there are no samples — callers render that as "—"
   *  rather than as 0, because "no measurement yet" and "measured zero" are different claims. */
  quantile(p: number): number {
    if (this.n === 0) return Number.NaN;
    const sorted = Array.prototype.slice.call(this.buf, 0, this.n).sort((a: number, b: number) => a - b);
    const i = Math.min(this.n - 1, Math.max(0, Math.ceil(p * this.n) - 1));
    return sorted[i];
  }

  mean(): number {
    if (this.n === 0) return Number.NaN;
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.buf[i];
    return s / this.n;
  }

  max(): number {
    if (this.n === 0) return Number.NaN;
    let m = -Infinity;
    for (let i = 0; i < this.n; i++) if (this.buf[i] > m) m = this.buf[i];
    return m;
  }
}

/** Events per second over a sliding window, from timestamped counts. Used for the ACHIEVED write
 *  rate — the one that comes apart from the requested rate once the tab cannot keep up, which is
 *  the moment worth seeing rather than hiding. */
export class Rate {
  private readonly windowMs: number;
  private readonly marks: Array<{ t: number; n: number }> = [];
  private sum = 0;

  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
  }

  add(n: number, now: number): void {
    if (n > 0) {
      this.marks.push({ t: now, n });
      this.sum += n;
    }
    this.trim(now);
  }

  perSecond(now: number): number {
    this.trim(now);
    if (this.marks.length === 0) return 0;
    return (this.sum * 1000) / this.windowMs;
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.marks.length > 0 && this.marks[0].t < cutoff) {
      this.sum -= this.marks[0].n;
      this.marks.shift();
    }
  }
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 100) return `${ms.toFixed(2)} ms`;
  return `${ms.toFixed(0)} ms`;
}

export function fmtUs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${(ms * 1000).toFixed(0)} µs`;
}

export function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "—";
}

/** The JS heap, where the browser will say. Chrome-only and coarse (it is the whole tab, and it
 *  moves with GC), so it is labelled as such wherever it is shown and is never the basis of a
 *  claim — the wasm heap (exact) and the dataset bytes (exact) are. */
export function jsHeapBytes(): number | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } };
  const v = perf.memory?.usedJSHeapSize;
  return typeof v === "number" ? v : null;
}
