/**
 * TEST FIXTURES ONLY — named deterministic S&R scenarios (H1 unless noted).
 * Moves are ~1.5/bar with 0.5 wicks → ATR ≈ 2.5, so every rule threshold is
 * crossed (or deliberately not crossed) by a clear margin.
 */
import type { Candle, Timeframe } from '../../../types/market';
import { appendBars, fromCloses, mirror, path } from './builders';

/** Warm-up range so ATR is established and history requirements are met. */
const warmup = (from: number): [number, number][] => [
  [from + 6, 4], [from, 4], [from + 6, 4], [from, 4], [from + 6, 4], [from, 4],
];

/** Support formed at ~100, then two clean retests that reject strongly. */
export function strongSupport(tf: Timeframe = 'H1'): Candle[] {
  return fromCloses(
    path(130, ...warmup(124), [100, 16], [118, 12], [100.3, 12], [120, 12], [100.4, 12], [121, 12], [119, 6]),
    { tf },
  );
}

export const strongResistance = (tf: Timeframe = 'H1') => mirror(strongSupport(tf), 150);

/** Support formed at ~100; price leaves and never returns. */
export function freshLevel(): Candle[] {
  return fromCloses(path(130, ...warmup(124), [100, 16], [118, 12], [125, 20]));
}

/** Four separate visits that each reject. */
export function multipleTouches(): Candle[] {
  return fromCloses(
    path(130, ...warmup(124), [100, 16], [116, 10], [100.3, 10], [116, 10], [100.2, 10], [116, 10], [100.4, 10], [116, 10], [115, 4]),
  );
}

/**
 * Repeated shallow tests: each cycle touches the zone, separates (low above
 * F + 0.5 ATR) but never CLOSES ≥ 1 ATR away before returning → touches that
 * are not rejections. Bar ranges ≈ 2 keep ATR ≈ 2.
 */
export function repeatedWeakTests(): Candle[] {
  const base = fromCloses(path(130, ...warmup(124), [100, 16], [118, 12], [102, 10]));
  const cycle: [number, number, number, number][] = [
    [102, 102.6, 99.9, 100.6], // touch: low reaches the zone (face ≈ 100)
    [100.6, 102.4, 99.95, 101.6],
    [101.6, 102.9, 101.3, 101.8], // separated (low > F + 0.5 ATR), close only ~0.9 ATR away
    [101.8, 102.8, 101.2, 101.6],
  ];
  return appendBars(base, [...cycle, ...cycle, ...cycle, ...cycle, [101.6, 102.5, 101.2, 101.9], [101.9, 102.7, 101.4, 102]]);
}

/** Retest with one wick deep below the zone that closes back inside (sweep + reclaim), then a rally. */
export function sweepAndReclaim(): Candle[] {
  const closes = path(130, ...warmup(124), [100, 16], [118, 12], [100.4, 12], [100.6, 1], [118, 10], [117, 4]);
  const k = closes.length - 15; // the bar that closes at 100.6
  return fromCloses(closes, { overrides: { [k]: { low: 97.2 } } });
}

/** One close below the zone, immediately reclaimed: close-through, NOT a break. */
export function closeThroughNoBreak(): Candle[] {
  const closes = path(130, ...warmup(124), [100, 16], [118, 12], [100.4, 12], [99.1, 1], [101.5, 1], [118, 10], [117, 4]);
  return fromCloses(closes);
}

/** Support broken by consecutive closes below, then price continues lower. */
export function supportBreak(): Candle[] {
  return fromCloses(path(130, ...warmup(124), [100, 16], [118, 12], [100.4, 12], [98.8, 1], [97.6, 1], [88, 8], [86, 10]));
}

export const resistanceBreak = () => mirror(supportBreak(), 150);

/** Support breaks, price moves away, retests the zone from below and is rejected → flips to resistance. */
export function supportToResistanceFlip(): Candle[] {
  return fromCloses(
    path(130, ...warmup(124), [100, 16], [118, 12], [100.4, 12], [98.8, 1], [97.6, 1], [90, 6], [99.2, 8], [90, 8], [88, 10]),
  );
}

export const resistanceToSupportFlip = () => mirror(supportToResistanceFlip(), 150);

/** Two swing lows 0.1 apart separated by a small bounce → one zone, two pivots. */
export function duplicateNearbyPivots(): Candle[] {
  return fromCloses(path(130, ...warmup(124), [100, 16], [103.5, 5], [100.1, 5], [118, 12], [119, 10]));
}

/** Two swing lows ~2 ATR apart → two separate zones. */
export function separatedNearbyZones(): Candle[] {
  return fromCloses(path(130, ...warmup(124), [100, 16], [112, 8], [105.5, 8], [120, 12], [121, 10]));
}

/** Higher-timeframe support around the same ~100 area (independent H4 candles). */
export function h4SupportNear100(): Candle[] {
  return fromCloses(path(140, [128, 3], [140, 3], [128, 3], [140, 3], [128, 3], [140, 3], [100.2, 10], [135, 10], [125, 30]), { tf: 'H4', wick: 2 });
}
