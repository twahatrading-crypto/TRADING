/**
 * TEST FIXTURES ONLY — named deterministic High / Low Engine scenarios (never market data).
 *
 * BUY template (SELL = the exact mirror around 150). Enough history for the documented NO_DATA gate
 * (M1 120 · M5 120 · M15 150 · H1 120 · H4 60 closed bars):
 *  coarse H1  ~16 UTC days of a descending zigzag (H4 BEARISH), ending at 102.6.
 *  day 0 (M1) waves 102.2–103.0, a dip to 100.0 in the afternoon (= Previous Day Low for day 1,
 *             and an H1 swing low), back to 102.4.
 *  day 1 (M1) Asia (Tokyo 09–18 = 00–09 UTC) waves 102.3–102.9, more waves until 13:00, then a
 *             decline to 100.9 → bounce 101.5 → 99.35 (SSL below the 99.97 PDL taken) → M15 close
 *             back above (reclaim) → M5 swing high → bullish M5 CHOCH close → rally to 101.9 →
 *             M1 pullback into the 0.5–0.786 band → reaction.
 */
import type { Candle } from '../../../types/market';
import type { HLEInput } from '../engine';
import { dataset, fromCloses, mirrorInput, path, T0 } from './builders';

const H1_WICK = 0.4;
const M1_WICK = 0.03;

export function coarseH1(): Candle[] {
  const legs: [number, number][] = [];
  let p = 147;
  for (let k = 0; k < 15; k++) {
    legs.push([p + 4, 8], [p - 3, 16]);
    p -= 3;
  }
  legs.push([104, 8], [102.6, 16]);
  let closes = path(147, ...legs);
  const pad = (24 - (closes.length % 24)) % 24;
  closes = [...Array(pad).fill(147), ...closes];
  return fromCloses(closes, T0, 3600, H1_WICK);
}
export const coarseEnd = (c: readonly Candle[]) => c[c.length - 1]!.time + 3600;

const waves = (lo: number, hi: number, n: number, half: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push([lo, half], [hi, half]);
  return out;
};
/** Day 0: 1440 minutes; its low (100.0 close, 99.97 wick) is the Previous Day Low of day 1. */
const day0 = (): [number, number][] => [...waves(102.2, 103.0, 10, 30), [100.0, 300], [102.4, 300], ...waves(102.2, 102.8, 2, 60)];
/** Day 1 until 13:00 UTC: Asia waves (00–09 UTC) then more waves. */
const day1Morning = (): [number, number][] => [...waves(102.3, 102.9, 9, 30), ...waves(102.4, 102.8, 4, 30)];


const toSweep = (): [number, number][] => [...day0(), ...day1Morning(), [100.9, 60], [101.5, 15], [99.35, 25]];
const toReclaim = (): [number, number][] => [...toSweep(), [100.2, 12]];
const toConfirm = (): [number, number][] => [...toReclaim(), [100.5, 10], [100.2, 10], [101.9, 30]];

export function build(legs: [number, number][], ov: Record<number, Partial<Candle>> = {}): HLEInput {
  const coarse = coarseH1();
  const closes = path(102.6, ...legs).slice(1);
  while (closes.length % 60 !== 0) closes.push(closes[closes.length - 1]!);
  return dataset(coarse, fromCloses(closes, coarseEnd(coarse), 60, M1_WICK, ov));
}
/** Minute index (within the M1 segment) of the first bar after the given legs. */
export const minuteAfter = (legs: [number, number][]) => legs.reduce((a, [, n]) => a + n, 0);
export const CONFIRM_LEGS = toConfirm;
export const SWEEP_LEGS = toSweep;

/** Full BUY sequence → ENTRY READY (BUY CONFIRMED), then the reaction. */
export const buyReversal = () => build([...toConfirm(), [100.0, 40], [101.2, 20], [101.8, 60], [101.9, 120]]);
export const sellReversal = () => mirrorInput(buyReversal(), 150);
/** Sweep candle closes well beyond and nothing comes back within 4 M15 bars → LEVEL_BROKEN. */
export const breakNoReclaim = () => build([...toSweep(), [99.9, 20], [99.88, 120]]);
/** Reclaim, then chop above the level with no M5 structure break → EXPIRED after 48 M15 bars. */
export function reclaimNoM5(): HLEInput {
  const legs: [number, number][] = [...toReclaim()];
  for (let k = 0; k < 44; k++) legs.push([100.05, 8], [100.25, 8]);
  return build(legs);
}
/** M5 confirmation, then a run away with no pullback for > 180 M1 bars → EXPIRED (stage-3 expiry, R5). */
export const confirmNoPullback = () => build([...toConfirm(), [103.2, 60], [103.4, 240]]);
/** Reclaim, then an M5 close below the swept extreme → STRUCTURE_FAILED before any structure break. */
export const invalidatedBeforeEntry = () => build([...toReclaim(), [100.25, 8], [99.0, 15], [100.4, 25], [100.5, 60]]);
/** A poke through the level by less than 0.10 × M15 ATR → never a sweep. */
export const shallowPoke = () => build([...day0(), ...day1Morning(), [100.4, 60], [100.02, 30], [101.2, 30], [101.3, 60]], {});
/** ENTRY READY, then an M1 close through the SL → INVALIDATED after confirmation. */
export const stopAfterEntry = () => build([...toConfirm(), [100.0, 40], [99.0, 30], [99.1, 60]]);
