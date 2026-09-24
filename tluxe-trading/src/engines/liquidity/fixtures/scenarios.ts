/**
 * TEST FIXTURES ONLY — named deterministic Liquidity scenarios (H1 clock unless noted).
 * Moves ≈ 1.5/bar with 0.5 wicks → ATR ≈ 2.5, tolerance ≈ 0.25, test band ≈ 0.375.
 * Warm-up oscillates 100–106 so ATR and history requirements are established;
 * the scenario level of interest is always ~130 (far from the warm-up pools).
 */
import type { Candle } from '../../../types/market';
import { bars, mirror, path, warm } from './builders';

const base = () => path(100, ...warm(100), [130, 16]);
const n0 = () => base().length - 1; // index of the first 130 high (the swing bar)

/** Clean BSL: one swing high at 130.5, price leaves decisively and ranges lower. */
export function cleanBSL(): Candle[] {
  return bars([...base(), ...path(130, [115, 10], [117, 6], [115, 6], [117, 6]).slice(1)]);
}
export const cleanSSL = () => mirror(cleanBSL(), 150);

/** Equal highs: two swing highs, the second 0.1 higher (inside tolerance). */
export function eqh(secondDelta = 0.1): Candle[] {
  const closes = [...base(), ...path(130, [118, 8], [130, 8], [116, 10], [118, 6], [116, 6]).slice(1)];
  const second = n0() + 16;
  return bars(closes, { hl: { [second]: { high: 130.5 + secondDelta } } });
}
export const eql = (d = 0.1) => mirror(eqh(d), 150);

/** Highs outside tolerance: the second rally peaks ~1.5 lower (high 129.0) → two separate pools. */
export function highsOutsideTolerance(): Candle[] {
  return bars([...base(), ...path(130, [118, 8], [128.5, 7], [116, 10], [118, 6], [116, 6]).slice(1)]);
}
export const lowsOutsideTolerance = () => mirror(highsOutsideTolerance(), 150);

/** BSL wick sweep + same-bar reclaim, then price falls away. */
export function bslWickSweepReclaim(): Candle[] {
  const closes = [...base(), ...path(130, [118, 8], [129, 7]).slice(1), 129.2, ...path(129.2, [115, 10], [117, 6]).slice(1)];
  const sweep = n0() + 16;
  return bars(closes, { hl: { [sweep]: { high: 131.6, close: 129.2 } } });
}
export const sslWickSweepReclaim = () => mirror(bslWickSweepReclaim(), 150);

/** BSL taken and accepted: consecutive closes well above → continuation (CONSUMED). */
export function bslBreakContinuation(): Candle[] {
  // The crossing bar closes at 133 (beyond the band), then closes keep holding above → accepted.
  return bars([...base(), ...path(130, [118, 8], [129, 7], [133, 1], [138, 5], [145, 8], [144, 6]).slice(1)]);
}
export const sslBreakContinuation = () => mirror(bslBreakContinuation(), 150);

/** Wick sweep + reclaim, then later a second wick above the same level → repeated sweep. */
export function repeatedSweep(): Candle[] {
  const first = [...base(), ...path(130, [118, 8], [129, 7]).slice(1), 129.2, ...path(129.2, [120, 6], [129, 6]).slice(1), 129.1, ...path(129.1, [116, 8], [118, 6]).slice(1)];
  const s1 = n0() + 16;
  const s2 = s1 + 1 + 12;
  return bars(first, { hl: { [s1]: { high: 131.6, close: 129.2 }, [s2]: { high: 131.8, close: 129.1 } } });
}

/** Consumed, then price comes back below: the pool must stay CONSUMED (no new sweeps). */
export function consumedThenReturn(): Candle[] {
  return bars([...base(), ...path(130, [118, 8], [129, 7], [133, 1], [138, 5], [140, 4], [120, 10], [134, 8], [125, 6]).slice(1)]);
}

/** Tested but not swept: price returns into the test band (high 130.2) and leaves. */
export function testedUnswept(): Candle[] {
  const closes = [...base(), ...path(130, [118, 8], [129.5, 8], [116, 10], [118, 6]).slice(1)];
  const probe = n0() + 16;
  return bars(closes, { hl: { [probe]: { high: 130.2 } } });
}
