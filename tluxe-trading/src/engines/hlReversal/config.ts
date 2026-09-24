import type { HLRScoreKey, HLRTimeframe } from './types';

/**
 * High / Low Reversal Engine v1 parameters — the only place its constants live.
 * Independent of S&R, Liquidity and Order Blocks. Distances are ATR multiples of the
 * named timeframe (Wilder ATR), so the same rules work on every instrument.
 */
export interface HLRSettings {
  atrPeriod: number;
  /** H4 context swings. */
  h4SwingLeft: number;
  h4SwingRight: number;
  /** H1 swings / important levels. */
  h1SwingLeft: number;
  h1SwingRight: number;
  /** An important H1 low is the lowest low of at least this many prior H1 bars (highs mirror). */
  h1DominanceBars: number;
  /** … and price moved ≥ this many H1 ATR away from it (prior window + confirmation bars). */
  h1MinProminenceAtr: number;
  /** A later H1 swing within this × level ATR is an equal high / low (merged, price stays frozen). */
  equalTolAtr: number;
  /** Levels watched for at most this many H1 bars. */
  levelExpiryBars: number;
  /** M15 within this × level ATR of the level (without trading beyond) = TOUCHED. */
  touchTolAtr: number;
  /** Penetration beyond the level > this × level ATR = breakout, not a sweep (INVALIDATED). */
  maxPenetrationAtr: number;
  /** An M15 close beyond the level by ≥ this × level ATR = acceptance (INVALIDATED). */
  acceptCloseAtr: number;
  /** Reclaim = M15 close back inside by ≥ this × M15 ATR … */
  reclaimMarginAtr: number;
  /** … within this many M15 bars of the sweep bar (inclusive), else FAILED_RECLAIM. */
  reclaimWindowBars: number;
  m5SwingLeft: number;
  m5SwingRight: number;
  /** M5 confirmation must happen within this many M5 bars after the reclaim, else EXPIRED. */
  m5WindowBars: number;
  /** Displacement: sweep extreme → break close ≥ this × M5 ATR … */
  minDisplacementAtr: number;
  /** … with at least one M5 body ≥ this × M5 ATR. */
  minDisplacementBodyAtr: number;
  /** M1 pullback into the zone within this many M1 bars after confirmation, else EXPIRED. */
  m1PullbackWindowBars: number;
  /** After ENTRY READY, the M1 reaction (close out of the zone) within this many bars, else EXPIRED. */
  m1TriggerWindowBars: number;
  /** Stop = sweep extreme ∓ this × M5 ATR (at confirmation). */
  slBufferAtr: number;
  minBars: Readonly<Record<HLRTimeframe, number>>;
  /** Setups kept in the output: every open one + this many most recent finished ones. */
  maxFinishedSetups: number;
}

export const DEFAULT_HLR_SETTINGS: Readonly<HLRSettings> = Object.freeze({
  atrPeriod: 14,
  h4SwingLeft: 2,
  h4SwingRight: 2,
  h1SwingLeft: 3,
  h1SwingRight: 3,
  h1DominanceBars: 24,
  h1MinProminenceAtr: 1.5,
  equalTolAtr: 0.15,
  levelExpiryBars: 240,
  touchTolAtr: 0.1,
  maxPenetrationAtr: 1.0,
  acceptCloseAtr: 0.5,
  reclaimMarginAtr: 0.05,
  reclaimWindowBars: 6,
  m5SwingLeft: 2,
  m5SwingRight: 2,
  m5WindowBars: 36,
  minDisplacementAtr: 1.5,
  minDisplacementBodyAtr: 0.8,
  m1PullbackWindowBars: 120,
  m1TriggerWindowBars: 60,
  slBufferAtr: 0.1,
  minBars: Object.freeze({ H4: 30, H1: 60, M15: 60, M5: 60, M1: 60 }),
  maxFinishedSetups: 100,
});

export const hlrSettingsKey = (s: HLRSettings) => JSON.stringify(s);

export const HLR_TIMEFRAMES: readonly HLRTimeframe[] = ['H4', 'H1', 'M15', 'M5', 'M1'];
export const HLR_TF_SECONDS: Readonly<Record<HLRTimeframe, number>> = Object.freeze({ H4: 14400, H1: 3600, M15: 900, M5: 300, M1: 60 });
/** Processing order for bars that close at the same instant: higher timeframe first. */
export const HLR_TF_ORDER: Readonly<Record<HLRTimeframe, number>> = Object.freeze({ H4: 0, H1: 1, M15: 2, M5: 3, M1: 4 });

/** Score weights in % — total exactly 100 (asserted in tests). */
export const HLR_SCORE_WEIGHTS: Readonly<Record<HLRScoreKey, number>> = Object.freeze({
  htfAlignment: 20,
  liquiditySweep: 20,
  reclaim: 15,
  m5Structure: 15,
  displacement: 10,
  entryQuality: 10,
  riskReward: 5,
  freshness: 5,
});
