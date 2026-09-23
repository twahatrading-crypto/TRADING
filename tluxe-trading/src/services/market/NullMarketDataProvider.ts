import type { MarketDataProvider, MarketDataSink } from './MarketDataProvider';

/** Used when no market-data provider is configured. Emits no data, ever. */
export class NullMarketDataProvider implements MarketDataProvider {
  readonly info = null;
  connect(_symbol: string, sink: MarketDataSink): void {
    sink.connection('UNAVAILABLE', null);
  }
  disconnect(): void {}
  requestCandles(): void {}
}
