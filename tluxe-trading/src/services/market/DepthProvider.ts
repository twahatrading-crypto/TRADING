import type { DataCapability, InstrumentDefinition, InstrumentId, ProviderMapping } from '../../types/instruments';
import type { ConnectionState, ProviderInfo } from '../../types/market';

/**
 * Depth / order-book source (e.g. Bookmap for COMEX futures). This is a
 * second, independent capability alongside the price feed: having MT5 prices
 * never implies exchange Level-2 depth.
 */

export interface DepthLevel {
  price: number;
  size: number;
  /** Order count at the level when the source supplies it (MBP/MBO). */
  orders: number | null;
}

export interface DepthSnapshot {
  instrumentId: InstrumentId;
  bids: DepthLevel[];
  asks: DepthLevel[];
  /** Source granularity as supplied. */
  kind: 'level2' | 'mbp' | 'mbo';
  timestamp: number;
}

export interface DepthSink {
  connection(instrumentId: InstrumentId, state: ConnectionState, error?: string | null): void;
  capabilities(instrumentId: InstrumentId, caps: DataCapability[]): void;
  book(snapshot: DepthSnapshot): void;
}

export interface DepthProvider {
  readonly info: ProviderInfo;
  readonly family: 'depth-feed';
  connect(sink: DepthSink): void;
  disconnect(): void;
  subscribe(instrument: InstrumentDefinition, mapping: ProviderMapping): void;
  unsubscribe(instrumentId: InstrumentId): void;
}
