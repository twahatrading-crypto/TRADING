import type { Aggressor, OrderFlowMsg } from '../../engines/orderFlow/types';

/* ============================================================================
 * DISPLAY-ONLY aggregation of executed trades for the main order-flow chart.
 *
 * The chart draws REAL executed trades, but never one circle per print: prints are collapsed into
 * deterministic display buckets (time bucket × price band) so a burst of prints at nearly the same
 * time / price reads as ONE bubble instead of a vertical wall. Nothing here writes anywhere:
 *   - the raw messages (the order-flow recording) are read, never mutated;
 *   - the engine (CVD, SVP, events, columns) never sees this module;
 *   - every quantity is summed exactly (buy / sell / unknown kept apart, UNKNOWN never becomes a side).
 * Trades are placed at their own EXCHANGE time (a late-delivered backlog lands where it happened,
 * not in the bucket that happened to be open when it arrived).
 * ========================================================================== */

/** One executed trade as the chart sees it (exchange time, price in ticks, exact size, provider aggressor). */
export interface DisplayTrade {
  t: number;
  tick: number;
  size: number;
  side: Aggressor;
}

/** A display bucket: exact sums of the real trades it contains. */
export interface DotBucket {
  /** Bucket start (exchange ms) and width. */
  t: number;
  ms: number;
  /** Lowest tick of the price band and its height in ticks. */
  band: number;
  bandTicks: number;
  /** Volume-weighted price of the bucket, in ticks (bubble position). */
  vwapTick: number;
  buy: number;
  sell: number;
  unknown: number;
  total: number;
  count: number;
  first: number;
  last: number;
}

/** OHLC of the real trade prices in one time bucket (ticks) - the price trace. */
export interface PriceBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Dominance = 'BUY' | 'SELL' | 'MIXED' | 'UNKNOWN';

/** User choice for the display bucket. AUTO picks from DOT_BUCKETS_MS by pixel width and density. */
export type DotAggregation = 'auto' | 100 | 250 | 500 | 1000;
export const DOT_AGGREGATIONS: readonly DotAggregation[] = ['auto', 100, 250, 500, 1000];
export const DOT_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** Minimum width of a display bucket on screen in AUTO (px). */
export const AUTO_MIN_BUCKET_PX = 10;
/** AUTO: at most roughly one filled bucket per this many px of plot width. */
export const AUTO_PX_PER_BUCKET = 5;
/** Share of the known (buy + sell) volume one side needs to colour the bubble; below = MIXED. */
export const DOMINANCE_MIN = 0.2;

/** Dominant side of a bucket. UNKNOWN when unknown volume is at least the known volume. */
export function dominance(b: { buy: number; sell: number; unknown: number }): Dominance {
  const known = b.buy + b.sell;
  if (b.unknown >= known) return 'UNKNOWN';
  const d = (b.buy - b.sell) / known;
  if (Math.abs(d) < DOMINANCE_MIN) return 'MIXED';
  return d > 0 ? 'BUY' : 'SELL';
}

/**
 * AUTO display bucket: the smallest bucket that is at least AUTO_MIN_BUCKET_PX wide at the current zoom and
 * whose count of filled time buckets fits the plot width (dense tape -> coarser buckets). Deterministic.
 */
export function autoBucketMs(spanMs: number, plotPx: number, trades: readonly DisplayTrade[], from = 0, to = trades.length): number {
  const w = Math.max(1, plotPx);
  const minMs = (spanMs * AUTO_MIN_BUCKET_PX) / w;
  const maxFilled = Math.max(8, Math.floor(w / AUTO_PX_PER_BUCKET));
  for (const ms of DOT_BUCKETS_MS) {
    if (ms < minMs) continue;
    let filled = 0;
    let prev = NaN;
    for (let i = from; i < to && filled <= maxFilled; i++) {
      const b = Math.floor(trades[i]!.t / ms);
      if (b !== prev) {
        filled += 1;
        prev = b;
      }
    }
    if (filled <= maxFilled) return ms;
  }
  return DOT_BUCKETS_MS[DOT_BUCKETS_MS.length - 1]!;
}

/** Price band height (ticks) so a band is about as tall as a time bucket is wide (bubbles cannot stack into a wall). */
export function bandTicksFor(bucketPx: number, rowPx: number): number {
  return Math.max(1, Math.round(Math.max(bucketPx, 6) / Math.max(1e-6, rowPx)));
}

/** First index with t >= x (trades sorted by time). */
export function lowerBound(trades: readonly DisplayTrade[], x: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (trades[m]!.t < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** At most this many bubbles per time bucket: a bucket spanning more price bands gets proportionally wider bands. */
export const MAX_DOTS_PER_BUCKET = 3;

/**
 * Aggregate trades [from, to) (sorted by time) into display buckets of `ms` × price band. Bands are `bandTicks` tall,
 * widened per time bucket so it never shows more than `maxPer` bubbles (a same-ms sweep through 15 ticks is one to three
 * bubbles, not a column of 15). Exact sums; the input is only read. Output: by time bucket, then band (deterministic).
 */
export function aggregateDots(trades: readonly DisplayTrade[], ms: number, bandTicks: number, from = 0, to = trades.length, maxPer = MAX_DOTS_PER_BUCKET): DotBucket[] {
  const out: DotBucket[] = [];
  let s = from;
  while (s < to) {
    const t = Math.floor(trades[s]!.t / ms) * ms;
    let e = s;
    let lo = Infinity;
    let hi = -Infinity;
    while (e < to && trades[e]!.t < t + ms) {
      lo = Math.min(lo, trades[e]!.tick);
      hi = Math.max(hi, trades[e]!.tick);
      e++;
    }
    let band = Math.max(1, bandTicks);
    let base = Math.floor(lo / band) * band;
    if (Math.floor((hi - base) / band) + 1 > maxPer) {
      band = Math.ceil((hi - lo + 1) / maxPer);
      base = lo;
    }
    const group = new Map<number, DotBucket & { pv: number }>();
    for (let i = s; i < e; i++) {
      const x = trades[i]!;
      const k = base + Math.floor((x.tick - base) / band) * band;
      let b = group.get(k);
      if (!b) group.set(k, (b = { t, ms, band: k, bandTicks: band, vwapTick: k, buy: 0, sell: 0, unknown: 0, total: 0, count: 0, first: x.t, last: x.t, pv: 0 }));
      if (x.side === 'BUY') b.buy += x.size;
      else if (x.side === 'SELL') b.sell += x.size;
      else b.unknown += x.size;
      b.total += x.size;
      b.pv += x.size * x.tick;
      b.count += 1;
      if (x.t < b.first) b.first = x.t;
      if (x.t > b.last) b.last = x.t;
    }
    for (const k of [...group.keys()].sort((a2, b2) => a2 - b2)) {
      const { pv, ...b } = group.get(k)!;
      out.push({ ...b, vwapTick: b.total > 0 ? pv / b.total : b.band });
    }
    s = e;
  }
  return out;
}

/** OHLC price trace per time bucket from the real trades [from, to) (sorted by time; ties keep arrival order). */
export function priceBars(trades: readonly DisplayTrade[], ms: number, from = 0, to = trades.length): PriceBar[] {
  const out: PriceBar[] = [];
  let cur: PriceBar | null = null;
  for (let i = from; i < to; i++) {
    const x = trades[i]!;
    const t = Math.floor(x.t / ms) * ms;
    if (!cur || cur.t !== t) out.push((cur = { t, o: x.tick, h: x.tick, l: x.tick, c: x.tick }));
    else {
      cur.h = Math.max(cur.h, x.tick);
      cur.l = Math.min(cur.l, x.tick);
      cur.c = x.tick;
    }
  }
  return out;
}

/**
 * Bubble radius (px): area grows with the square root of the quantity up to the robust norm (p95 of the visible
 * buckets), then only logarithmically, and is clamped to the bucket's cell so bubbles never merge into walls.
 * A big print is visibly bigger than a small one but can never cover the chart.
 */
export function dotRadius(vol: number, norm: number, cellPx: number): number {
  const cell = Math.max(2, cellPx);
  const rMin = Math.min(1.4, cell * 0.3);
  const rNorm = Math.max(rMin, Math.min(4.5, cell * 0.4));
  const rCap = Math.max(rNorm, Math.min(13, cell * 1.2));
  const n = Math.max(1, norm);
  if (!(vol > 0)) return rMin;
  if (vol <= n) return rMin + (rNorm - rMin) * Math.sqrt(vol / n);
  return rNorm + (rCap - rNorm) * Math.min(1, Math.log2(vol / n) / 4);
}

/** p-quantile (0..1) of bucket totals (0 when empty). */
export function quantileTotal(buckets: readonly DotBucket[], q: number): number {
  if (!buckets.length) return 0;
  const v = buckets.map((b) => b.total).sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * q))]!;
}

/** A readable view of the trade messages in a recording (live) or a replay prefix. */
export interface TradeSource {
  msgs: readonly OrderFlowMsg[];
  /** Messages [0, count) are visible (replay cursor; live = msgs.length). */
  count: number;
}

/**
 * Incremental, time-sorted index of the executed trades in a message list (read-only). Appends new messages as they
 * arrive; a different list (new engine / trimmed recording / replay rewind) rebuilds. Trades that arrive late are
 * placed by their exchange time (stable: equal times keep arrival order).
 */
export class TradeTape {
  private src: readonly OrderFlowMsg[] | null = null;
  private seen = 0;
  private sorted = true;
  private list: DisplayTrade[] = [];
  private seq: number[] = [];

  constructor(private readonly tickSize: number) {}

  /** Sync with the source and return the trades sorted by exchange time. */
  sync(s: TradeSource | null): readonly DisplayTrade[] {
    if (!s) {
      this.src = null;
      this.seen = 0;
      this.list = [];
      this.seq = [];
      this.sorted = true;
      return this.list;
    }
    if (s.msgs !== this.src || s.count < this.seen) {
      this.src = s.msgs;
      this.seen = 0;
      this.list = [];
      this.seq = [];
      this.sorted = true;
    }
    const n = Math.min(s.count, s.msgs.length);
    for (let i = this.seen; i < n; i++) {
      const m = s.msgs[i]!;
      if (m.type !== 'trade') continue;
      const last = this.list[this.list.length - 1];
      if (last && m.exchTime < last.t) this.sorted = false;
      this.list.push({ t: m.exchTime, tick: Math.round(m.price / this.tickSize), size: Math.max(0, m.size), side: m.aggressor });
      this.seq.push(i);
    }
    this.seen = n;
    if (!this.sorted) {
      const idx = this.list.map((_, i) => i).sort((a, b) => this.list[a]!.t - this.list[b]!.t || this.seq[a]! - this.seq[b]!);
      this.list = idx.map((i) => this.list[i]!);
      this.seq = idx.map((i) => this.seq[i]!);
      this.sorted = true;
    }
    return this.list;
  }
}

/** The trade with the latest EXCHANGE time in the source (the current price) - not the last one delivered. */
export function latestTrade(s: TradeSource | null): { price: number; time: number } | null {
  if (!s) return null;
  let best: { price: number; time: number } | null = null;
  const n = Math.min(s.count, s.msgs.length);
  for (let i = 0; i < n; i++) {
    const m = s.msgs[i]!;
    if (m.type === 'trade' && (!best || m.exchTime >= best.time)) best = { price: m.price, time: m.exchTime };
  }
  return best;
}

/* ----------------------------------------------------------------------------
 * PRICE LAYER - independent of the volume-dot aggregation (Trade Agg, Volume Dots and the dot rules never touch it).
 * Micro-candles at a resolution set ONLY by the viewport (time span / plot width), plus a step trace: the last traded
 * price is held until the next real trade, then moves vertically to that trade's open. Nothing is interpolated, no
 * diagonal segment implies movement that did not trade, and a silence longer than PRICE_MAX_HOLD_MS breaks the trace.
 * -------------------------------------------------------------------------- */

/** Price micro-candle buckets. The finest four are the AUTO choices for a live window; coarser ones only for zoom-out. */
export const PRICE_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000] as const;
/** AUTO micro-candle sizes for a live window (the first that gives candles with real OHLC range is used). */
export const PRICE_AUTO_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000] as const;
/** Minimum on-screen slot per micro-candle (px) - a body plus a gap stays readable. */
export const PRICE_MIN_BUCKET_PX = 3;
/** AUTO window: aim for this many real micro-candles (fewer when the market is genuinely quiet). */
export const PRICE_TARGET_CANDLES = 140;
/** A bucket size is dense enough when at least this share of its slots in the window hold a real candle. */
export const PRICE_MIN_FILL = 0.5;
/** AUTO: at least this many real candles in the window ... */
export const PRICE_MIN_CANDLES = 80;
/** ... holding on average at least this many real trades each (so a candle has a genuine open / high / low / close). */
export const PRICE_MIN_TRADES_PER_CANDLE = 3;
/** AUTO window never reaches back further than this (no stale backlog to fill space). */
export const PRICE_MAX_WINDOW_MS = 15 * 60_000;
/** Smallest AUTO window (ms). */
export const PRICE_MIN_WINDOW_MS = 20_000;
/** A silence longer than this (no trade at all) breaks the close trace instead of drawing a flat hold across it. */
export const PRICE_MAX_HOLD_MS = 15 * 60_000;

/** First index with t > x (trades sorted by time). */
export function upperBound(trades: readonly DisplayTrade[], x: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (trades[m]!.t <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Number of time buckets of `ms` that hold at least one real trade in [from, to). */
export function filledBuckets(trades: readonly DisplayTrade[], ms: number, from = 0, to = trades.length): number {
  let n = 0;
  let prev = NaN;
  for (let i = from; i < to; i++) {
    const b = Math.floor(trades[i]!.t / ms);
    if (b !== prev) {
      n++;
      prev = b;
    }
  }
  return n;
}

export interface PriceWindow {
  /** Micro-candle bucket (ms). */
  ms: number;
  /** Window length ending at tEnd (ms). */
  span: number;
  /** Real micro-candles inside the window. */
  candles: number;
}

/**
 * AUTO price window ending at the latest exchange time. For each size in PRICE_AUTO_BUCKETS_MS (finest first) the most
 * recent real trades are walked back until PRICE_TARGET_CANDLES candles (or the readable / PRICE_MAX_WINDOW_MS limit);
 * the first size giving >= PRICE_MIN_CANDLES candles of >= PRICE_MIN_TRADES_PER_CANDLE trades each on average is used.
 * A quiet market that never reaches that gets the coarsest size over the widest allowed window - fewer candles,
 * honestly. Only trades at or before tEnd are used.
 */
export function autoPriceWindow(trades: readonly DisplayTrade[], tEnd: number, plotPx: number): PriceWindow {
  const w = Math.max(1, plotPx);
  const end = upperBound(trades, tEnd);
  const scan = (ms: number) => {
    const maxSpan = Math.min(PRICE_MAX_WINDOW_MS, (w * ms) / PRICE_MIN_BUCKET_PX);
    let count = 0;
    let n = 0;
    let prev = NaN;
    let start = tEnd;
    for (let i = end - 1; i >= 0; i--) {
      const t = trades[i]!.t;
      if (t < tEnd - maxSpan) break;
      const b = Math.floor(t / ms);
      if (b !== prev) {
        if (count === PRICE_TARGET_CANDLES) break;
        count++;
        prev = b;
        start = b * ms;
      }
      n++;
    }
    const span = Math.min(maxSpan, Math.max(PRICE_MIN_WINDOW_MS, tEnd - start + ms));
    return { win: { ms, span, candles: count }, perCandle: count ? n / count : 0 };
  };
  for (const ms of PRICE_AUTO_BUCKETS_MS) {
    const r = scan(ms);
    if (r.win.candles >= PRICE_MIN_CANDLES && r.perCandle >= PRICE_MIN_TRADES_PER_CANDLE) return r.win;
  }
  return scan(PRICE_AUTO_BUCKETS_MS[PRICE_AUTO_BUCKETS_MS.length - 1]!).win;
}

/**
 * Price bucket for an arbitrary (zoomed / panned) window: the finest bucket with at least PRICE_MIN_BUCKET_PX per slot
 * whose slots are at least PRICE_MIN_FILL filled by real trades (from 1 s up, the first readable one).
 */
export function priceBucketFor(trades: readonly DisplayTrade[], t0: number, t1: number, plotPx: number): number {
  const span = Math.max(1, t1 - t0);
  const from = lowerBound(trades, t0);
  const to = upperBound(trades, t1);
  for (const ms of PRICE_BUCKETS_MS) {
    if ((Math.max(1, plotPx) * ms) / span < PRICE_MIN_BUCKET_PX) continue;
    if (ms >= 1000 || filledBuckets(trades, ms, from, to) / (span / ms) >= PRICE_MIN_FILL) return ms;
  }
  return PRICE_BUCKETS_MS[PRICE_BUCKETS_MS.length - 1]!;
}

/** One horizontal / vertical step-trace segment in (time, tick) space. */
export type StepPoint = [t: number, tick: number];

/**
 * Step trace through the micro-candles: inside a bucket open -> close at the bucket centre, then the close is held
 * (flat) until the next bucket's centre and steps vertically to its open. `until` extends the last hold to a real,
 * later exchange time (no trade since = price unchanged). Returns runs of points (a gap > maxHold starts a new run).
 */
export function stepTrace(bars: readonly PriceBar[], ms: number, until: number | null = null, maxHold = PRICE_MAX_HOLD_MS): StepPoint[][] {
  const runs: StepPoint[][] = [];
  let run: StepPoint[] = [];
  let prev: PriceBar | null = null;
  for (const b of bars) {
    const mid = b.t + ms / 2;
    if (prev && b.t - (prev.t + ms) > maxHold) {
      runs.push(run);
      run = [];
      prev = null;
    }
    if (prev) run.push([mid, prev.c]); // hold the previous close until this trade, never a diagonal
    run.push([mid, b.o], [mid, b.c]);
    prev = b;
  }
  if (prev && until !== null && until > prev.t + ms / 2 && until - (prev.t + ms) <= maxHold) run.push([until, prev.c]);
  if (run.length) runs.push(run);
  return runs;
}

/** The browser's newest trade may trail the feed's exchange clock by this much before the chart says it is catching up. */
export const CATCH_UP_LAG_MS = 60_000;

/**
 * Trade history still arriving (e.g. right after a bridge restart the oldest trades come first): returns the exchange
 * time of the newest trade received so far when it trails the feed clock by more than CATCH_UP_LAG_MS, else null.
 * A quiet market is NOT flagged - there the feed clock (last event) and the newest trade move together.
 */
export function catchUpFrom(latestTradeTime: number | null, feedTime: number | null, lag = CATCH_UP_LAG_MS): number | null {
  if (latestTradeTime === null || feedTime === null) return null;
  return feedTime - latestTradeTime > lag ? latestTradeTime : null;
}
