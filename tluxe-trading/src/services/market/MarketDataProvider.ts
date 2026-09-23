import type { Candle, ConnectionState, InstrumentInfo, ProviderInfo, Quote, Timeframe } from '../../types/market';

/** Callbacks a provider uses to push raw data into the normalization layer. */
export interface MarketDataSink {
  connection(state: ConnectionState, error?: string | null): void;
  /** Partial quote update; omitted fields keep their previous value. */
  quote(update: Partial<Quote>, instrument?: Partial<Pick<InstrumentInfo, 'contract'>>): void;
  candles(timeframe: Timeframe, candles: Candle[], mode: 'replace' | 'upsert'): void;
}

/**
 * Contract every market-data adapter implements (broker, exchange, vendor).
 * Adapters must only report LIVE/DELAYED when the upstream feed says so.
 */
export interface MarketDataProvider {
  /** Null when no provider is configured. */
  readonly info: ProviderInfo | null;
  connect(symbol: string, sink: MarketDataSink): void;
  disconnect(): void;
  /** Ask for history on a timeframe; data arrives through `sink.candles`. */
  requestCandles(timeframe: Timeframe): void;
}
