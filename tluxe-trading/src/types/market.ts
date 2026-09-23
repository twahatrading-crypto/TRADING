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
  /** Current spread in points, when the source supplies bid and ask. */
  spreadPoints?: number | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** Delay in seconds declared by the provider for DELAYED feeds. */
  declaredDelaySec: number | null;
}

/** Detailed provider status for one instrument (shown to the user verbatim). */
export type FeedStatusCode =
  | 'MT5_BRIDGE_OFFLINE'
  | 'MT5_NOT_RUNNING'
  | 'MT5_CONNECTING'
  | 'MT5_CONNECTED'
  | 'SYMBOL_NOT_FOUND'
  | 'AMBIGUOUS_SYMBOL'
  | 'MARKET_CLOSED'
  | 'INSUFFICIENT_HISTORY'
  | 'LIVE'
  | 'STALE'
  | 'ERROR';

export interface ProviderSymbolMeta {
  description: string | null;
  digits: number | null;
  point: number | null;
  tickSize: number | null;
  contractSize: number | null;
  tradeMode: number | null;
  spreadFloat: boolean | null;
}

/** Everything the UI may say about a provider feed for one instrument. Times are UTC epoch ms. */
export interface ProviderFeedDetail {
  code: FeedStatusCode;
  message: string | null;
  /** Provider's own symbol (e.g. "GOLD.a"); the app keeps using the canonical id. */
  providerSymbol: string | null;
  /** Plausible symbols when ambiguous, or lower-priority alternatives when resolved. */
  candidates: string[];
  inverted: boolean;
  lastQuoteAt: number | null;
  lastCandleAt: number | null;
  lastClosedCandleAt: number | null;
  bridgeHeartbeatAt: number | null;
  historyBars: Partial<Record<Timeframe, number>>;
  historyLimited: Partial<Record<Timeframe, boolean>>;
  meta: ProviderSymbolMeta | null;
  /** null = not yet known; false = source supplies no real volume. */
  realVolumeAvailable: boolean | null;
  quarantined: number;
  gaps: number;
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
  /** Detailed price-provider status (null when the provider reports none). */
  feed: ProviderFeedDetail | null;
}

/**
 * Normalised OHLC candle.
 * `time` is the bar OPEN time in epoch seconds, UTC (never broker-local time).
 * Optional fields are null/undefined when the source does not supply them —
 * a missing value is never represented as 0.
 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Real traded volume when the source supplies it; null otherwise. */
  volume: number | null;
  /** Number of price changes in the bar (MT5 tick_volume). NOT exchange volume. */
  tickVolume?: number | null;
  /** Exchange/real volume (MT5 real_volume) when genuinely supplied; null when unavailable. */
  realVolume?: number | null;
  /** Spread in points as supplied by the source. */
  spread?: number | null;
  instrumentId?: InstrumentId;
  providerSymbol?: string;
  timeframe?: Timeframe;
  /** Data source id, e.g. "mt5". */
  source?: string;
  /** true = final bar, false = still forming, undefined = source did not say (treat conservatively). */
  isClosed?: boolean;
  /** Raw source timestamp before UTC normalisation (e.g. MT5 server-time epoch), for audit. */
  sourceTime?: number;
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
