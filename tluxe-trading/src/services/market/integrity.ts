import type { Candle } from '../../types/market';

/**
 * Candle integrity layer. Runs on every batch BEFORE data reaches the market
 * store or any engine. Serious problems are quarantined with a reason — never
 * silently repaired. Benign conditions (exact duplicates, out-of-order order)
 * are resolved deterministically and reported.
 */

export type QuarantineReason =
  | 'non-finite'
  | 'non-positive-price'
  | 'high-below-low'
  | 'open-outside-range'
  | 'close-outside-range'
  | 'invalid-timestamp'
  | 'future-timestamp'
  | 'conflicting-duplicate'
  | 'negative-volume';

export interface QuarantinedCandle {
  candle: unknown;
  reason: QuarantineReason;
}

export interface DataGapReport {
  /** Last bar before the gap (UTC s). */
  after: number;
  before: number;
  missingBars: number;
  /** Gap spans a weekend (Sat/Sun UTC) — expected for OTC markets. */
  weekend: boolean;
}

export interface IntegrityReport {
  received: number;
  accepted: number;
  quarantined: QuarantinedCandle[];
  /** Identical rows repeated (kept once). */
  exactDuplicates: number;
  /** Rows that arrived out of chronological order (sorted). */
  outOfOrder: number;
  gaps: DataGapReport[];
  /** Largest forward jump between consecutive bars, in bar lengths. */
  maxJumpBars: number;
}

export interface IntegrityOptions {
  tfSeconds: number;
  /** Current UTC time (s); bars opening beyond now + one bar are rejected. */
  nowSec: number;
  /** Gap reporting threshold in bar lengths. */
  gapToleranceBars?: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optionalOk = (v: unknown) => v === undefined || v === null || (finite(v) && v >= 0);

function check(c: Candle, o: IntegrityOptions): QuarantineReason | null {
  if (![c.open, c.high, c.low, c.close].every(finite)) return 'non-finite';
  if (!finite(c.time) || !Number.isInteger(c.time) || c.time <= 0) return 'invalid-timestamp';
  if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return 'non-positive-price';
  if (c.high < c.low) return 'high-below-low';
  if (c.open > c.high || c.open < c.low) return 'open-outside-range';
  if (c.close > c.high || c.close < c.low) return 'close-outside-range';
  if (c.time > o.nowSec + o.tfSeconds) return 'future-timestamp';
  if (!optionalOk(c.volume) || !optionalOk(c.tickVolume) || !optionalOk(c.realVolume) || !optionalOk(c.spread)) return 'negative-volume';
  return null;
}

const sameOhlc = (a: Candle, b: Candle) => a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

export function validateCandles(input: readonly Candle[], o: IntegrityOptions): { candles: Candle[]; report: IntegrityReport } {
  const quarantined: QuarantinedCandle[] = [];
  let outOfOrder = 0;
  let exactDuplicates = 0;
  const byTime = new Map<number, Candle>();
  const conflicted = new Set<number>();
  let prevTime = -Infinity;

  for (const c of input) {
    const reason = check(c, o);
    if (reason) {
      quarantined.push({ candle: c, reason });
      continue;
    }
    if (c.time < prevTime) outOfOrder += 1;
    prevTime = Math.max(prevTime, c.time);
    const existing = byTime.get(c.time);
    if (!existing) {
      byTime.set(c.time, c);
    } else if (sameOhlc(existing, c)) {
      exactDuplicates += 1;
    } else {
      conflicted.add(c.time);
    }
  }
  // Conflicting duplicates within one batch: neither version is trusted.
  for (const t of conflicted) {
    quarantined.push({ candle: byTime.get(t), reason: 'conflicting-duplicate' });
    byTime.delete(t);
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  const gaps: DataGapReport[] = [];
  let maxJumpBars = 0;
  const tol = o.gapToleranceBars ?? 1.5;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.time - candles[i - 1]!.time;
    const bars = delta / o.tfSeconds;
    maxJumpBars = Math.max(maxJumpBars, bars);
    if (bars > tol) {
      const after = candles[i - 1]!.time;
      const before = candles[i]!.time;
      gaps.push({ after, before, missingBars: Math.round(bars) - 1, weekend: spansWeekend(after, before) });
    }
  }

  return {
    candles,
    report: { received: input.length, accepted: candles.length, quarantined, exactDuplicates, outOfOrder, gaps, maxJumpBars },
  };
}

function spansWeekend(fromSec: number, toSec: number): boolean {
  for (let t = fromSec; t <= toSec; t += 6 * 3600) {
    const d = new Date(t * 1000).getUTCDay();
    if (d === 0 || d === 6) return true;
  }
  return false;
}
