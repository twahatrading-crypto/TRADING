import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { LIQUIDITY_TF_SECONDS, LIQUIDITY_TIMEFRAMES, type LiquiditySettings } from './config';
import { LiquidityTimeframeEngine } from './engine';
import { buildLiquidityMulti } from './mtf';
import type { LiquidityMultiSnapshot, LiquiditySnapshot } from './types';

/*
 * Knowledge cutoff for Liquidity replay (independent of S&R's):
 *   a bar is KNOWN at time K ⇔ it is closed and bar.time + tfSeconds ≤ K.
 */

export const liquidityBarClose = (c: Candle, tf: Timeframe) => c.time + LIQUIDITY_TF_SECONDS[tf];

export function closedOnly(candles: readonly Candle[]): Candle[] {
  if (candles.some((c) => c.isClosed !== undefined)) return candles.filter((c) => c.isClosed === true);
  return candles.slice(0, Math.max(0, candles.length - 1));
}

export function knownBy(candles: readonly Candle[], tf: Timeframe, k: number): readonly Candle[] {
  const sec = LIQUIDITY_TF_SECONDS[tf];
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time + sec <= k) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(0, lo);
}

export interface LiquidityDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  settings: LiquiditySettings;
  candles: Partial<Record<Timeframe, readonly Candle[]>>;
}

/** No-future oracle: brand-new engines per timeframe fed only the bars known at K. */
export function analyzeLiquidityAt(ds: LiquidityDataset, k: number, price: number | null): LiquidityMultiSnapshot {
  const byTimeframe: Partial<Record<Timeframe, LiquiditySnapshot>> = {};
  for (const tf of LIQUIDITY_TIMEFRAMES) {
    const c = ds.candles[tf];
    if (!c) continue;
    const e = new LiquidityTimeframeEngine({ instrumentId: ds.instrumentId, timeframe: tf, tickSize: ds.tickSize, settings: ds.settings });
    e.update(knownBy(c, tf, k), { lastBarClosed: true, currentPrice: price });
    byTimeframe[tf] = e.snapshot();
  }
  return buildLiquidityMulti(ds.instrumentId, byTimeframe, ds.settings);
}
