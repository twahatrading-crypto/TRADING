import type { HLEScoreKey, HLETimeframe, LevelSource } from './types';

/**
 * High / Low Engine parameters — the only place its constants live. Values are the documented
 * defaults of the proven High / Low workflow (handoff §18.1, HLR.CFG + the promoted literals),
 * carried over verbatim. ATR = Wilder ATR (atrLen) of the named timeframe, taken AT the bar that
 * is being judged. Independent of every other TLUXE engine (including High / Low Reversal).
 */
export interface HLESettings {
  atrLen: number;
  /** Pivot confirmation: k bars STRICTLY lower/higher on both sides (ties disqualify). */
  swingK: number;
  /** H4 swing lookback for the direction and the reported last swing high / low. */
  dirSwings: number;
  /** structureBias() swing scan (bars). */
  contextSwings: number;
  /** H1 bars covered by the level-freshness span. */
  zoneSwings: number;
  /** H1 swing scan for the pivot clusters (major / swing levels). */
  clusterSwings: number;
  /** "Price reached the level": within levelTolAtr × M15 ATR. */
  levelTolAtr: number;
  /** Proximity gate (before a sweep only): within nearAtr × M15 ATR = watching. */
  nearAtr: number;
  /** How far back a sweep is looked for when a level is first published (M15 bars). */
  sweepWindow: number;
  /** A sweep must trade beyond the level by at least sweepMinAtr × M15 ATR at that bar. */
  sweepMinAtr: number;
  /** A CLOSE back through the level must come within this many M15 bars after the sweep bar. */
  reclaimWindow: number;
  /** Sweep-candle rejection wick ratio (display + score only). */
  rejectWick: number;
  /** M5 bars after the sweep run in which the CHOCH / BOS may close. */
  confirmWindow: number;
  /** The M5 close must clear the broken swing by breakMarginAtr × M5 ATR at that bar. */
  breakMarginAtr: number;
  /** Displacement (score only): body ≥ dispBodyAtr × ATR and body ≥ dispBodyPct of range. */
  dispBodyAtr: number;
  dispBodyPct: number;
  /** M5 swing scan (bars) for the broken swing. */
  m5SwingScan: number;
  /** M1 bars after the M5 break in which the pullback must arrive, else EXPIRED (R5 fix). */
  entryWindow: number;
  /** Entry band = [pullbackMin, pullbackMax] retracement of the impulse. */
  pullbackMin: number;
  pullbackMax: number;
  /** SL = swept extreme ∓ stopBufferAtr × M5 ATR at the break candle. */
  stopBufferAtr: number;
  /** Reported only — never fabricates or blocks a target. */
  minRR: number;
  /** A target must be at least minTargetRisk × risk beyond the entry. */
  minTargetRisk: number;
  /** A sweep older than this many M15 bars ends the setup (EXPIRED, logged). */
  expiryBars: number;
  /** A LEVEL_BROKEN setup stays visible as INVALIDATED for this many M15 bars after the sweep. */
  brokenVisibleBars: number;
  /** Level tolerance = max(H1 ATR × levelTolH1Atr, price × levelTolPrice) at the level's validFrom. */
  levelTolH1Atr: number;
  levelTolPrice: number;
  /** Minimum closed H1 bars before any level exists. */
  minLevelBars: number;
  /** Previous day: ≥ pdMinBars H1 bars in the UTC day, walking back at most pdMaxBack days. */
  pdMinBars: number;
  pdMaxBack: number;
  /** Level reaction: biggest move away within reactionBars H1 bars after validFrom ÷ ATR, normalised by reactionNorm. */
  reactionBars: number;
  reactionNorm: number;
  /** Asia session: Asia/Tokyo local hours [asiaStart, asiaEnd), weekdays (Tokyo has no DST). */
  asiaStart: number;
  asiaEnd: number;
  /** M1 confluence detector lookback (bars). */
  confluenceBars: number;
  /** NO_DATA gate: closed bars required per timeframe. */
  minBars: Readonly<Record<HLETimeframe, number>>;
  /** Output: every open setup + this many most recent finished ones. */
  maxFinishedSetups: number;
  maxEvents: number;
}

export const DEFAULT_HLE_SETTINGS: Readonly<HLESettings> = Object.freeze({
  atrLen: 14,
  swingK: 2,
  dirSwings: 200,
  contextSwings: 200,
  zoneSwings: 300,
  clusterSwings: 200,
  levelTolAtr: 0.25,
  nearAtr: 2.0,
  sweepWindow: 48,
  sweepMinAtr: 0.1,
  reclaimWindow: 4,
  rejectWick: 0.45,
  confirmWindow: 72,
  breakMarginAtr: 0.05,
  dispBodyAtr: 1.0,
  dispBodyPct: 0.5,
  m5SwingScan: 120,
  entryWindow: 180,
  pullbackMin: 0.5,
  pullbackMax: 0.786,
  stopBufferAtr: 0.15,
  minRR: 1.5,
  minTargetRisk: 0.25,
  expiryBars: 48,
  brokenVisibleBars: 12,
  levelTolH1Atr: 0.15,
  levelTolPrice: 0.00015,
  minLevelBars: 40,
  pdMinBars: 4,
  pdMaxBack: 7,
  reactionBars: 24,
  reactionNorm: 3,
  asiaStart: 9,
  asiaEnd: 18,
  confluenceBars: 400,
  minBars: Object.freeze({ M1: 120, M5: 120, M15: 150, H1: 120, H4: 60 }),
  maxFinishedSetups: 100,
  maxEvents: 400,
});

export const hleSettingsKey = (s: HLESettings) => JSON.stringify(s);
export const HLE_TIMEFRAMES: readonly HLETimeframe[] = ['H4', 'H1', 'M15', 'M5', 'M1'];
export const HLE_TF_SECONDS: Readonly<Record<HLETimeframe, number>> = Object.freeze({ H4: 14400, H1: 3600, M15: 900, M5: 300, M1: 60 });

/** Setup Score maxima (points) — total exactly 100 (asserted in tests). */
export const HLE_SCORE_WEIGHTS: Readonly<Record<HLEScoreKey, number>> = Object.freeze({
  htfAlignment: 20,
  levelImportance: 20,
  sweepQuality: 15,
  rejectionDisplacement: 15,
  m5Structure: 15,
  m1EntryQuality: 10,
  fvgObConfluence: 5,
});

/** Level rating (handoff §4.6). */
export const RATING_WEIGHTS = Object.freeze({ kind: 0.3, touches: 0.22, reaction: 0.2, freshness: 0.16, untouched: 0.12 });
export const KIND_WEIGHT: Readonly<Record<LevelSource | 'major', number>> = Object.freeze({ pdh: 0.95, pdl: 0.95, major: 0.9, asia: 0.6, swing: 0.55 });
export const RATING_BANDS = Object.freeze({ strong: 0.66, medium: 0.4 });
