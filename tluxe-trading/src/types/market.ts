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

export interface InstrumentInfo {
  /** Root symbol, e.g. "GC". */
  symbol: string;
  /** Contract code if known (e.g. "GCZ6"). Null until a provider supplies it. */
  contract: string | null;
  name: string;
  exchange: string;
  currency: string;
  /** Price decimals used for display. */
  priceDecimals: number;
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

export interface MarketState {
  instrument: InstrumentInfo;
  provider: ProviderInfo | null;
  connection: ConnectionState;
  quote: Quote;
  /** Local receipt time of the last provider message (epoch ms). */
  lastMessageAt: number | null;
  error: string | null;
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
