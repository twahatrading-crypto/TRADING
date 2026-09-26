/* ============================================================================
 * NEWS ANALYSIS — vendor-neutral, POINT-IN-TIME types. All times are epoch MILLISECONDS (UTC,
 * unambiguous); display time zones are applied only in the UI. Candle times (MT5) stay in seconds.
 * ========================================================================== */

export type NewsCategory = 'CENTRAL_BANK' | 'INFLATION' | 'EMPLOYMENT' | 'GROWTH' | 'RATES' | 'USD_FX' | 'GEOPOLITICAL' | 'METALS' | 'CRYPTO' | 'OTHER';
export type NewsImpact = 'HIGH' | 'MEDIUM' | 'LOW';
export type NewsKind = 'SCHEDULED' | 'HEADLINE';
export type NewsProviderKind = 'calendar' | 'breaking' | 'macro';
/** What the provider can genuinely deliver. Never upgraded by TLUXE. */
export type NewsLatency = 'REALTIME' | 'DELAYED' | 'END_OF_DAY' | 'UNKNOWN';

/** A published number as released ("3.2%", "215K"). `value` is null when the text is not numeric. */
export interface NewsValue {
  raw: string;
  value: number | null;
  unit: string | null;
  decimals: number;
}

/**
 * One normalized message: what TLUXE learned about one provider event at `knownAt`.
 * Updates are never merged destructively — the engine keeps every update, so the state at any
 * past time T is rebuilt from the updates known by T only (revisions never leak backwards).
 */
export interface NewsUpdate {
  /** provider:providerEventId */
  key: string;
  provider: string;
  providerKind: NewsProviderKind;
  providerEventId: string;
  kind: NewsKind;
  title: string;
  country: string | null;
  currency: string | null;
  category: NewsCategory;
  /** Indicator metadata key (config INDICATORS) or null. */
  indicator: string | null;
  /** Impact as supplied by the provider (null = not supplied). */
  providerImpact: NewsImpact | null;
  /** Scheduled release time (scheduled events). */
  scheduledAt: number | null;
  /** Headline publish time / provider's own timestamp for this information. */
  publishedAt: number | null;
  /** When TLUXE received this message. */
  receivedAt: number;
  /** Point-in-time knowledge time (≤ receivedAt). */
  knownAt: number;
  sourceUrl: string | null;
  /** undefined = not part of this update; null = provider says "none". */
  forecast?: NewsValue | null;
  previous?: NewsValue | null;
  actual?: NewsValue | null;
  cancelled?: boolean;
  /** Instruments / assets the provider tagged. */
  instruments: string[];
  latency: NewsLatency;
}

export type EventStatus = 'UPCOMING' | 'PRE_NEWS' | 'LIVE' | 'POST_NEWS' | 'RELEASED' | 'STALE' | 'CANCELLED';

export type ComparisonLabel = 'ABOVE' | 'BELOW' | 'IN_LINE' | 'MISSING_BASE' | 'MISSING_ACTUAL' | 'NOT_COMPARABLE';
export type Interpretation = 'HOTTER' | 'COOLER' | 'STRONGER' | 'WEAKER' | 'HAWKISH' | 'DOVISH' | 'IN_LINE';

export interface SurpriseResult {
  /** ABOVE FORECAST / BELOW FORECAST / IN LINE / NO FORECAST / NO ACTUAL / NOT COMPARABLE */
  vsForecast: string;
  vsPrevious: string;
  deltaForecast: number | null;
  deltaForecastPct: number | null;
  deltaPrevious: number | null;
  interpretation: Interpretation | null;
  rule: string;
}

export type Pressure = 'BULLISH PRESSURE' | 'BEARISH PRESSURE' | 'MIXED' | 'NEUTRAL' | 'UNCERTAIN' | 'INSUFFICIENT DATA';
export type Dimension = 'USD' | 'RATES' | 'GOLD' | 'EQUITIES' | 'CRYPTO';
export interface Implication {
  state: Pressure;
  evidence: string;
}
export type Implications = Record<Dimension, Implication>;

export interface Revision {
  field: 'previous' | 'actual';
  original: NewsValue;
  revised: NewsValue;
  revisedAt: number;
}

export interface ReactionHorizon {
  minutes: number;
  /** Close time of the measured candle (ms). */
  time: number;
  price: number | null;
  change: number | null;
  changePct: number | null;
  state: 'OK' | 'PENDING' | 'MISSING';
}
export interface ReactionResult {
  instrumentId: string;
  status: 'UNAVAILABLE' | 'PENDING' | 'PARTIAL' | 'COMPLETE';
  reason: string | null;
  preTime: number | null;
  prePrice: number | null;
  horizons: ReactionHorizon[];
  maxUp: number | null;
  maxDown: number | null;
  volExpansion: number | null;
  displacementAtr: number | null;
  pattern: 'CONTINUATION' | 'REVERSAL' | null;
  retracePct: number | null;
}

/** An event as known at time T (derived; never stored as truth). */
export interface NewsEventView {
  key: string;
  provider: string;
  providerKind: NewsProviderKind;
  providerEventId: string;
  kind: NewsKind;
  title: string;
  country: string | null;
  currency: string | null;
  category: NewsCategory;
  indicator: string | null;
  impact: NewsImpact;
  impactSource: 'PROVIDER' | 'RULE';
  impactRule: string;
  scheduledAt: number | null;
  publishedAt: number | null;
  firstKnownAt: number;
  firstReceivedAt: number;
  lastKnownAt: number;
  sourceUrl: string | null;
  forecast: NewsValue | null;
  previous: NewsValue | null;
  actual: NewsValue | null;
  actualKnownAt: number | null;
  actualReceivedAt: number | null;
  revisions: Revision[];
  cancelled: boolean;
  affected: string[];
  status: EventStatus;
  latency: NewsLatency;
  /** Another provider's event with the same currency / title / release minute was kept instead. */
  duplicateOf: string | null;
  updates: number;
  surprise: SurpriseResult | null;
  implications: Implications;
}

export type RiskState = 'NORMAL' | 'PRE_NEWS' | 'NEWS_LIVE' | 'POST_NEWS';
export interface RiskReason {
  eventKey: string;
  title: string;
  state: Exclude<RiskState, 'NORMAL'>;
  from: number;
  to: number;
  text: string;
}
export interface InstrumentRisk {
  instrumentId: string;
  state: RiskState;
  reasons: RiskReason[];
  /** End of the current state (ms) or null. */
  until: number | null;
}

export interface Driver {
  eventKey: string;
  title: string;
  category: NewsCategory;
  impact: NewsImpact;
  time: number;
  state: Pressure;
  evidence: string;
}
export interface Aggregate {
  state: Pressure;
  drivers: Driver[];
  conflict: boolean;
  evidence: string;
}

export type MatrixColumn = 'macro' | 'rates' | 'inflation' | 'employment' | 'geopolitical' | 'current';
export interface MatrixRow {
  asset: string;
  dimension: Dimension;
  cells: Record<MatrixColumn, Aggregate>;
}

export type NewsAlertType = 'HIGH_IMPACT_IN_30' | 'HIGH_IMPACT_IN_15' | 'HIGH_IMPACT_IN_5' | 'NEWS_RELEASED' | 'ACTUAL_AVAILABLE' | 'BREAKING_HIGH_IMPACT';
export interface NewsAlert {
  /** provider:providerEventId:type — the dedupe key. */
  id: string;
  type: NewsAlertType;
  eventKey: string;
  title: string;
  /** The moment the condition occurred. */
  at: number;
  /** When TLUXE raised it. */
  raisedAt: number;
  message: string;
}

export interface NewsSnapshot {
  time: number;
  events: NewsEventView[];
  calendar: NewsEventView[];
  headlines: NewsEventView[];
  nextHigh: NewsEventView | null;
  risk: Record<string, InstrumentRisk>;
  aggregates: Record<Dimension, Aggregate>;
  byGroup: Record<Exclude<MatrixColumn, 'current'>, Record<Dimension, Aggregate>>;
  matrix: MatrixRow[];
  conflicts: string[];
  duplicates: number;
}
