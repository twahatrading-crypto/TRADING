import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { VP_TF_SECONDS, VP_TIMEFRAMES, type VPSettings } from './config';
import { VolumeProfileEngine, type VPInput } from './engine';
import type { VPSnapshot } from './types';
import type { InstrumentVolumeContext } from './volume';

export const vpBarClose = (c: Candle, tf: Timeframe) => c.time + VP_TF_SECONDS[tf];

/** Provider-flagged streams: closed bars only. Unflagged: everything but the newest (forming) bar. */
export function vpClosedOnly(candles: readonly Candle[]): Candle[] {
  if (candles.some((c) => c.isClosed !== undefined)) return candles.filter((c) => c.isClosed === true);
  return candles.slice(0, Math.max(0, candles.length - 1));
}
export function vpKnownBy(candles: readonly Candle[], tf: Timeframe, K: number): readonly Candle[] {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (vpBarClose(candles[m]!, tf) <= K) lo = m + 1;
    else hi = m;
  }
  return candles.slice(0, lo);
}
export interface VPDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  instrument: InstrumentVolumeContext;
  settings: VPSettings;
  candles: VPInput;
}
export function vpKnownInput(ds: VPDataset, K: number): VPInput {
  const out: VPInput = {};
  for (const tf of VP_TIMEFRAMES) out[tf] = vpKnownBy(ds.candles[tf] ?? [], tf, K);
  return out;
}
export function vpKnowledgeTimes(ds: VPDataset): number[] {
  const set = new Set<number>();
  for (const tf of VP_TIMEFRAMES) for (const c of ds.candles[tf] ?? []) set.add(vpBarClose(c, tf));
  return [...set].sort((a, b) => a - b);
}
/** Clean recomputation from ONLY the candles closed by K (the anti-repaint reference). */
export function analyzeVPAt(ds: VPDataset, K: number, price: number | null = null): VPSnapshot {
  const e = new VolumeProfileEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, instrument: ds.instrument, settings: ds.settings });
  e.update(vpKnownInput(ds, K), { currentPrice: price });
  return e.snapshot();
}
