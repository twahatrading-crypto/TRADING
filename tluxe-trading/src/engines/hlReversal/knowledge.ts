import type { InstrumentId } from '../../types/instruments';
import type { Candle } from '../../types/market';
import { HLR_TF_SECONDS, HLR_TIMEFRAMES, type HLRSettings } from './config';
import { HighLowReversalEngine, type HLRInput } from './engine';
import type { HLRSnapshot, HLRTimeframe } from './types';

/** A bar is knowable once it has closed: open time + timeframe ≤ K. */
export const hlrBarClose = (c: Candle, tf: HLRTimeframe) => c.time + HLR_TF_SECONDS[tf];

/** Provider-flagged streams: closed bars only. Unflagged: everything but the newest (forming) bar. */
export function hlrClosedOnly(candles: readonly Candle[]): Candle[] {
  if (candles.some((c) => c.isClosed !== undefined)) return candles.filter((c) => c.isClosed === true);
  return candles.slice(0, Math.max(0, candles.length - 1));
}

export function hlrKnownBy(candles: readonly Candle[], tf: HLRTimeframe, K: number): Candle[] {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (hlrBarClose(candles[m]!, tf) <= K) lo = m + 1;
    else hi = m;
  }
  return candles.slice(0, lo);
}

export interface HLRDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  settings: HLRSettings;
  /** Closed candles per timeframe, ascending. */
  candles: HLRInput;
}

export function hlrKnownInput(ds: HLRDataset, K: number): HLRInput {
  const out: HLRInput = {};
  for (const tf of HLR_TIMEFRAMES) out[tf] = hlrKnownBy(ds.candles[tf] ?? [], tf, K);
  return out;
}

/** Every distinct knowledge time in the dataset (ascending). */
export function hlrKnowledgeTimes(ds: HLRDataset): number[] {
  const set = new Set<number>();
  for (const tf of HLR_TIMEFRAMES) for (const c of ds.candles[tf] ?? []) set.add(hlrBarClose(c, tf));
  return [...set].sort((a, b) => a - b);
}

/** Clean recomputation from ONLY the bars known at K (the anti-repaint reference). */
export function analyzeHLRAt(ds: HLRDataset, K: number, currentPrice?: number | null): HLRSnapshot {
  const e = new HighLowReversalEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings: ds.settings });
  e.update(hlrKnownInput(ds, K), currentPrice === undefined ? {} : { currentPrice });
  return e.snapshot();
}
