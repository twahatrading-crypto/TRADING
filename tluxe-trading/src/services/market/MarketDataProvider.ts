import type { DataCapability, InstrumentDefinition, InstrumentId, ProviderFamily, ProviderMapping } from '../../types/instruments';
import type { Candle, ConnectionState, ProviderInfo, Quote, Timeframe } from '../../types/market';

/** Callbacks a price adapter uses to push data. Every call names the canonical instrument. */
export interface MarketDataSink {
  connection(instrumentId: InstrumentId, state: ConnectionState, error?: string | null): void;
  /** Capabilities the provider actually supplies right now (intersected with the mapping). */
  capabilities(instrumentId: InstrumentId, caps: DataCapability[]): void;
  /** Partial quote update, already in canonical orientation. Omitted fields keep their value. */
  quote(instrumentId: InstrumentId, update: Partial<Quote>, meta?: { contract?: string | null }): void;
  candles(instrumentId: InstrumentId, timeframe: Timeframe, candles: Candle[], mode: 'replace' | 'upsert'): void;
}

/**
 * Price-feed adapter contract (quotes / candles / trades): MT5, a futures
 * vendor, a crypto exchange… Adapters resolve their own provider symbols via
 * `resolveProviderSymbol` and must only report LIVE/DELAYED when upstream does.
 */
export interface MarketDataProvider {
  readonly info: ProviderInfo;
  readonly family: ProviderFamily;
  connect(sink: MarketDataSink): void;
  disconnect(): void;
  subscribe(instrument: InstrumentDefinition, mapping: ProviderMapping): void;
  unsubscribe(instrumentId: InstrumentId): void;
  requestCandles(instrumentId: InstrumentId, timeframe: Timeframe): void;
}
