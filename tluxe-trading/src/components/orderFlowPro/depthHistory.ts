import type { OfpRoot } from '../../engines/orderFlowPro/types';
import { parseHeatmap } from '../../providers/orderFlowPro/gatewayMap';
import { historyBudget, type HistoryBudget } from '../../providers/orderFlowPro/historyBudget';
import type { HeatColumn } from './heatLayer';

/* ============================================================================
 * On-demand recorded IBKR depth for the liquidity heatmap (read-only GET of the existing /api/ibkr/heatmap).
 *
 *   * only time BEFORE the page's live recorder (`before`) - the recorder covers the rest, so there is never a
 *     "current" chunk to re-request and never a polling loop;
 *   * aligned chunks of <= MAX_CHUNK_COLUMNS columns and <= MAX_CHUNK_SPAN_MS (bounded gateway work per request);
 *   * at most MAX_REQUESTS_PER_MIN (8) heatmap requests per minute (GC + SI together), AND every request takes a
 *     slot of the page-wide recorded-depth budget (historyBudget: <= 10 / min shared with the one-time
 *     liquidity-history read and replay), so the page never exceeds 10 / min; excess chunks wait for a later view
 *     change - nothing loops;
 *   * one request per chunk; a failed chunk is not retried (state FAILED until the contract changes);
 *   * a response is used only when its contract equals the VERIFIED contract it was requested for (PR #8 rule);
 *     responses for an obsolete contract / instrument are dropped;
 *   * bounded memory: least-recently-used chunks are evicted above MAX_CACHED_CELLS.
 * Columns keep side, price (tick), time range, time-weighted displayed contracts and recorded coverage; time without
 * recorded coverage has no column (gaps are never interpolated).
 * ========================================================================== */

export const HISTORY_BUCKETS_MS = [1000, 5000, 15_000, 60_000, 300_000] as const;
export const MAX_CHUNK_COLUMNS = 900;
export const MAX_CHUNK_SPAN_MS = 12 * 3600_000;
export const MAX_REQUESTS_PER_MIN = 8;
export const MAX_CACHED_CELLS = 400_000;

/** Smallest bucket that keeps a column >= minPx wide at the current zoom (3 px: finer is not visible, and costs). */
export function bucketFor(pxPerMs: number, minPx = 3): number {
  for (const b of HISTORY_BUCKETS_MS) if (b * pxPerMs >= minPx) return b;
  return HISTORY_BUCKETS_MS[HISTORY_BUCKETS_MS.length - 1]!;
}

export const chunkSpan = (bucket: number) => Math.min(bucket * MAX_CHUNK_COLUMNS, MAX_CHUNK_SPAN_MS);

export type ChunkState = 'LOADING' | 'LOADED' | 'FAILED' | 'DEFERRED';

interface Chunk {
  key: string;
  from: number;
  to: number;
  bucket: number;
  state: ChunkState;
  columns: HeatColumn[];
  cells: number;
  used: number;
  detail: string | null;
}

export interface HistoryRangeState {
  loading: number;
  failed: number;
  deferred: number;
  loaded: number;
  detail: string | null;
}

type Fetch = typeof fetch;

export class DepthHistory {
  private chunks = new Map<string, Chunk>();
  private stamps: number[] = [];
  private cells = 0;
  /** Bumped whenever cached data changes (the chart's layer cache key). */
  version = 0;
  requests = 0;

  constructor(
    private readonly tickOf: (root: OfpRoot) => number,
    private readonly fetchImpl: Fetch = (...a) => fetch(...a),
    private readonly clock: () => number = () => Date.now(),
    private readonly onChange: () => void = () => {},
    private readonly budget: HistoryBudget = historyBudget,
  ) {}

  private key(root: OfpRoot, contract: string, bucket: number, from: number) {
    return `${root}:${contract}:${bucket}:${from}`;
  }

  /** Drop every chunk not for this verified contract (roll / mismatch): another contract's history never reappears. */
  keepOnly(root: OfpRoot, contract: string | null) {
    let changed = false;
    for (const [k, c] of this.chunks)
      if (k.startsWith(`${root}:`) && (contract === null || !k.startsWith(`${root}:${contract}:`))) {
        this.cells -= c.cells;
        this.chunks.delete(k);
        changed = true;
      }
    if (changed) this.version++;
  }

  /**
   * Make sure the chunks covering [from, to) (clamped to < `before`) are loaded or requested, within the per-minute
   * budget. Call it after the view settled (the page debounces); it never schedules anything itself.
   */
  ensure(root: OfpRoot, contract: string, from: number, to: number, bucket: number, before: number): void {
    const end = Math.min(to, before);
    if (!(end > from)) return;
    const span = chunkSpan(bucket);
    const now = this.clock();
    this.stamps = this.stamps.filter((s) => now - s < 60_000);
    // nearest chunks to the right edge first (the most recent history is what the user scrolled away from)
    const starts: number[] = [];
    for (let s = Math.floor((end - 1) / span) * span; s + span > from && starts.length < 64; s -= span) starts.push(s);
    for (const s of starts) {
      const k = this.key(root, contract, bucket, s);
      const c = this.chunks.get(k);
      if (c && c.state !== 'DEFERRED') {
        c.used = now;
        continue;
      }
      if (this.stamps.length >= MAX_REQUESTS_PER_MIN || !this.budget.tryTake()) {
        if (!c) this.chunks.set(k, { key: k, from: s, to: s + span, bucket, state: 'DEFERRED', columns: [], cells: 0, used: now, detail: 'request budget reached' });
        continue;
      }
      this.stamps.push(now);
      this.load(root, contract, bucket, s, Math.min(s + span, before), k);
    }
  }

  private load(root: OfpRoot, contract: string, bucket: number, from: number, to: number, k: string) {
    const chunk: Chunk = { key: k, from, to, bucket, state: 'LOADING', columns: [], cells: 0, used: this.clock(), detail: null };
    this.chunks.set(k, chunk);
    this.requests++;
    this.version++;
    const done = (state: ChunkState, columns: HeatColumn[] = [], detail: string | null = null) => {
      if (this.chunks.get(k) !== chunk) return; // obsolete (contract changed / evicted): ignore the response
      chunk.state = state;
      chunk.columns = columns;
      chunk.cells = columns.reduce((a, c) => a + c.cells.length, 0);
      chunk.detail = detail;
      this.cells += chunk.cells;
      this.evict();
      this.version++;
      this.onChange();
    };
    void (async () => {
      try {
        const r = await this.fetchImpl(`/api/ibkr/heatmap?root=${root}&from=${Math.floor(from)}&to=${Math.ceil(to)}&bucket=${bucket}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!r.ok) return done('FAILED', [], `recorded depth unavailable (HTTP ${r.status})`);
        const h = parseHeatmap(await r.json(), root);
        if (!h) return done('FAILED', [], 'recorded depth response rejected (schema)');
        if (h.contract !== contract) return done('FAILED', [], `recorded depth contract ${h.contract ?? 'none'} ≠ ${contract} - not used`);
        const tick = this.tickOf(root);
        const cols: HeatColumn[] = [];
        for (const c of h.columns) {
          if (c.coverage <= 0 || c.t < from || c.t >= to) continue;
          const cells = [...c.bids.map(([p, s]) => ({ tick: Math.round(p / tick), side: 'BID' as const, avg: s })), ...c.asks.map(([p, s]) => ({ tick: Math.round(p / tick), side: 'ASK' as const, avg: s }))].filter((x) => x.avg > 0);
          cols.push({ t: c.t, dt: h.bucketMs, validMs: c.coverage * h.bucketMs, cells, source: 'RECORDED' });
        }
        done('LOADED', cols);
      } catch {
        done('FAILED', [], 'recorded depth request failed');
      }
    })();
  }

  private evict() {
    if (this.cells <= MAX_CACHED_CELLS) return;
    const loaded = [...this.chunks.values()].filter((c) => c.state === 'LOADED').sort((a, b) => a.used - b.used);
    for (const c of loaded) {
      if (this.cells <= MAX_CACHED_CELLS) break;
      this.cells -= c.cells;
      this.chunks.delete(c.key);
    }
  }

  /** Recorded columns for [from, to) at `bucket`, sorted, for one verified contract. */
  columns(root: OfpRoot, contract: string, bucket: number, from: number, to: number): HeatColumn[] {
    // chunks are disjoint and each chunk's columns are already time-sorted: order the (few) overlapping chunks and
    // binary-search into each one - no per-column scan or sort of the whole cache on every layer rebuild
    const p = `${root}:${contract}:${bucket}:`;
    const hits: Chunk[] = [];
    for (const [k, c] of this.chunks) if (k.startsWith(p) && c.state === 'LOADED' && c.to > from && c.from < to) hits.push(c);
    hits.sort((a, b) => a.from - b.from);
    const out: HeatColumn[] = [];
    for (const c of hits) {
      const cols = c.columns;
      let lo = 0;
      let hi = cols.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (cols[m]!.t + cols[m]!.dt <= from) lo = m + 1;
        else hi = m;
      }
      for (let i = lo; i < cols.length && cols[i]!.t < to; i++) out.push(cols[i]!);
    }
    return out;
  }

  rangeState(root: OfpRoot, contract: string, bucket: number, from: number, to: number): HistoryRangeState {
    const s: HistoryRangeState = { loading: 0, failed: 0, deferred: 0, loaded: 0, detail: null };
    const p = `${root}:${contract}:${bucket}:`;
    for (const [k, c] of this.chunks) {
      if (!k.startsWith(p) || c.to <= from || c.from >= to) continue;
      if (c.state === 'LOADING') s.loading++;
      else if (c.state === 'FAILED') s.failed++;
      else if (c.state === 'DEFERRED') s.deferred++;
      else s.loaded++;
      if (c.detail && !s.detail) s.detail = c.detail;
    }
    return s;
  }

  get cachedCells() {
    return this.cells;
  }
}
