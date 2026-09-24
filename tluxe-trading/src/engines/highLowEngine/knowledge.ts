import type { InstrumentId } from '../../types/instruments';
import type { Candle } from '../../types/market';
import { HLE_TF_SECONDS, HLE_TIMEFRAMES, type HLESettings } from './config';
import { HighLowEngine, type HLEInput } from './engine';
import type { HLESnapshot, HLETimeframe } from './types';

/** A bar is knowable once it has closed: open time + timeframe ≤ K. */
export const hleBarClose = (c: Candle, tf: HLETimeframe) => c.time + HLE_TF_SECONDS[tf];

/** Provider-flagged streams: closed bars only. Unflagged: everything but the newest (forming) bar. */
export function hleClosedOnly(candles: readonly Candle[]): Candle[] {
  if (candles.some((c) => c.isClosed !== undefined)) return candles.filter((c) => c.isClosed === true);
  return candles.slice(0, Math.max(0, candles.length - 1));
}

export function hleKnownBy(candles: readonly Candle[], tf: HLETimeframe, K: number): Candle[] {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (hleBarClose(candles[m]!, tf) <= K) lo = m + 1;
    else hi = m;
  }
  return candles.slice(0, lo);
}

export interface HLEDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  settings: HLESettings;
  /** Closed candles per timeframe, ascending. */
  candles: HLEInput;
}

export function hleKnownInput(ds: HLEDataset, K: number): HLEInput {
  const out: HLEInput = {};
  for (const tf of HLE_TIMEFRAMES) out[tf] = hleKnownBy(ds.candles[tf] ?? [], tf, K);
  return out;
}

/** Every distinct knowledge time in the dataset (ascending). */
export function hleKnowledgeTimes(ds: HLEDataset): number[] {
  const set = new Set<number>();
  for (const tf of HLE_TIMEFRAMES) for (const c of ds.candles[tf] ?? []) set.add(hleBarClose(c, tf));
  return [...set].sort((a, b) => a - b);
}

/** Clean recomputation from ONLY the bars known at K (the anti-repaint reference). */
export function analyzeHLEAt(ds: HLEDataset, K: number, currentPrice?: number | null): HLESnapshot {
  const e = new HighLowEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings: ds.settings });
  e.update(hleKnownInput(ds, K), currentPrice === undefined ? {} : { currentPrice });
  return e.snapshot();
}
