/**
 * TEST FIXTURES ONLY — named deterministic High / Low Reversal scenarios.
 *
 * BUY template (SELL = the exact mirror around 150):
 *  coarse H1  descending zigzag (H4 BEARISH context) ending with an important H1 low
 *             (close 100, wick low 99.6), a rally to ~102.8 and a short flat.
 *  M1         prelude waves 102.3–103.0 (history; M15 swing highs ≈ 103.03 = TP1) → decline to 100.9 → bounce to 101.5
 *             (M5 swing high) → decline to 99.35 (sell-side liquidity taken below 99.6)
 *             → reclaim to 100.2 → displacement to 101.9 (M5 CHOCH through ~101.5)
 *             → pullback into the entry zone → reaction up.
 * Variants cut the M1 path after a stage and continue it differently.
 */
import type { Candle } from '../../../types/market';
import type { HLRInput } from '../engine';
import { dataset, fromCloses, mirrorInput, path, T0 } from './builders';

const H1_WICK = 0.4;
const M1_WICK = 0.03;

export function coarseH1(extra: [number, number][] = []): Candle[] {
  const legs: [number, number][] = [];
  let p = 147;
  for (let k = 0; k < 15; k++) {
    legs.push([p + 4, 8], [p - 3, 16]);
    p -= 3;
  }
  legs.push([104, 6], [100, 10], [102.8, 6], [102.6, 5], ...extra);
  const closes = path(147, ...legs);
  return fromCloses(closes, T0, 3600, H1_WICK);
}
/** The important H1 low of the template (wick low of the close-100 bar). */
export const KEY_LOW = 100 - H1_WICK;
export const coarseEnd = (c: readonly Candle[]) => c[c.length - 1]!.time + 3600;

const prelude = (): [number, number][] => {
  const legs: [number, number][] = [];
  for (let k = 0; k < 4; k++) legs.push([102.3, 90], [103.0, 90]);
  legs.push([102.6, 60]);
  return legs;
};
const toSweep = (): [number, number][] => [...prelude(), [100.9, 60], [101.5, 15], [99.35, 40]];
const toReclaim = (): [number, number][] => [...toSweep(), [100.2, 12]];
const toConfirm = (): [number, number][] => [...toReclaim(), [101.9, 16]];

function build(legs: [number, number][], ov: Record<number, Partial<Candle>> = {}): HLRInput {
  const coarse = coarseH1();
  const closes = path(102.6, ...legs).slice(1);
  // Pad to a whole number of hours so every aggregated bar is complete.
  while (closes.length % 60 !== 0) closes.push(closes[closes.length - 1]!);
  return dataset(coarse, fromCloses(closes, coarseEnd(coarse), 60, M1_WICK, ov));
}

/** Full BUY sequence → ENTRY_READY → TRIGGERED. */
export const buyReversal = () => build([...toConfirm(), [99.45, 40], [100.5, 10], [101.5, 30], [101.6, 60]]);
/** Same, stopped right after the pullback reached the zone (ENTRY_READY, not yet triggered). */
export const buyEntryReady = () => build([...toConfirm(), [99.45, 40]]);
export const sellReversal = () => mirrorInput(buyReversal(), 150);

/** Sweep without reclaim: stays just below the level → FAILED_RECLAIM. */
export const sweepNoReclaim = () => build([...toSweep(), [99.45, 60], [99.4, 60]]);
/** Acceptance below the level (close ≥ 0.5 ATR beyond) → INVALIDATED at M15. */
export const acceptedBeyond = () => build([...toSweep(), [98.4, 30], [98.5, 60]]);
/** Reclaim, then chop with no M5 structure break → EXPIRED (M5 window). */
export function reclaimNoM5(): HLRInput {
  const legs: [number, number][] = [...toReclaim()];
  for (let k = 0; k < 16; k++) legs.push([100.0, 8], [100.4, 8]);
  return build(legs);
}
/** M5 confirmation, then price runs to TP1 without a pullback → MISSED. */
export const confirmNoPullback = () => build([...toConfirm(), [103.2, 30], [103.3, 60]]);
/** Reclaim, then an M5 close below the sweep extreme before confirmation → INVALIDATED. */
export const invalidatedBeforeEntry = () => build([...toReclaim(), [98.9, 15], [99.0, 60]]);
/** Only the coarse H1 history (+ H4) — level detection without lower timeframes. */
export const h1Only = (extra: [number, number][] = []): HLRInput => {
  const h1 = coarseH1(extra);
  const out = dataset(h1, []);
  return { H4: out.H4, H1: out.H1 };
};
