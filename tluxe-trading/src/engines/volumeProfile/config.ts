import type { Timeframe } from '../../types/market';

/* ============================================================================
 * VOLUME PROFILE ENGINE v1 — every constant lives here (and is shown in the UI).
 * Independent of every other TLUXE engine. Times: candle times are UTC epoch SECONDS.
 * ========================================================================== */

export interface VPSettings {
  /** Value-area share of total profile volume (0.5–0.95). */
  valueAreaPct: number;
  /** Row size = nice step of (profile's first open × bp / 10 000), ≥ 1 tick. */
  rowBpIntraday: number;
  rowBpWeekly: number;
  rowBpHtf: number;
  /** HVN / LVN detection on 3-row smoothed volume, relative to the smoothed maximum. */
  nodeWindowRows: number;
  hvnMinRel: number;
  lvnMaxRel: number;
  /** LVN must be ≤ this share of BOTH flanking peaks. */
  lvnFlankRatio: number;
  /** Nodes closer than this many rows are merged (strongest kept). */
  nodeMergeRows: number;
  /** A completed profile's nodes expire this long after confirmation (s). */
  nodeExpirySec: number;
  /** Price location: NEAR POC when |price − POC| ≤ nearPocAtr × ATR (analysis TF). */
  nearPocAtr: number;
  /** Acceptance: this many consecutive CLOSES beyond VAH / VAL. */
  acceptBars: number;
  /** Rejection look-back (closed analysis bars). */
  rejectLookback: number;
  /** ROTATING INSIDE VALUE: the last N closes inside [VAL, VAH]. */
  rotateBars: number;
  /** POC rejection: a bar touching POC closes ≥ pocRejectAtr × ATR away and price stays there. */
  pocRejectAtr: number;
  /** POC acceptance: the last N closes within nearPocAtr of POC. */
  pocAcceptBars: number;
  /** Developing POC shift is logged only when it moves ≥ this many rows. */
  pocShiftRows: number;
  atrPeriod: number;
  /** Confluence tolerance: other engines' levels within this × ATR of a profile level. */
  confluenceAtr: number;
}

export const DEFAULT_VP_SETTINGS: Readonly<VPSettings> = Object.freeze({
  valueAreaPct: 0.7,
  rowBpIntraday: 1,
  rowBpWeekly: 2.5,
  rowBpHtf: 5,
  nodeWindowRows: 3,
  hvnMinRel: 0.6,
  lvnMaxRel: 0.35,
  lvnFlankRatio: 0.5,
  nodeMergeRows: 3,
  nodeExpirySec: 5 * 86_400,
  nearPocAtr: 0.25,
  acceptBars: 2,
  rejectLookback: 8,
  rotateBars: 6,
  pocRejectAtr: 0.5,
  pocAcceptBars: 3,
  pocShiftRows: 2,
  atrPeriod: 14,
  confluenceAtr: 0.25,
});

export const VP_TF_SECONDS: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 });
export const VP_TIMEFRAMES: readonly Timeframe[] = ['D1', 'H4', 'H1', 'M30', 'M15', 'M5', 'M1'];
/** Resolution used to build each profile family. */
export const RES_INTRADAY: Timeframe = 'M5';
export const RES_WEEKLY: Timeframe = 'M30';
/** Setup / acceptance timeframe (closed candles). */
export const ANALYSIS_TF: Timeframe = 'M15';
/** MTF matrix: each timeframe's own profile over its last N closed bars. */
export const MTF_LOOKBACK: Readonly<Partial<Record<Timeframe, number>>> = Object.freeze({ D1: 20, H4: 30, H1: 48, M30: 48, M15: 64, M5: 96 });
export const MTF_TFS: readonly Timeframe[] = ['D1', 'H4', 'H1', 'M30', 'M15', 'M5'];
/** Trading day / week boundary: 17:00 New York (metals / FX convention). Weeks start Sunday 17:00. */
export const DAY_TZ = 'America/New_York';
export const DAY_START_HOUR = 17;

export type VPScoreKey = 'htfAlignment' | 'pocSignificance' | 'valueInteraction' | 'nodeSignificance' | 'liquidity' | 'sr' | 'smc' | 'session' | 'freshness';
/** Confluence weights (%, total 100). Analysis measure — never a probability of winning, expected profit or a signal. */
export const VP_SCORE_WEIGHTS: Readonly<Record<VPScoreKey, number>> = Object.freeze({
  htfAlignment: 15,
  pocSignificance: 10,
  valueInteraction: 15,
  nodeSignificance: 10,
  liquidity: 15,
  sr: 10,
  smc: 15,
  session: 5,
  freshness: 5,
});
export const VP_SCORE_LABEL: Readonly<Record<VPScoreKey, string>> = Object.freeze({
  htfAlignment: 'HTF profile alignment',
  pocSignificance: 'POC significance',
  valueInteraction: 'VAH / VAL interaction',
  nodeSignificance: 'HVN / LVN significance',
  liquidity: 'Liquidity confluence',
  sr: 'S/R confluence',
  smc: 'SMC confirmation',
  session: 'Session profile confluence',
  freshness: 'Freshness',
});
export const VP_SCORE_CAP_MISSING = 40;
