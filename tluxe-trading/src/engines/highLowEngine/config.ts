import type { HLEScoreKey, HLETimeframe } from './types';

/**
 * High / Low Engine parameters — the only place its constants live. Independent of every
 * other engine (including High / Low Reversal). ATR = Wilder ATR of the named timeframe.
 * Calendar rules use UTC (the timestamps MT5 candles carry in TLUXE).
 */
export interface HLESettings {
  atrPeriod: number;
  h4Swing: number;
  h1Swing: number;
  m15Swing: number;
  m5Swing: number;
  /** Previous-day levels need at least this many H1 bars in the UTC day. */
  minDayBars: number;
  /** Asia range = [asiaStartUtc, asiaEndUtc) hours UTC, needs ≥ minAsiaBars H1 bars. */
  asiaStartUtc: number;
  asiaEndUtc: number;
  minAsiaBars: number;
  /** Major swing: extreme of ≥ swingDominanceBars prior H1 bars and ≥ swingProminenceAtr ATR away. */
  swingDominanceBars: number;
  swingProminenceAtr: number;
  /** Swing levels are watched for at most this many H1 bars. */
  swingExpiryBars: number;
  /** Levels within this × H1 ATR of an active same-side level merge into its setup (confluence). */
  mergeTolAtr: number;
  /** M15 within this × H1 ATR of the level = LIQUIDITY_APPROACH. */
  approachAtr: number;
  /** Penetration > this × H1 ATR = continuation, not a sweep (INVALIDATED). */
  maxPenetrationAtr: number;
  /** An M15 close ≥ this × H1 ATR beyond the level = accepted beyond (INVALIDATED). */
  acceptCloseAtr: number;
  /** Reclaim = M15 close back inside by ≥ this × M15 ATR … */
  reclaimMarginAtr: number;
  /** … within this many M15 bars of the sweep bar (inclusive), else INVALIDATED (no reclaim). */
  reclaimWindowBars: number;
  /** M5 CHOCH/BOS must close within this many M5 bars after the reclaim, else EXPIRED. */
  m5WindowBars: number;
  /** Displacement evidence (scored, not mandatory): leg ≥ … ATR and a body ≥ … ATR. */
  displacementLegAtr: number;
  displacementBodyAtr: number;
  /** M5 order block origin search (bars before the break bar). */
  obLookback: number;
  /** M1 pullback into the zone within this many bars after M5 confirmation, else EXPIRED. */
  m1PullbackWindowBars: number;
  /** A confirmed signal stays live this many M1 bars, then EXPIRED (history kept). */
  signalWindowBars: number;
  /** Stop = sweep extreme ∓ this × M5 ATR. */
  slBufferAtr: number;
  minBars: Readonly<Record<HLETimeframe, number>>;
  /** Output: every open setup + this many most recent finished ones. */
  maxFinishedSetups: number;
  maxEvents: number;
}

export const DEFAULT_HLE_SETTINGS: Readonly<HLESettings> = Object.freeze({
  atrPeriod: 14,
  h4Swing: 2,
  h1Swing: 3,
  m15Swing: 3,
  m5Swing: 2,
  minDayBars: 12,
  asiaStartUtc: 0,
  asiaEndUtc: 8,
  minAsiaBars: 4,
  swingDominanceBars: 24,
  swingProminenceAtr: 1.5,
  swingExpiryBars: 240,
  mergeTolAtr: 0.15,
  approachAtr: 0.35,
  maxPenetrationAtr: 1.0,
  acceptCloseAtr: 0.5,
  reclaimMarginAtr: 0.05,
  reclaimWindowBars: 4,
  m5WindowBars: 36,
  displacementLegAtr: 1.5,
  displacementBodyAtr: 0.8,
  obLookback: 10,
  m1PullbackWindowBars: 120,
  signalWindowBars: 60,
  slBufferAtr: 0.2,
  minBars: Object.freeze({ H4: 30, H1: 72, M15: 60, M5: 60, M1: 60 }),
  maxFinishedSetups: 100,
  maxEvents: 400,
});

export const hleSettingsKey = (s: HLESettings) => JSON.stringify(s);
export const HLE_TIMEFRAMES: readonly HLETimeframe[] = ['H4', 'H1', 'M15', 'M5', 'M1'];
export const HLE_TF_SECONDS: Readonly<Record<HLETimeframe, number>> = Object.freeze({ H4: 14400, H1: 3600, M15: 900, M5: 300, M1: 60 });
/** Bars closing at the same instant are processed higher timeframe first. */
export const HLE_TF_ORDER: Readonly<Record<HLETimeframe, number>> = Object.freeze({ H4: 0, H1: 1, M15: 2, M5: 3, M1: 4 });

/** Score weights (%) — total exactly 100 (asserted in tests). */
export const HLE_SCORE_WEIGHTS: Readonly<Record<HLEScoreKey, number>> = Object.freeze({
  htfAlignment: 20,
  levelImportance: 20,
  sweepQuality: 15,
  rejectionDisplacement: 15,
  m5Structure: 15,
  m1EntryQuality: 10,
  fvgObConfluence: 5,
});

/** Base strength by level source (swings use their own measured significance). */
export const LEVEL_BASE_STRENGTH: Readonly<Record<'PD' | 'ASIA', number>> = Object.freeze({ PD: 70, ASIA: 50 });
export const strengthOf = (score: number) => (score >= 70 ? 'STRONG' : score >= 45 ? 'MEDIUM' : 'WEAK');
