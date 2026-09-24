import type { Timeframe } from '../../types/market';
import type { OBScoreKey } from './types';

/**
 * Order Block Engine v1 parameters — the only place its constants live.
 * Independent of the S&R and Liquidity engines. Distances are ATR multiples of
 * the block's own timeframe (Wilder ATR), so the same rules work on every instrument.
 */
export interface OBSettings {
  atrPeriod: number;
  /** Swing: strictly beyond swingLeft bars before, ≥ swingRight bars after; confirmed on the close of bar +swingRight. */
  swingLeft: number;
  swingRight: number;
  /** A break needs a CLOSE beyond the swing level by more than breakTolAtr × ATR. */
  breakTolAtr: number;
  /** Displacement: leg (origin extreme → break close) ≥ minLegAtr × ATR … */
  minLegAtr: number;
  /** … and at least one candle body in the leg ≥ minBodyAtr × ATR. */
  minBodyAtr: number;
  /** Origin search: the last opposite candle within this many bars before the break bar. */
  originLookback: number;
  /** 'wickBody': bullish low = origin low, high = origin body top (open); bearish mirrors. 'fullRange': full candle range. */
  boundaryMode: 'wickBody' | 'fullRange';
  /** 'single': the last opposite candle; 'cluster': the whole run of consecutive opposite candles ending there. */
  originMode: 'single' | 'cluster';
  /** Untouched blocks older than this are ACTIVE instead of FRESH. */
  freshBars: number;
  /** Penetration (wick into the zone from its facing edge) ≥ this % of the zone height = MITIGATED. */
  mitigationPct: number;
  /** A CLOSE beyond the far edge by more than invalidTolAtr × ATR = INVALIDATED. */
  invalidTolAtr: number;
  /** 0 disables expiry; otherwise blocks older than this many bars EXPIRE. */
  expiryBars: number;
  minHistoryBars: number;
  gapToleranceBars: number;
  /** Display. */
  minDisplayScore: number;
  maxDisplayedBlocks: number;
}

export const DEFAULT_OB_SETTINGS: Readonly<OBSettings> = Object.freeze({
  atrPeriod: 14,
  swingLeft: 3,
  swingRight: 3,
  breakTolAtr: 0,
  minLegAtr: 1.5,
  minBodyAtr: 0.8,
  originLookback: 10,
  boundaryMode: 'wickBody',
  originMode: 'single',
  freshBars: 20,
  mitigationPct: 50,
  invalidTolAtr: 0,
  expiryBars: 500,
  minHistoryBars: 50,
  gapToleranceBars: 1.5,
  minDisplayScore: 30,
  maxDisplayedBlocks: 12,
});

export const obSettingsKey = (s: OBSettings) => JSON.stringify(s);

/** Score weights in % — total exactly 100 (asserted in tests). */
export const OB_SCORE_WEIGHTS: Readonly<Record<OBScoreKey, number>> = Object.freeze({
  timeframe: 15,
  displacement: 20,
  structure: 20,
  origin: 15,
  freshness: 10,
  mitigation: 10,
  imbalance: 5,
  confluence: 5,
});

export const OB_TF_WEIGHT: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 20, M5: 30, M15: 45, M30: 55, H1: 70, H4: 85, D1: 100 });
export const OB_TF_RANK: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 1, M5: 2, M15: 3, M30: 4, H1: 5, H4: 6, D1: 7 });
export const OB_TF_SECONDS: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 });
export const OB_TIMEFRAMES = Object.keys(OB_TF_SECONDS) as Timeframe[];
/** Displacement (leg in ATR) that earns the full displacement component. */
export const OB_DISPLACEMENT_FULL_ATR = 4;
