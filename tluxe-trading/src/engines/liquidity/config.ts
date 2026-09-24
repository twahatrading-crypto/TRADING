import type { Timeframe } from '../../types/market';
import type { LiquidityScoreKey, PoolState } from './types';

/**
 * Liquidity Engine v1 parameters — the only place its constants live.
 * Independent from the S&R engine (no shared settings, no shared scoring).
 * All distances are ATR multiples of the pool's own timeframe (plus an
 * absolute tick floor), so they work for XAUUSD, EURUSD, BTCUSD… alike.
 */
export interface LiquiditySettings {
  /** Wilder ATR period. */
  atrPeriod: number;
  /** Bars on the left a swing must strictly exceed. */
  swingLeft: number;
  /** Bars on the right that must CLOSE before a swing is confirmed (default 3). */
  swingRight: number;
  /** Equal-level tolerance = max(equalTolAtr × ATR, equalMinTicks × tick). Also the sweep threshold beyond the level. */
  equalTolAtr: number;
  equalMinTicks: number;
  /** A single swing qualifies as liquidity once price has CLOSED this far away from it (ATR). */
  qualifyDisplacementAtr: number;
  /** A FORMING candidate that has not qualified within this many bars is INVALIDATED. */
  qualifyWindowBars: number;
  /** Price within this distance below a BSL level (above an SSL level) counts as a test (ATR). */
  testTolAtr: number;
  /** A test ends when price moves this far back away (ATR). */
  testSeparationAtr: number;
  /** A close back on the resting side within this many bars after the sweep bar = RECLAIM (0 = same bar only). */
  reclaimWindowBars: number;
  /** Acceptance (continuation): this many consecutive closes beyond level + acceptTolAtr × ATR … */
  acceptCloses: number;
  acceptTolAtr: number;
  /** … or one close beyond level + acceptDisplacementAtr × ATR. */
  acceptDisplacementAtr: number;
  /** Closed bars required before a timeframe reports pools. */
  minHistoryBars: number;
  /** Freshness decays to 0 after this many bars. */
  freshnessBars: number;
  /** Candle gap larger than this many bar-lengths is reported. */
  gapToleranceBars: number;
  /** Display: pools below this score are hidden in the chart. */
  minDisplayScore: number;
  maxDisplayedPools: number;
}

export const DEFAULT_LIQUIDITY_SETTINGS: Readonly<LiquiditySettings> = Object.freeze({
  atrPeriod: 14,
  swingLeft: 3,
  swingRight: 3,
  equalTolAtr: 0.1,
  equalMinTicks: 2,
  qualifyDisplacementAtr: 1.0,
  qualifyWindowBars: 30,
  testTolAtr: 0.15,
  testSeparationAtr: 0.5,
  reclaimWindowBars: 3,
  acceptCloses: 2,
  acceptTolAtr: 0.1,
  acceptDisplacementAtr: 1.0,
  minHistoryBars: 50,
  freshnessBars: 500,
  gapToleranceBars: 1.5,
  minDisplayScore: 30,
  maxDisplayedPools: 12,
});

export const liquiditySettingsKey = (s: LiquiditySettings) => JSON.stringify(s);

/* ------------------------------- scoring ------------------------------- */

/** Σ weights = 1. Each component is 0–100. See score.ts. */
export const LIQUIDITY_SCORE_WEIGHTS: Readonly<Record<LiquidityScoreKey, number>> = Object.freeze({
  timeframe: 0.2,
  equalLevels: 0.2,
  significance: 0.2,
  displacement: 0.15,
  tests: 0.1,
  freshness: 0.1,
  confluence: 0.05,
});

export const LIQUIDITY_TF_WEIGHT: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 20, M5: 30, M15: 45, M30: 55, H1: 70, H4: 85, D1: 100 });

/** Multiplier after weighting: taken / ended pools score lower. */
export const STATE_FACTOR: Readonly<Record<PoolState, number>> = Object.freeze({
  FORMING: 0.6,
  ACTIVE: 1,
  TESTED: 1,
  SWEPT: 0.5,
  CONSUMED: 0.2,
  INVALIDATED: 0,
});

/** Contributing highs/lows → equal-levels component. */
export const EQUAL_LEVELS_SCORE = [0, 0, 60, 85, 100] as const;
/** Prominence / displacement (ATR) that earns a full component. */
export const SIGNIFICANCE_FULL_ATR = 3;
export const DISPLACEMENT_FULL_ATR = 3;

export const LIQUIDITY_TF_RANK: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 1, M5: 2, M15: 3, M30: 4, H1: 5, H4: 6, D1: 7 });
export const LIQUIDITY_TF_SECONDS: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 });
export const LIQUIDITY_TIMEFRAMES = Object.keys(LIQUIDITY_TF_SECONDS) as Timeframe[];
