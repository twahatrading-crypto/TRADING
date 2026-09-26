import type { Timeframe } from '../../types/market';

/**
 * SMC Engine v1 parameters — the only place its constants live. Independent of every other engine
 * (S&R, Liquidity, Order Blocks, High / Low Reversal, High / Low Engine, Order Flow). All distances
 * are multiples of the timeframe's own ATR, so the engine is instrument-independent.
 */
export interface SmcSettings {
  /** Wilder ATR period. */
  atrPeriod: number;
  /** Swing high: high strictly above the `swingLeft` previous highs and ≥ the `swingRight` next highs. */
  swingLeft: number;
  /** Bars that must CLOSE after the swing bar before it is confirmed (causal). */
  swingRight: number;
  /** Minimum swing prominence: swing extreme − opposite extreme of its (left + right) window, in ATR. */
  swingMinAtr: number;
  /** HH / LH (HL / LL) vs EQH (EQL): swings within this many ATR of the previous one are "equal". */
  equalTolAtr: number;
  /** BOS / CHOCH: the CLOSE must be beyond the swing by at least this many ATR (a wick is never enough). */
  breakMinAtr: number;
  /** Without any structural break for this many closed bars the structure is RANGING (stale trend). */
  rangeBars: number;
  /** Displacement (single bar): body ≥ dispBodyAtr × ATR and body ≥ dispBodyPct of the bar's range. */
  dispBodyAtr: number;
  dispBodyPct: number;
  /** Displacement (run): ≥ dispRunBars consecutive same-direction closes (each body ≥ dispRunMinBodyPct of its range), net move ≥ dispRunAtr × ATR. */
  dispRunBars: number;
  dispRunAtr: number;
  dispRunMinBodyPct: number;
  /** A break is "with displacement" when a same-direction displacement qualified within this many bars up to the break bar. */
  dispBreakWindow: number;
  /** FVG: gap size ≥ fvgMinAtr × ATR (and ≥ 1 tick). */
  fvgMinAtr: number;
  /** FVG untouched for ≤ this many bars = FRESH, then ACTIVE. */
  fvgFreshBars: number;
  /** FVG not filled / invalidated after this many bars = EXPIRED (0 = never). */
  fvgExpiryBars: number;
  /** Dealing range must span ≥ rangeMinAtr × ATR to be valid. */
  rangeMinAtr: number;
  /** Equilibrium band: 50% ± eqBandPct / 2 of the dealing range. */
  eqBandPct: number;
  /** SMC sequence: look back this many closed bars for the anchoring sweep. */
  seqLookbackBars: number;
  /** Closed bars required before a timeframe reports analysis. */
  minHistoryBars: number;
  /** Per-timeframe retention (deterministic trimming). */
  maxEvents: number;
  maxObjects: number;
}

export const DEFAULT_SMC_SETTINGS: Readonly<SmcSettings> = Object.freeze({
  atrPeriod: 14,
  swingLeft: 3,
  swingRight: 3,
  swingMinAtr: 0.5,
  equalTolAtr: 0.1,
  breakMinAtr: 0.05,
  rangeBars: 150,
  dispBodyAtr: 1.0,
  dispBodyPct: 0.6,
  dispRunBars: 3,
  dispRunAtr: 2.0,
  dispRunMinBodyPct: 0.5,
  dispBreakWindow: 3,
  fvgMinAtr: 0.1,
  fvgFreshBars: 10,
  fvgExpiryBars: 500,
  rangeMinAtr: 1.0,
  eqBandPct: 5,
  seqLookbackBars: 150,
  minHistoryBars: 50,
  maxEvents: 400,
  maxObjects: 300,
});

export const smcSettingsKey = (s: SmcSettings) => JSON.stringify(s);

/** Analysis order: highest timeframe first. */
export const SMC_TIMEFRAMES: readonly Timeframe[] = ['D1', 'H4', 'H1', 'M30', 'M15', 'M5', 'M1'];
export const SMC_TF_SECONDS: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 });

/* ------------------------------- score ------------------------------- */

export type SmcScoreKey = 'htfStructure' | 'liquidity' | 'sweep' | 'bosChoch' | 'displacement' | 'orderBlock' | 'fvg' | 'premiumDiscount' | 'mtfAlignment';

/** Confluence weights (%, total 100). A confluence / analysis score — never a probability or expected profit. */
export const SMC_SCORE_WEIGHTS: Readonly<Record<SmcScoreKey, number>> = Object.freeze({
  htfStructure: 15,
  liquidity: 10,
  sweep: 10,
  bosChoch: 15,
  displacement: 10,
  orderBlock: 10,
  fvg: 10,
  premiumDiscount: 10,
  mtfAlignment: 10,
});

export const SMC_SCORE_LABEL: Readonly<Record<SmcScoreKey, string>> = Object.freeze({
  htfStructure: 'HTF Structure',
  liquidity: 'Liquidity Context',
  sweep: 'Sweep Quality',
  bosChoch: 'BOS / CHOCH',
  displacement: 'Displacement',
  orderBlock: 'Order Block',
  fvg: 'FVG / Imbalance',
  premiumDiscount: 'Premium / Discount',
  mtfAlignment: 'MTF Alignment',
});

/** Missing mandatory structural evidence caps the score at this value. */
export const SMC_SCORE_CAP_MISSING = 40;
/** Context timeframes for the score: structure from H4 + H1, execution context from M15 (+ H1). */
export const SMC_HTF: readonly Timeframe[] = ['H4', 'H1'];
export const SMC_LTF: Timeframe = 'M15';
/** Timeframes that must be READY for an MTF verdict. */
export const SMC_CORE_TFS: readonly Timeframe[] = ['H4', 'H1', 'M15'];
