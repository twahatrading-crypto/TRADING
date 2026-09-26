import type { Dimension, MatrixColumn, NewsCategory, NewsImpact } from './types';

/* ============================================================================
 * NEWS ANALYSIS CONFIG — every rule constant lives here and is shown in the UI.
 * ========================================================================== */

/**
 * Indicator metadata. `direction` states what a HIGHER print means economically — never "higher =
 * bullish":
 *   INFLATION         higher = hotter prices            (HOTTER / COOLER)
 *   ACTIVITY          higher = stronger economy         (STRONGER / WEAKER)
 *   INVERSE_ACTIVITY  higher = weaker economy           (unemployment, jobless claims)
 *   POLICY_RATE       higher = hawkish policy           (HAWKISH / DOVISH)
 *   NONE              no quantitative direction (speeches, minutes, auctions)
 * `impact` is the rule-based impact used only when the provider supplies none.
 */
export type IndicatorDirection = 'INFLATION' | 'ACTIVITY' | 'INVERSE_ACTIVITY' | 'POLICY_RATE' | 'NONE';
export interface IndicatorMeta {
  key: string;
  label: string;
  patterns: RegExp[];
  category: NewsCategory;
  impact: NewsImpact;
  direction: IndicatorDirection;
}

// Order matters: the first match wins (Core CPI before CPI, etc.).
export const INDICATORS: readonly IndicatorMeta[] = [
  { key: 'RATE_DECISION', label: 'Policy rate decision', patterns: [/\b(interest )?rate decision\b/i, /\bfomc (rate|statement|decision)\b/i, /\bfed(eral)? funds rate\b/i, /\bcash rate\b/i, /\bbank rate\b/i, /\bmain refinancing rate\b/i, /\bdeposit (facility )?rate\b/i], category: 'CENTRAL_BANK', impact: 'HIGH', direction: 'POLICY_RATE' },
  { key: 'FOMC_MINUTES', label: 'FOMC minutes', patterns: [/\bfomc minutes\b/i], category: 'CENTRAL_BANK', impact: 'MEDIUM', direction: 'NONE' },
  { key: 'CB_SPEECH', label: 'Central-bank speech / press conference', patterns: [/\bpowell\b/i, /\blagarde\b/i, /\bbailey\b/i, /\bueda\b/i, /\bmacklem\b/i, /\bbullock\b/i, /\bpress conference\b/i, /\b(fed|ecb|boe|boj|boc|rba) .*speaks?\b/i, /\bspeech\b/i], category: 'CENTRAL_BANK', impact: 'MEDIUM', direction: 'NONE' },
  { key: 'CORE_PCE', label: 'Core PCE', patterns: [/\bcore pce\b/i], category: 'INFLATION', impact: 'HIGH', direction: 'INFLATION' },
  { key: 'PCE', label: 'PCE', patterns: [/\bpce\b/i], category: 'INFLATION', impact: 'MEDIUM', direction: 'INFLATION' },
  { key: 'CORE_CPI', label: 'Core CPI', patterns: [/\bcore cpi\b/i, /\bcpi ex/i], category: 'INFLATION', impact: 'HIGH', direction: 'INFLATION' },
  { key: 'CPI', label: 'CPI', patterns: [/\bcpi\b/i, /\bconsumer price index\b/i, /\binflation rate\b/i, /\bhicp\b/i], category: 'INFLATION', impact: 'HIGH', direction: 'INFLATION' },
  { key: 'PPI', label: 'PPI', patterns: [/\bppi\b/i, /\bproducer price/i], category: 'INFLATION', impact: 'MEDIUM', direction: 'INFLATION' },
  { key: 'WAGES', label: 'Wage growth', patterns: [/\baverage (hourly )?earnings\b/i, /\bwage growth\b/i, /\bemployment cost index\b/i], category: 'EMPLOYMENT', impact: 'MEDIUM', direction: 'INFLATION' },
  { key: 'NFP', label: 'Non-farm payrolls', patterns: [/\bnon[- ]?farm (employment|payrolls)\b/i, /\bnfp\b/i], category: 'EMPLOYMENT', impact: 'HIGH', direction: 'ACTIVITY' },
  { key: 'UNEMPLOYMENT', label: 'Unemployment rate', patterns: [/\bunemployment rate\b/i], category: 'EMPLOYMENT', impact: 'HIGH', direction: 'INVERSE_ACTIVITY' },
  { key: 'JOBLESS_CLAIMS', label: 'Jobless claims', patterns: [/\bjobless claims\b/i, /\bunemployment claims\b/i], category: 'EMPLOYMENT', impact: 'MEDIUM', direction: 'INVERSE_ACTIVITY' },
  { key: 'JOLTS', label: 'JOLTS job openings', patterns: [/\bjolts\b/i, /\bjob openings\b/i], category: 'EMPLOYMENT', impact: 'MEDIUM', direction: 'ACTIVITY' },
  { key: 'ADP', label: 'ADP employment', patterns: [/\badp\b/i], category: 'EMPLOYMENT', impact: 'MEDIUM', direction: 'ACTIVITY' },
  { key: 'EMPLOYMENT_CHANGE', label: 'Employment change', patterns: [/\bemployment change\b/i], category: 'EMPLOYMENT', impact: 'HIGH', direction: 'ACTIVITY' },
  { key: 'GDP', label: 'GDP', patterns: [/\bgdp\b/i, /\bgross domestic product\b/i], category: 'GROWTH', impact: 'HIGH', direction: 'ACTIVITY' },
  { key: 'ISM', label: 'ISM PMI', patterns: [/\bism\b/i], category: 'GROWTH', impact: 'HIGH', direction: 'ACTIVITY' },
  { key: 'PMI', label: 'PMI', patterns: [/\bpmi\b/i, /\bpurchasing managers/i], category: 'GROWTH', impact: 'MEDIUM', direction: 'ACTIVITY' },
  { key: 'RETAIL_SALES', label: 'Retail sales', patterns: [/\bretail sales\b/i], category: 'GROWTH', impact: 'HIGH', direction: 'ACTIVITY' },
  { key: 'INDUSTRIAL_PRODUCTION', label: 'Industrial production', patterns: [/\bindustrial production\b/i], category: 'GROWTH', impact: 'LOW', direction: 'ACTIVITY' },
  { key: 'DURABLE_GOODS', label: 'Durable goods orders', patterns: [/\bdurable goods\b/i], category: 'GROWTH', impact: 'MEDIUM', direction: 'ACTIVITY' },
  { key: 'CONSUMER_CONFIDENCE', label: 'Consumer confidence / sentiment', patterns: [/\bconsumer (confidence|sentiment)\b/i], category: 'GROWTH', impact: 'MEDIUM', direction: 'ACTIVITY' },
  { key: 'HOUSING', label: 'Housing data', patterns: [/\b(new|pending|existing) home sales\b/i, /\bhousing starts\b/i, /\bbuilding permits\b/i], category: 'GROWTH', impact: 'LOW', direction: 'ACTIVITY' },
  { key: 'TREASURY_AUCTION', label: 'Treasury auction', patterns: [/\b(bond|note|bill|treasury) auction\b/i, /\b\d+-(year|yr) (note|bond) auction\b/i], category: 'RATES', impact: 'LOW', direction: 'NONE' },
];

/** Impact rule for items WITHOUT provider impact and WITHOUT indicator metadata (headlines). */
export const HEADLINE_IMPACT_RULE: Readonly<Record<NewsCategory, NewsImpact>> = Object.freeze({
  CENTRAL_BANK: 'MEDIUM',
  GEOPOLITICAL: 'MEDIUM',
  INFLATION: 'LOW',
  EMPLOYMENT: 'LOW',
  GROWTH: 'LOW',
  RATES: 'LOW',
  USD_FX: 'LOW',
  METALS: 'LOW',
  CRYPTO: 'LOW',
  OTHER: 'LOW',
});

/** Status / risk windows around an event (ms). Scheduled: relative to the release; headline: to publication. */
export interface WindowSpec {
  preMs: number;
  liveMs: number;
  postMs: number;
}
const MIN = 60_000;
export const SCHEDULED_WINDOWS: Readonly<Record<NewsImpact, WindowSpec>> = Object.freeze({
  HIGH: { preMs: 30 * MIN, liveMs: 15 * MIN, postMs: 90 * MIN },
  MEDIUM: { preMs: 15 * MIN, liveMs: 5 * MIN, postMs: 30 * MIN },
  LOW: { preMs: 0, liveMs: 0, postMs: 0 },
});
export const HEADLINE_WINDOWS: Readonly<Record<NewsImpact, WindowSpec>> = Object.freeze({
  HIGH: { preMs: 0, liveMs: 15 * MIN, postMs: 60 * MIN },
  MEDIUM: { preMs: 0, liveMs: 10 * MIN, postMs: 30 * MIN },
  LOW: { preMs: 0, liveMs: 10 * MIN, postMs: 0 },
});
/** Only these impacts create NEWS RISK windows (others only change the event status). */
export const RISK_IMPACTS: readonly NewsImpact[] = ['HIGH'];
/** A scheduled numeric release without an Actual this long after release is STALE. */
export const ACTUAL_TIMEOUT_MS = 15 * MIN;
/** Drivers older than this no longer count for current pressure / conflicts. */
export const DRIVER_LOOKBACK_MS = 24 * 60 * MIN;
/** Alerts fire only when raised within this time of the condition AND of the data arriving. */
export const ALERT_FRESH_MS = 2 * MIN;
/** Two providers' scheduled events with the same currency + title within this are one event. */
export const DUPLICATE_WINDOW_MS = 1 * MIN;

/** Observed reaction horizons (minutes after release). */
export const REACTION_HORIZONS = [1, 5, 15, 30, 60] as const;
/** The pre-release price must come from a candle closing ≤ this long before the release. */
export const REACTION_PRE_MAX_MS = 5 * MIN;

/** The news asset universe (TLUXE instruments + reference assets used for impact mapping). */
export const NEWS_ASSETS = ['XAUUSD', 'XAGUSD', 'GC', 'SI', 'BTCUSD', 'ETHUSD', 'SOLUSD', 'EURUSD', 'GBPUSD', 'AUDUSD', 'USDCAD', 'DXY', 'NASDAQ', 'USD'] as const;
const USD_ASSETS = ['USD', 'DXY', 'XAUUSD', 'XAGUSD', 'GC', 'SI', 'EURUSD', 'GBPUSD', 'AUDUSD', 'USDCAD', 'NASDAQ', 'BTCUSD', 'ETHUSD', 'SOLUSD'];
/** Currency → assets whose price is quoted against / driven by it. */
export const CURRENCY_ASSETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  USD: USD_ASSETS,
  EUR: ['EURUSD', 'DXY', 'USD'],
  GBP: ['GBPUSD', 'DXY', 'USD'],
  JPY: ['DXY', 'USD'],
  CAD: ['USDCAD', 'DXY', 'USD'],
  CHF: ['DXY', 'USD'],
  SEK: ['DXY', 'USD'],
  AUD: ['AUDUSD'],
});
/** Category → additional assets (independent of currency). */
export const CATEGORY_ASSETS: Readonly<Partial<Record<NewsCategory, readonly string[]>>> = Object.freeze({
  METALS: ['XAUUSD', 'XAGUSD', 'GC', 'SI'],
  CRYPTO: ['BTCUSD', 'ETHUSD', 'SOLUSD'],
  GEOPOLITICAL: ['XAUUSD', 'XAGUSD', 'GC', 'SI', 'USD', 'DXY', 'NASDAQ', 'BTCUSD'],
});

/** Which pressure dimension describes each asset (for risk / matrix rows). */
export const ASSET_DIMENSION: Readonly<Record<string, Dimension>> = Object.freeze({
  USD: 'USD',
  DXY: 'USD',
  XAUUSD: 'GOLD',
  GC: 'GOLD',
  XAGUSD: 'GOLD',
  SI: 'GOLD',
  NASDAQ: 'EQUITIES',
  BTCUSD: 'CRYPTO',
  ETHUSD: 'CRYPTO',
  SOLUSD: 'CRYPTO',
});
export const MATRIX_ASSETS = ['USD', 'XAUUSD', 'XAGUSD', 'DXY', 'NASDAQ', 'BTCUSD'] as const;
export const DIMENSIONS: readonly Dimension[] = ['USD', 'RATES', 'GOLD', 'EQUITIES', 'CRYPTO'];

/** Matrix column → the event categories whose drivers it aggregates. */
export const COLUMN_CATEGORIES: Readonly<Record<Exclude<MatrixColumn, 'current'>, readonly NewsCategory[]>> = Object.freeze({
  macro: ['GROWTH', 'USD_FX', 'OTHER'],
  rates: ['CENTRAL_BANK', 'RATES'],
  inflation: ['INFLATION'],
  employment: ['EMPLOYMENT'],
  geopolitical: ['GEOPOLITICAL'],
});
