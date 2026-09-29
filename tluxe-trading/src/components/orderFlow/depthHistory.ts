/* ============================================================================
 * Recorded IBKR depth history for the Liquidity Heatmap (display side, read only).
 *
 * The TLUXE gateway records every IBKR price-level depth observation server-side (PostgreSQL) and serves it as a
 * time × price matrix: each cell = the time-weighted DISPLAYED size actually observed at that price during the bucket.
 * This module loads that matrix for the visible window, keeps the live edge current by polling, and exposes columns
 * in the heatmap's shape. It never creates a value: time without a recorded column is drawn as no data, and nothing
 * exists before the first recorded snapshot (firstRecordedMs).
 * ========================================================================== */

export const HISTORY_BUCKETS_MS = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
const LIVE_POLL_MS = 2000;

export interface HistoryColumn {
  t: number;
  /** Bucket width (ms). */
  w: number;
  /** Fraction of the bucket covered by a valid recorded book (0..1). */
  coverage: number;
  /** Exact recorded-valid intervals [from, to) inside the bucket (flattened pairs). Paint only inside them. */
  valid: Float64Array;
  bidTicks: Int32Array;
  bidSizes: Float64Array;
  askTicks: Int32Array;
  askSizes: Float64Array;
}

export interface HeatmapResponse {
  root: string;
  contract: string | null;
  provider: string;
  depthType: string;
  mbo: boolean;
  firstRecordedMs: number | null;
  lastObservedMs: number | null;
  bucketMs: number;
  from: number;
  to: number;
  columns: [number, number, [number, number][], [number, number][], [number, number][]?][];
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Bucket for a window: at most one column per two plot pixels, never finer than the engine's time aggregation. */
export function chooseBucket(spanMs: number, plotPx: number, minMs: number): number {
  const want = Math.max(minMs, spanMs / Math.max(1, plotPx / 2));
  return HISTORY_BUCKETS_MS.find((b) => b >= want) ?? HISTORY_BUCKETS_MS[HISTORY_BUCKETS_MS.length - 1]!;
}

/** Server columns → heatmap columns (prices to ticks). Pure. */
export function toColumns(r: HeatmapResponse, tickSize: number): HistoryColumn[] {
  const tk = (p: number) => Math.round(p / tickSize);
  return r.columns.map(([t, coverage, bids, asks, segs]) => ({
    t,
    w: r.bucketMs,
    coverage,
    valid: Float64Array.from((segs ?? [[t, t + r.bucketMs]]).flat()),
    bidTicks: Int32Array.from(bids, (x) => tk(x[0])),
    bidSizes: Float64Array.from(bids, (x) => x[1]),
    askTicks: Int32Array.from(asks, (x) => tk(x[0])),
    askSizes: Float64Array.from(asks, (x) => x[1]),
  }));
}

/**
 * Merge a freshly served range into the sorted columns: every column inside [from, to) is replaced by the server's
 * (a partial live bucket is superseded by its completed version) - one column per timestamp, never duplicated.
 */
export function mergeColumns(cur: readonly HistoryColumn[], add: readonly HistoryColumn[], from: number, to: number): HistoryColumn[] {
  const keep = cur.filter((c) => c.t < from || c.t >= to);
  return [...keep, ...add].sort((a, b) => a.t - b.t);
}

/** t lies inside one of the column's recorded-valid intervals. */
export function validAt(c: HistoryColumn, t: number): boolean {
  for (let i = 0; i < c.valid.length; i += 2) if (t >= c.valid[i]! && t < c.valid[i + 1]!) return true;
  return false;
}

/** Column covering time t (binary search), or null. */
export function columnAt(cols: readonly HistoryColumn[], t: number): HistoryColumn | null {
  let lo = 0;
  let hi = cols.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const c = cols[m]!;
    if (t < c.t) hi = m - 1;
    else if (t >= c.t + c.w) lo = m + 1;
    else return c;
  }
  return null;
}

export class DepthHistory {
  columns: HistoryColumn[] = [];
  bucketMs = 0;
  firstRecordedMs: number | null = null;
  lastObservedMs: number | null = null;
  contract: string | null = null;
  error: string | null = null;
  /** Bumped whenever the columns change (render trigger). */
  version = 0;
  private loaded: { lo: number; hi: number } | null = null;
  private inflight = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private want: { t0: number; t1: number } | null = null;
  private destroyed = false;
  private readonly fetchImpl: FetchLike;

  constructor(
    readonly root: string,
    private readonly tickSize: number,
    private readonly minBucketMs: () => number,
    fetchImpl?: FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.fetchImpl = fetchImpl ?? ((u) => fetch(u, { credentials: 'same-origin', signal: AbortSignal.timeout(10_000) }));
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.live(), LIVE_POLL_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called by the view with the visible window: loads what is missing at the right resolution. */
  ensure(t0: number, t1: number, plotPx: number): void {
    const b = chooseBucket(t1 - t0, plotPx, this.minBucketMs());
    this.want = { t0, t1 };
    if (b !== this.bucketMs) {
      this.bucketMs = b;
      this.columns = [];
      this.loaded = null;
      this.version += 1;
    }
    const lo = t0 - (t1 - t0) * 0.25;
    const hi = Math.max(t1, this.now());
    if (this.loaded && lo >= this.loaded.lo && t1 <= this.loaded.hi) return;
    void this.load(this.loaded ? Math.min(lo, this.loaded.lo) : lo, hi, this.loaded ? { lo: Math.min(lo, this.loaded.lo), hi: Math.max(hi, this.loaded.hi) } : { lo, hi });
  }

  /** Keep the live edge current: re-load the last buckets (a partial bucket is replaced by its completed form). */
  async live(): Promise<void> {
    if (!this.loaded || !this.bucketMs) return;
    const from = Math.max(this.loaded.lo, this.loaded.hi - 3 * this.bucketMs - LIVE_POLL_MS);
    await this.load(from, this.now() + this.bucketMs, { lo: this.loaded.lo, hi: this.now() });
  }

  private async load(from: number, to: number, next: { lo: number; hi: number }): Promise<void> {
    if (this.inflight || this.destroyed || !this.bucketMs) return;
    this.inflight = true;
    const bucket = this.bucketMs;
    try {
      const r = await this.fetchImpl(`/api/ibkr/heatmap?root=${this.root}&from=${Math.floor(from)}&to=${Math.ceil(to)}&bucket=${bucket}`);
      if (this.destroyed || bucket !== this.bucketMs) return;
      if (!r.ok) {
        this.error = `recorded depth history unavailable (HTTP ${r.status})`;
        return;
      }
      const body = (await r.json()) as HeatmapResponse;
      if (body.contract !== this.contract) {
        this.columns = []; // another contract (roll): its depth is never shown under this one
        this.contract = body.contract;
      }
      this.error = null;
      this.firstRecordedMs = body.firstRecordedMs;
      this.lastObservedMs = body.lastObservedMs ?? this.lastObservedMs;
      if (body.bucketMs === bucket) this.columns = mergeColumns(this.columns, toColumns(body, this.tickSize), body.from, body.to);
      this.loaded = { lo: Math.min(next.lo, body.from), hi: Math.max(next.hi, Math.min(body.to, this.now())) };
      this.version += 1;
    } catch {
      this.error = 'recorded depth history unavailable (gateway unreachable)';
    } finally {
      this.inflight = false;
    }
    // A viewport change that arrived while loading.
    const w = this.want;
    if (w && this.loaded && (w.t0 - (w.t1 - w.t0) * 0.25 < this.loaded.lo || w.t1 > this.loaded.hi + this.bucketMs)) void this.load(w.t0 - (w.t1 - w.t0) * 0.25, Math.max(w.t1, this.now()), { lo: Math.min(this.loaded.lo, w.t0 - (w.t1 - w.t0) * 0.25), hi: Math.max(this.loaded.hi, w.t1) });
  }

  /** End of the recorded coverage: live engine columns are used only after it (one source per instant). */
  coverEnd(): number | null {
    const last = this.columns[this.columns.length - 1];
    if (!last) return null;
    return Math.min(last.t + last.w, this.lastObservedMs ?? last.t + last.w);
  }
}
