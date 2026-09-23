import type { AssetClass, DataCapability, InstrumentId } from './instruments';

/**
 * Normalized market-data contracts.
 *
 * DATA INTEGRITY: every numeric market field is `number | null`.
 * `null` means "unknown / not supplied by the provider" and must be rendered
 * as unknown — never coerced to 0 or any other placeholder value.
 */

export type ConnectionState =
  | 'LIVE'
  | 'DELAYED'
  | 'CONNECTING'
  | 'DISCONNECTED'
  | 'UNAVAILABLE';

export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';

/** Display-ready view of the active instrument (derived from InstrumentDefinition). */
export interface InstrumentInfo {
  id: InstrumentId;
  symbol: string;
  displayName: string;
  name: string;
  assetClass: AssetClass;
  /** Listing exchange, or null for OTC / broker / multi-venue instruments. */
  exchange: string | null;
  venue: string;
  currency: string;
  /** Price decimals used for display. */
  priceDecimals: number;
  /** Contract code if known (e.g. "GCZ6"). Null until a provider supplies it. */
  contract: string | null;
}

export interface Quote {
  last: number | null;
  change: number | null;
  changePercent: number | null;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** Exchange / provider timestamp of the quote (epoch ms), if supplied. */
  timestamp: number | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** Delay in seconds declared by the provider for DELAYED feeds. */
  declaredDelaySec: number | null;
}

/** Status of one data source (price or depth) for one instrument. */
export interface FeedStatus {
  provider: ProviderInfo | null;
  connection: ConnectionState;
  lastMessageAt: number | null;
  error: string | null;
}

/** Normalized market state for ONE instrument. Every instrument has its own. */
export interface MarketState {
  instrument: InstrumentInfo;
  /* Price feed (quotes / candles) — kept flat for quote-bar consumers. */
  provider: ProviderInfo | null;
  connection: ConnectionState;
  quote: Quote;
  /** Local receipt time of the last price-feed message (epoch ms). */
  lastMessageAt: number | null;
  error: string | null;
  /** Depth / order-book feed, independent of the price feed. */
  depth: FeedStatus & {
    /** Whether any depth source is mapped for this instrument at all. */
    supported: boolean;
  };
  /** Capabilities currently supplied by connected providers (never assumed). */
  capabilities: DataCapability[];
}

/** OHLCV candle. `time` is the bar open time in epoch seconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export const EMPTY_QUOTE: Readonly<Quote> = Object.freeze({
  last: null,
  change: null,
  changePercent: null,
  bid: null,
  ask: null,
  high: null,
  low: null,
  volume: null,
  timestamp: null,
});
