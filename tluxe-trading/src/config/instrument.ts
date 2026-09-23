import type { Timeframe } from '../types/market';

export const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
export const DEFAULT_TIMEFRAME: Timeframe = 'H1';

/** A LIVE feed with no message for this long is flagged as stale in the UI. */
export const QUOTE_STALE_AFTER_MS = 15_000;
