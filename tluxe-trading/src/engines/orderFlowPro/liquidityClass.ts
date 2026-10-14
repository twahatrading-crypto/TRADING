import { toTick } from './classify';
import type { DepthRecorder, LevelStat } from './depthRecorder';
import type { Side } from './types';

/* ============================================================================
 * Order Flow Pro - STRONG / MEDIUM resting-liquidity classes (VISUALIZATION ONLY).
 *
 * Reads the page's existing DepthRecorder (IBKR price-level book observed live) and, optionally, the gateway's
 * recorded depth for the same contract (one /api/ibkr/heatmap read). It never writes to either and never changes
 * the existing strong-level detector, its alerts or the reversal detector.
 *
 * Rules (every number is a parameter, see DEFAULT_LIQ_PARAMS):
 *   reference  = the time-weighted average displayed size of every recorded price/side cell over the lookback
 *                (valid book time only, 15 s cells), for THIS instrument - its own recent book, not a universal number
 *   STRONG     = displayed size now >= the strongPct quantile of the reference (strongMin) AND displayed at >= strongMin
 *                for >= minPersistMs (observed live, 15 s cells)
 *   MEDIUM     = displayed size now >= the mediumPct quantile (mediumMin) AND displayed at >= mediumMin for
 *                >= mediumPersistMs
 *   bands      = runs of >= minBandColumns consecutive valid 15 s cells with average >= mediumMin (STRONG when the
 *                run's mean average >= strongMin), recorded or live - drawn only where observed
 *   withheld   = less than minHistoryMs of valid recorded book time in the lookback ("collecting depth history"),
 *                or the book is not valid now (stale / disconnected / contract mismatch)
 * Sizes are IBKR DISPLAYED AGGREGATE CONTRACTS per price level - never an order count. Resting liquidity can be
 * pulled at any time; a class says nothing about whether a trade will happen there.
 * ========================================================================== */

export type LiqClass = 'STRONG' | 'MEDIUM';

export interface LiquidityParams {
  lookbackMs: number;
  /** Quantiles (0..1) of the reference distribution. */
  strongPct: number;
  mediumPct: number;
  minPersistMs: number;
  mediumPersistMs: number;
  /** Valid recorded book time needed before any class is shown. */
  minHistoryMs: number;
  /** Consecutive 15 s cells for a historical band. */
  minBandColumns: number;
  /** A cell counts only when its column has at least this share of valid time. */
  minValidShare: number;
}

export const DEFAULT_LIQ_PARAMS: LiquidityParams = {
  lookbackMs: 30 * 60_000,
  strongPct: 0.9,
  mediumPct: 0.75,
  minPersistMs: 60_000,
  mediumPersistMs: 30_000,
  minHistoryMs: 10 * 60_000,
  minBandColumns: 4,
  minValidShare: 0.5,
};

/** One 15 s column of observed displayed size (time-weighted average per price/side over its valid time). */
export interface RefColumn {
  t: number;
  validMs: number;
  cells: Array<{ tick: number; side: Side; avg: number }>;
  source: 'RECORDED' | 'LIVE';
}

/** Recorded depth for one contract, already validated (gatewayMap.parseHeatmap) - prices on the tick grid. */
export interface RecordedSeed {
  contract: string;
  bucketMs: number;
  columns: Array<{ t: number; coverage: number; bids: Array<[number, number]>; asks: Array<[number, number]> }>;
}

export interface ClassifiedLevel {
  tick: number;
  price: number;
  side: Side;
  cls: LiqClass;
  /** Displayed aggregate contracts at this price level now. */
  size: number;
  /** Observed continuous resting time. */
  persistMs: number;
  /** True when the level was already displayed when the current valid observation began: persistMs is a minimum. */
  persistAtLeast: boolean;
  /** Quantile of `size` within the reference (0..1). */
  quantile: number;
}

export interface LiqBand {
  tick: number;
  side: Side;
  cls: LiqClass;
  from: number;
  to: number;
  meanAvg: number;
  maxAvg: number;
  source: 'RECORDED' | 'LIVE' | 'MIXED';
}

export type LiqStatus = 'READY' | 'COLLECTING' | 'NO_BOOK';

export interface LiquidityOverlay {
  status: LiqStatus;
  /** Valid recorded book time inside the lookback (recorded seed + live recorder). */
  historyMs: number;
  recordedMs: number;
  liveMs: number;
  /** Thresholds in displayed contracts (null while collecting). */
  strongMin: number | null;
  mediumMin: number | null;
  samples: number;
  levels: ClassifiedLevel[];
  bands: LiqBand[];
  params: LiquidityParams;
}

/** Quantile by the nearest-rank method on an ascending array. */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

/** Share of reference values <= v (0..1). */
export function rankOf(sorted: readonly number[], v: number): number {
  if (!sorted.length) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m]! <= v) lo = m + 1;
    else hi = m;
  }
  return lo / sorted.length;
}

/**
 * Reference columns for [from, to]: the recorded seed only BEFORE the live recorder's first column (never both for
 * the same time - nothing is counted twice), then the live recorder's own columns.
 */
export function referenceColumns(rec: DepthRecorder, seed: RecordedSeed | null, from: number, to: number): RefColumn[] {
  const live = rec.columnsIn(from, to);
  const firstLive = live.length ? live[0]!.t : Infinity;
  const out: RefColumn[] = [];
  if (seed && seed.bucketMs === rec.bucketMs) {
    for (const c of seed.columns) {
      if (c.t + seed.bucketMs <= from || c.t > to || c.t >= firstLive) continue;
      const cells: RefColumn['cells'] = [];
      for (const [p, s] of c.bids) if (s > 0) cells.push({ tick: toTick(p, rec.tick), side: 'BID', avg: s });
      for (const [p, s] of c.asks) if (s > 0) cells.push({ tick: toTick(p, rec.tick), side: 'ASK', avg: s });
      out.push({ t: c.t, validMs: c.coverage * seed.bucketMs, cells, source: 'RECORDED' });
    }
  }
  for (const c of live) {
    if (c.validMs <= 0) continue;
    const cells: RefColumn['cells'] = [];
    for (const cell of c.cells.values()) if (cell.sizeMs > 0) cells.push({ tick: cell.tick, side: cell.side, avg: cell.sizeMs / c.validMs });
    out.push({ t: c.t, validMs: c.validMs, cells, source: 'LIVE' });
  }
  return out;
}

/**
 * Observed resting time AT A CLASS SIZE: how long this price/side has been displayed at >= `min` contracts, from the
 * live recorder's own 15 s cells (time-weighted average >= min in every cell back to the start), capped by the
 * level's continuous display time. A size jump (2 -> 40 contracts) therefore starts the clock at the jump - it never
 * inherits the time the price level was displayed at a smaller size. Conservative at 15 s granularity: when the run
 * is ended by a smaller-size / missing cell, its oldest cell may be only partly at size and is NOT counted (the
 * result can understate by < 15 s, never overstate). A run reaching the first observed cell keeps it (that level is
 * then marked "at least" by the caller).
 */
function restingAtSize(cells: ReadonlyMap<number, number> | undefined, liveTs: readonly number[], min: number, persistMs: number, now: number, bucketMs: number): number {
  if (!cells) return 0;
  let start = now;
  let broken = false;
  for (let i = liveTs.length - 1; i >= 0; i--) {
    const t = liveTs[i]!;
    if ((i < liveTs.length - 1 && liveTs[i + 1] !== t + bucketMs) || (cells.get(t) ?? 0) < min) {
      broken = true;
      break;
    }
    start = t;
  }
  if (broken && start < now) start = Math.min(now, start + bucketMs);
  return Math.max(0, Math.min(persistMs, now - start));
}

/**
 * Resting time is only known from the current valid observation: after a (re)sync every level of the snapshot gets
 * the snapshot time as its start. The earliest start among the current levels is therefore the start of the
 * observation; a level resting at its class size since then (within one 15 s cell) may have rested longer and is
 * marked persistAtLeast. (Conservative: if no snapshot level survives, no level is near that start.)
 */
export function classifyLevels(stats: readonly LevelStat[], ref: readonly number[], strongMin: number, mediumMin: number, now: number, p: LiquidityParams, live: readonly RefColumn[] = [], bucketMs = 15_000): ClassifiedLevel[] {
  const out: ClassifiedLevel[] = [];
  let observedFrom = Infinity;
  for (const s of stats) observedFrom = Math.min(observedFrom, now - s.persistMs);
  const key = (tick: number, side: Side) => tick * 2 + (side === 'ASK' ? 1 : 0);
  const liveCols = live.filter((c) => c.source === 'LIVE' && c.validMs >= bucketMs * p.minValidShare);
  const liveTs = liveCols.map((c) => c.t);
  const byKey = new Map<number, Map<number, number>>();
  for (const c of liveCols)
    for (const cell of c.cells) {
      const k = key(cell.tick, cell.side);
      let m = byKey.get(k);
      if (!m) byKey.set(k, (m = new Map()));
      m.set(c.t, cell.avg);
    }
  for (const s of stats) {
    const cells = byKey.get(key(s.tick, s.side));
    let cls: LiqClass | null = null;
    let rest = 0;
    if (s.size >= strongMin && (rest = restingAtSize(cells, liveTs, strongMin, s.persistMs, now, bucketMs)) >= p.minPersistMs) cls = 'STRONG';
    else if (s.size >= mediumMin && (rest = restingAtSize(cells, liveTs, mediumMin, s.persistMs, now, bucketMs)) >= p.mediumPersistMs) cls = 'MEDIUM';
    if (!cls) continue;
    out.push({ tick: s.tick, price: s.price, side: s.side, cls, size: s.size, persistMs: rest, persistAtLeast: now - rest <= observedFrom + bucketMs, quantile: rankOf(ref, s.size) });
  }
  return out.sort((a, b) => (a.cls === b.cls ? b.size - a.size : a.cls === 'STRONG' ? -1 : 1));
}

/** Historical bands: runs of consecutive valid cells >= MEDIUM threshold; STRONG when the run's mean is >= STRONG. */
export function classifyBands(cols: readonly RefColumn[], bucketMs: number, strongMin: number, mediumMin: number, p: LiquidityParams): LiqBand[] {
  type Run = { tick: number; side: Side; from: number; to: number; n: number; sum: number; max: number; rec: number; live: number };
  const out: LiqBand[] = [];
  const active = new Map<number, Run>();
  const key = (tick: number, side: Side) => tick * 2 + (side === 'ASK' ? 1 : 0);
  const close = (k: number) => {
    const r = active.get(k)!;
    active.delete(k);
    if (r.n < p.minBandColumns) return;
    const mean = r.sum / r.n;
    out.push({ tick: r.tick, side: r.side, cls: mean >= strongMin ? 'STRONG' : 'MEDIUM', from: r.from, to: r.to, meanAvg: mean, maxAvg: r.max, source: r.rec && r.live ? 'MIXED' : r.rec ? 'RECORDED' : 'LIVE' });
  };
  let prev: number | null = null;
  for (const c of cols) {
    if (prev !== null && c.t !== prev + bucketMs) for (const k of [...active.keys()]) close(k);
    prev = c.t;
    if (c.validMs < bucketMs * p.minValidShare) {
      for (const k of [...active.keys()]) close(k);
      continue;
    }
    const seen = new Set<number>();
    for (const cell of c.cells) {
      if (cell.avg < mediumMin) continue;
      const k = key(cell.tick, cell.side);
      seen.add(k);
      let r = active.get(k);
      if (!r) active.set(k, (r = { tick: cell.tick, side: cell.side, from: c.t, to: c.t, n: 0, sum: 0, max: 0, rec: 0, live: 0 }));
      r.to = c.t + bucketMs;
      r.n++;
      r.sum += cell.avg;
      r.max = Math.max(r.max, cell.avg);
      if (c.source === 'RECORDED') r.rec++;
      else r.live++;
    }
    for (const k of [...active.keys()]) if (!seen.has(k)) close(k);
  }
  for (const k of [...active.keys()]) close(k);
  return out;
}

/** The full overlay for one view: history status, thresholds, current classified levels and historical bands. */
export function liquidityOverlay(rec: DepthRecorder, seed: RecordedSeed | null, bookValid: boolean, now: number, p: LiquidityParams = DEFAULT_LIQ_PARAMS): LiquidityOverlay {
  const from = now - p.lookbackMs;
  const cols = referenceColumns(rec, seed, from, now);
  let recordedMs = 0;
  let liveMs = 0;
  const ref: number[] = [];
  for (const c of cols) {
    if (c.source === 'RECORDED') recordedMs += c.validMs;
    else liveMs += c.validMs;
    if (c.validMs < rec.bucketMs * p.minValidShare) continue;
    for (const cell of c.cells) ref.push(cell.avg);
  }
  ref.sort((a, b) => a - b);
  const historyMs = recordedMs + liveMs;
  const base = { historyMs, recordedMs, liveMs, samples: ref.length, params: p };
  if (historyMs < p.minHistoryMs || ref.length < 20) return { ...base, status: 'COLLECTING', strongMin: null, mediumMin: null, levels: [], bands: [] };
  const strongMin = quantile(ref, p.strongPct);
  const mediumMin = quantile(ref, p.mediumPct);
  const bands = classifyBands(cols, rec.bucketMs, strongMin, mediumMin, p);
  if (!bookValid) return { ...base, status: 'NO_BOOK', strongMin, mediumMin, levels: [], bands };
  const levels = classifyLevels(rec.levelStats(now), ref, strongMin, mediumMin, now, p, cols, rec.bucketMs);
  return { ...base, status: 'READY', strongMin, mediumMin, levels, bands };
}
