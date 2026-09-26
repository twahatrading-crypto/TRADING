import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { SMC_TF_SECONDS, SMC_TIMEFRAMES, type SmcSettings } from './config';
import { SmcEngine, type SmcInput } from './engine';
import type { SmcFeed, SmcSnapshot } from './types';

/** A bar is knowable once it has closed: open time + timeframe ≤ K. */
export const smcBarClose = (c: Candle, tf: Timeframe) => c.time + SMC_TF_SECONDS[tf];

/** Provider-flagged streams: closed bars only. Unflagged: everything but the newest (forming) bar. */
export function smcClosedOnly(candles: readonly Candle[]): Candle[] {
  if (candles.some((c) => c.isClosed !== undefined)) return candles.filter((c) => c.isClosed === true);
  return candles.slice(0, Math.max(0, candles.length - 1));
}

export function smcKnownBy(candles: readonly Candle[], tf: Timeframe, K: number): readonly Candle[] {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (smcBarClose(candles[m]!, tf) <= K) lo = m + 1;
    else hi = m;
  }
  return candles.slice(0, lo);
}

export interface SmcDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  settings: SmcSettings;
  /** Closed candles per timeframe, ascending. */
  candles: SmcInput;
}

export function smcKnownInput(ds: SmcDataset, K: number): SmcInput {
  const out: SmcInput = {};
  for (const tf of SMC_TIMEFRAMES) out[tf] = smcKnownBy(ds.candles[tf] ?? [], tf, K);
  return out;
}

/** Every distinct knowledge time in the dataset (ascending). */
export function smcKnowledgeTimes(ds: SmcDataset): number[] {
  const set = new Set<number>();
  for (const tf of SMC_TIMEFRAMES) for (const c of ds.candles[tf] ?? []) set.add(smcBarClose(c, tf));
  return [...set].sort((a, b) => a - b);
}

/** Clean recomputation from ONLY the candles closed by K (the anti-repaint reference). */
export function analyzeSmcAt(ds: SmcDataset, K: number, price: number | null = null, feed: SmcFeed = 'REPLAY'): SmcSnapshot {
  const e = new SmcEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings: ds.settings });
  e.update(smcKnownInput(ds, K), { currentPrice: price });
  return e.snapshot(feed);
}
