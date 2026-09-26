import type { FPTimeframe } from './types';

/** Analysis settings (they change how recorded trades are AGGREGATED — the recorded trades never change). */
export interface FootprintSettings {
  /** Ticks per footprint row (price aggregation). */
  rowTicks: number;
  /** Imbalance: one side ≥ ratio × the compared side (3 = 300 %). */
  imbalanceRatio: number;
  /** 'diagonal' = ask(p) vs bid(p − row) / bid(p) vs ask(p + row); 'horizontal' = same row. */
  imbalanceMode: 'diagonal' | 'horizontal';
  /** Minimum volume of the dominant side for an imbalance. */
  minVolume: number;
  /** Consecutive imbalance rows for a stacked imbalance. */
  stackedLevels: number;
  /** Single-trade size for LARGE TRADE. */
  largeTrade: number;
  /** Absorption: extreme-zone aggressive volume ≥ share of the candle's same-side volume … */
  absorbShare: number;
  /** … within this many rows of the extreme … */
  absorbRows: number;
  /** … and the close is at least this many rows back from the extreme (no continuation). */
  absorbRetraceRows: number;
  /** Exhaustion: extreme-row volume ≤ this share of the candle POC volume (with tapering volume). */
  exhaustRel: number;
  /** Delta divergence lookback (closed candles of the same timeframe). */
  divergenceLookback: number;
}

export const DEFAULT_FP_SETTINGS: Readonly<FootprintSettings> = Object.freeze({
  rowTicks: 1,
  imbalanceRatio: 3,
  imbalanceMode: 'diagonal',
  minVolume: 10,
  stackedLevels: 3,
  largeTrade: 50,
  absorbShare: 0.3,
  absorbRows: 2,
  absorbRetraceRows: 3,
  exhaustRel: 0.15,
  divergenceLookback: 5,
});

export const FP_TIMEFRAMES: readonly FPTimeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1'];
export const FP_TF_SECONDS: Readonly<Record<FPTimeframe, number>> = Object.freeze({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600 });
/** Bounded history per timeframe (oldest closed candles are dropped, IDs stay stable). */
export const FP_MAX_CANDLES: Readonly<Record<FPTimeframe, number>> = Object.freeze({ M1: 720, M5: 576, M15: 384, M30: 240, H1: 240 });
export const FP_MAX_EVENTS = 1500;
export const FP_MAX_LEVELS = 400;
/** Integrity problems within this exchange-time window keep the state DEGRADED. */
export const FP_DEGRADED_WINDOW_MS = 30 * 60_000;
/** Duplicate-detection memory (trade ids / sequence numbers). */
export const FP_DEDUPE_MEMORY = 50_000;
/** CME Globex metals session: 18:00 New York → 17:00 New York. */
export const FP_SESSION_TZ = 'America/New_York';
export const FP_SESSION_START_HOUR = 18;

export const settingsKey = (s: FootprintSettings) => JSON.stringify([s.rowTicks, s.imbalanceRatio, s.imbalanceMode, s.minVolume, s.stackedLevels, s.largeTrade, s.absorbShare, s.absorbRows, s.absorbRetraceRows, s.exhaustRel, s.divergenceLookback]);
