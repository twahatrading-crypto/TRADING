import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { buildMultiSnapshot } from './confluence';
import { SRTimeframeEngine } from './engine';
import { TIMEFRAME_SECONDS, type SRSettings } from './settings';
import type { SRMultiSnapshot, SRSnapshot } from './types';

/* ============================================================================
 * Knowledge cutoff: the single rule that decides what S&R may know at a
 * historical moment.
 *
 *   A bar is KNOWN at time K  ⇔  it is closed  and  bar.time + tfSeconds ≤ K.
 *
 * K is the close time of the replay cursor bar on the chart timeframe. Every
 * other timeframe gets only the bars that had CLOSED by K, so a higher-
 * timeframe bar that is still forming at K (e.g. an H4 bar that opened before
 * the cursor but closes after it) is invisible, and lower timeframes stop at K.
 * ========================================================================== */

export const barCloseTime = (c: Candle, tf: Timeframe): number => c.time + TIMEFRAME_SECONDS[tf];

/**
 * Closed bars only. Provider-flagged bars use `isClosed`; unflagged streams
 * treat the newest bar as forming (the engine's conservative default).
 */
export function closedBarsOnly(candles: readonly Candle[]): Candle[] {
  const flagged = candles.some((c) => c.isClosed !== undefined);
  if (flagged) return candles.filter((c) => c.isClosed === true);
  return candles.slice(0, Math.max(0, candles.length - 1));
}

/** Bars (ascending, closed) that are known at K: the longest prefix whose close time ≤ K. */
export function knownAt(candles: readonly Candle[], tf: Timeframe, k: number): readonly Candle[] {
  const sec = TIMEFRAME_SECONDS[tf];
  let lo = 0;
  let hi = candles.length; // first index whose close time > K
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time + sec <= k) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(0, lo);
}

/** Fixed timeframe order (M1 → D1) so every analysis path assembles snapshots identically. */
export const REPLAY_TIMEFRAMES = Object.keys(TIMEFRAME_SECONDS) as Timeframe[];

/** Frozen, closed-only historical candles per timeframe for one instrument. */
export interface ReplayDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  settings: SRSettings;
  candles: Partial<Record<Timeframe, readonly Candle[]>>;
}

/**
 * Reference ("oracle") analysis at knowledge time K: brand-new engines per
 * timeframe fed only the bars known at K. Replay must always equal this.
 */
export function analyzeAt(ds: ReplayDataset, k: number, currentPrice: number | null): SRMultiSnapshot {
  const byTimeframe: Partial<Record<Timeframe, SRSnapshot>> = {};
  for (const tf of REPLAY_TIMEFRAMES) {
    const candles = ds.candles[tf];
    if (candles) byTimeframe[tf] = analyzeKnown(ds, tf, knownAt(candles, tf, k), currentPrice);
  }
  return buildMultiSnapshot(ds.instrumentId, byTimeframe, ds.settings);
}

function analyzeKnown(ds: ReplayDataset, tf: Timeframe, known: readonly Candle[], currentPrice: number | null): SRSnapshot {
  const e = new SRTimeframeEngine({ instrumentId: ds.instrumentId, timeframe: tf, tickSize: ds.tickSize, settings: ds.settings });
  e.update(known, { lastBarClosed: true, currentPrice });
  return e.snapshot();
}
