import type { FeedStatus, OrderFlowCapabilities, OrderFlowMsg, OrderFlowStream } from '../../engines/orderFlow/types';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';

/* ============================================================================
 * Order-flow provider boundary. Vendor adapters (Rithmic R|Protocol, T4, CQG, Databento, a private
 * gateway, …) implement these and convert their wire format into the normalized messages in
 * `engines/orderFlow/types`. The engine, service and UI depend ONLY on this file — never on a vendor.
 *
 * Depth and trades are separate providers (they may come from different adapters) with independent
 * statuses. MT5 / spot / CFD sources must NEVER implement these: they have no exchange Level-2 book
 * and no exchange aggressor side.
 *
 * Adapter contract:
 *  • per-stream sequence numbers when the vendor has them (capabilities.sequenced);
 *  • exchange timestamp AND local receive timestamp on every message (ms);
 *  • a depth snapshot first, then incremental updates; requestSnapshot() on a gap (resync);
 *  • heartbeats when the book is quiet, so "no change" is distinguishable from "no data";
 *  • report status honestly (CONNECTING / LIVE / DISCONNECTED / DATA_UNAVAILABLE …);
 *  • reconnect with backoff inside the adapter; after a reconnect, send a fresh snapshot.
 * ========================================================================== */

export interface OrderFlowProviderInfo {
  id: string;
  /** Shown in the UI (e.g. "Rithmic — CME Globex"). */
  name: string;
  /** TEST providers are only allowed in tests and the dev harness. */
  test?: boolean;
}

export interface OrderFlowSink {
  message(m: OrderFlowMsg): void;
  status(instrumentId: InstrumentId, stream: OrderFlowStream, status: FeedStatus, detail?: string | null): void;
  capabilities(instrumentId: InstrumentId, caps: OrderFlowCapabilities): void;
  /** The exchange contract actually streamed (e.g. "GCZ6"). */
  contract(instrumentId: InstrumentId, contract: string | null): void;
}

interface ProviderBase {
  readonly info: OrderFlowProviderInfo;
  connect(sink: OrderFlowSink): void;
  disconnect(): void;
  subscribe(instrument: InstrumentDefinition): void;
  unsubscribe(instrumentId: InstrumentId): void;
}

/** Exchange Level-2 depth (MBP or MBO aggregated to price levels). */
export interface OrderFlowDepthProvider extends ProviderBase {
  readonly stream: 'depth' | 'both';
  /** Ask the provider for a fresh full snapshot (resync after a sequence gap / reconnect). */
  requestSnapshot(instrumentId: InstrumentId): void;
}

/** Exchange time & sales (prints) with the exchange aggressor side when available. */
export interface OrderFlowTradeProvider extends ProviderBase {
  readonly stream: 'trade' | 'both';
}

export interface OrderFlowProviders {
  depth: OrderFlowDepthProvider | null;
  trade: OrderFlowTradeProvider | null;
}

/** Production default: nothing connected (the page shows LEVEL-2 PROVIDER NOT CONNECTED). */
export const NO_ORDER_FLOW_PROVIDERS: OrderFlowProviders = Object.freeze({ depth: null, trade: null });
