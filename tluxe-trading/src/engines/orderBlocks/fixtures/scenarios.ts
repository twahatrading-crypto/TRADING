/**
 * TEST FIXTURES ONLY — named deterministic Order Block scenarios (H1 clock).
 * Bullish template: downtrend (lower high 95.5, low ~85.5) → bounce to 88 → ONE bearish
 * origin candle 88 → 86.5 (low 86.0) → 3 large bullish candles closing 97.5, above the
 * confirmed swing high 95.5 (CHOCH) → hold ~100. Zone (wickBody) = [86.0, 88.0], height 2.
 * Bearish scenarios mirror around 150.
 */
import type { Candle } from '../../../types/market';
import { bars, mirror, path, warm } from './builders';

const pre = () => path(100, ...warm(), [90, 5], [95, 3], [86, 5], [88, 2]);
/** Index of the origin candle in every bullish template. */
export const ORIGIN = () => pre().length;
const launch = () => [...pre(), 86.5, 90, 94, 97.5];
const hold = () => path(97.5, [100, 3], [99, 3], [101, 3], [100, 3]).slice(1);
const base = () => [...launch(), ...hold()];

export const cleanBullish = (): Candle[] => bars([...base(), ...path(100, [99.5, 6], [101, 6]).slice(1)]);
export const cleanBearish = (): Candle[] => mirror(cleanBullish(), 150);

/** Strong bullish displacement that stops BELOW the swing high (94.5 < 95.5) → no BOS → no block. */
export const bullDisplacementNoBOS = (): Candle[] => bars([...pre(), 86.5, 89.5, 92.5, 94.5, ...path(94.5, [90, 6], [91, 6], [90, 6]).slice(1)]);
export const bearDisplacementNoBOS = (): Candle[] => mirror(bullDisplacementNoBOS(), 150);

/** Weak grind through the swing high (small bodies, frequent down candles) → break but no block. */
export function weakMove(): Candle[] {
  const grind: number[] = [];
  let p = 86.5;
  for (let k = 0; k < 24; k++) {
    p += k % 3 === 2 ? -0.3 : 0.75;
    grind.push(p);
  }
  return bars([...pre(), 86.5, ...grind, ...path(p, [p + 1, 6]).slice(1)], { wick: 0.3 });
}

/** Two consecutive bearish candles before the displacement (88 → 87.2 → 86.5). */
export const multipleOrigins = (): Candle[] => bars([...path(100, ...warm(), [90, 5], [95, 3], [86, 5], [88, 2]), 87.2, 86.5, 90, 94, 97.5, ...hold(), ...path(100, [99.5, 6]).slice(1)]);

/** After confirmation: pull back and dip into the zone with a given low (and close), then leave. */
function retestWith(low: number, close = 88.6): Candle[] {
  const closes = [...base(), ...path(100, [89, 6]).slice(1), close, ...path(close, [96, 5], [98, 6]).slice(1)];
  const dip = base().length + 5;
  return bars(closes, { ov: { [dip]: { low, close } } });
}
export const retest = () => retestWith(87.6); // 20 % penetration → TESTED
export const partialMitigation = () => retestWith(87.4); // 30 % → TESTED
export const fullMitigation = () => retestWith(86.6); // 70 % → MITIGATED
export const invalidation = () => retestWith(85.2, 85.5); // close 85.5 < 86.0 → INVALIDATED
/** Same-bar edge: wick through the ENTIRE zone (low 85.0) but close back inside (87.0) → MITIGATED 100 %, not invalidated. */
export const wickThroughCloseInside = () => retestWith(85.0, 87.0);
