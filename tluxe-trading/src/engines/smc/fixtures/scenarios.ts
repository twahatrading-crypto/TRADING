/**
 * TEST DATA ONLY — hand-built SMC scenarios (single timeframe, M15 unless stated). Every value is
 * synthetic; used only by tests and the bannered dev harness.
 */
import type { Candle } from '../../../types/market';
import { candles, mirror, path } from './builders';

/** Quiet warm-up so ATR and history are established (≈ 60 bars around 100). */
export const warm = (): [number, number][] => [
  [101, 6], [99.5, 6], [101, 6], [99.5, 6], [101, 6], [99.5, 6], [101, 6], [99.5, 6], [101, 6], [100, 6],
];

/** Rising structure: HH / HL swings and bullish BOS closes. */
export const bullishTrend = (): Candle[] => candles(path(100, ...warm(), [106, 6], [103.5, 5], [109, 6], [106.5, 5], [112, 6], [109.5, 5], [115, 6], [113, 5], [114, 4]));
/** Falling structure (mirror of the rising one). */
export const bearishTrend = (): Candle[] => mirror(bullishTrend(), 100);
/** Sideways oscillation: no sustained trend. */
export const range = (): Candle[] => candles(path(100, ...warm(), ...Array.from({ length: 30 }, (_, k): [number, number] => [k % 2 ? 99 : 101.5, 6])));

/**
 * Bearish trend, then a sell-side sweep and a bullish reversal: the retest bar (index 95) wicks
 * below the prior low 89.7 and closes back above it (SSL sweep), strong bullish displacement, close
 * above the last LH (bullish CHOCH), then a higher high (bullish BOS).
 */
export const SWEEP_BAR = 95;
export const bullishReversal = (): Candle[] => {
  const closes = path(100, ...warm(), [95, 6], [97, 5], [92, 6], [94.5, 5], [90, 6], [92, 4], [90.4, 4], [96.5, 4], [95, 4], [99, 5], [97.5, 4], [98, 4]);
  return candles(closes, { ov: { [SWEEP_BAR]: { low: 89.4 } } });
};
export const bearishReversal = (): Candle[] => mirror(bullishReversal(), 100);
