/**
 * TEST FIXTURES ONLY — named deterministic High / Low Engine scenarios (never market data).
 *
 * BUY template (SELL = the exact mirror around 150):
 *  coarse H1  whole UTC days: descending zigzag (H4 BEARISH), ending the previous day with a
 *             low at close 100 (wick 99.6 = Previous Day Low AND Major Swing Low → one setup
 *             with confluence), a rally to ~102.8 (Previous Day High 104.4 earlier that day).
 *  M1 day     starts 00:00 UTC. Asia waves 102.3–103.0 until 08:00 (Asia High / Low), more
 *             waves, then from 13:00: decline 100.9 → bounce 101.5 (M5 swing high) → 99.35
 *             (SSL taken below 99.6) → reclaim 100.2 → bullish M5 CHOCH through 101.5 at
 *             ~101.9 → M1 pullback into the zone (99.45) → reaction.
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
  legs.push([104, 6], [100, 10], [102.8, 6], [102.6, 5]);
  let closes = path(147, ...legs);
  // Whole UTC days: pad at the START so the key low stays in the last (previous) day.
  const pad = (24 - (closes.length % 24)) % 24;
  closes = [...Array(pad).fill(147), ...closes];
  return fromCloses(closes, T0, 3600, H1_WICK);
}
/** The previous-day low / major swing low of the template. */
export const KEY_LOW = 100 - H1_WICK;
export const coarseEnd = (c: readonly Candle[]) => c[c.length - 1]!.time + 3600;

const asiaAndMore = (): [number, number][] => {
  const legs: [number, number][] = [];
  for (let k = 0; k < 6; k++) legs.push([102.3, 60], [103.0, 60]);
  legs.push([102.6, 60]);
  return legs;
};
const toSweep = (): [number, number][] => [...asiaAndMore(), [100.9, 60], [101.5, 15], [99.35, 40]];
const toReclaim = (): [number, number][] => [...toSweep(), [100.2, 12]];
const toConfirm = (): [number, number][] => [...toReclaim(), [101.9, 16]];

export function build(legs: [number, number][], ov: Record<number, Partial<Candle>> = {}): HLEInput {
  const coarse = coarseH1();
  const closes = path(102.6, ...legs).slice(1);
  while (closes.length % 60 !== 0) closes.push(closes[closes.length - 1]!);
  return dataset(coarse, fromCloses(closes, coarseEnd(coarse), 60, M1_WICK, ov));
}
/** Minute index (within the M1 day) of the first bar after the given legs. */
export const minuteAfter = (legs: [number, number][]) => legs.reduce((a, [, n]) => a + n, 0);
export const CONFIRM_LEGS = toConfirm;

/** Full BUY sequence → ENTRY_READY (BUY CONFIRMED), then the signal window runs out. */
export const buyReversal = () => build([...toConfirm(), [99.45, 40], [100.5, 10], [101.5, 30], [101.6, 60]]);
export const sellReversal = () => mirrorInput(buyReversal(), 150);
/** Wick through the level without a reclaim close → INVALIDATED (no reclaim). */
export const wickNoReclaim = () => build([...toSweep(), [99.45, 60], [99.4, 60]]);
/** Sweep that continues (accepted beyond) → INVALIDATED (continuation). */
export const continuation = () => build([...toSweep(), [98.4, 30], [98.5, 60]]);
/** Reclaim, then chop with no M5 structure break → EXPIRED. */
export function reclaimNoM5(): HLEInput {
  const legs: [number, number][] = [...toReclaim()];
  for (let k = 0; k < 16; k++) legs.push([100.0, 8], [100.4, 8]);
  return build(legs);
}
/** M5 confirmation, then a run to TP1 without a pullback → EXPIRED (missed). */
export const confirmNoPullback = () => build([...toConfirm(), [104.8, 40], [104.9, 60]]);
/** Reclaim, then an M5 close below the sweep extreme → INVALIDATED before entry. */
export const invalidatedBeforeEntry = () => build([...toReclaim(), [98.9, 15], [99.0, 60]]);
