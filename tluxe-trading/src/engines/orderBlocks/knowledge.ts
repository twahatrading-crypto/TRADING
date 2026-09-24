import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { OB_TF_SECONDS, OB_TIMEFRAMES, type OBSettings } from './config';
import { OrderBlockTimeframeEngine } from './engine';
import { buildOBMulti } from './mtf';
import type { OBMultiSnapshot, OBSnapshot } from './types';

/* Knowledge cutoff for Order Block replay (independent copy):
 *   a bar is KNOWN at K ⇔ it is closed and bar.time + tfSeconds ≤ K. */

export const obBarClose = (c: Candle, tf: Timeframe) => c.time + OB_TF_SECONDS[tf];

export function obClosedOnly(candles: readonly Candle[]): Candle[] {
  if (candles.some((c) => c.isClosed !== undefined)) return candles.filter((c) => c.isClosed === true);
  return candles.slice(0, Math.max(0, candles.length - 1));
}

export function obKnownBy(candles: readonly Candle[], tf: Timeframe, k: number): readonly Candle[] {
  const sec = OB_TF_SECONDS[tf];
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time + sec <= k) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(0, lo);
}

export interface OBDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  settings: OBSettings;
  candles: Partial<Record<Timeframe, readonly Candle[]>>;
}

/** Clean recomputation: brand-new engines per timeframe fed only the bars known at K. */
export function analyzeOBAt(ds: OBDataset, k: number, price: number | null): OBMultiSnapshot {
  const byTimeframe: Partial<Record<Timeframe, OBSnapshot>> = {};
  for (const tf of OB_TIMEFRAMES) {
    const c = ds.candles[tf];
    if (!c) continue;
    const e = new OrderBlockTimeframeEngine({ instrumentId: ds.instrumentId, timeframe: tf, tickSize: ds.tickSize, settings: ds.settings });
    e.update(obKnownBy(c, tf, k), { lastBarClosed: true, currentPrice: price });
    byTimeframe[tf] = e.snapshot();
  }
  return buildOBMulti(ds.instrumentId, byTimeframe, ds.settings);
}
