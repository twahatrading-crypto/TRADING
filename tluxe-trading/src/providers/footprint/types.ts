import type { FootprintCapabilities, FootprintMsg, FPFeedStatus } from '../../engines/volumeFootprint/types';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';

/* ============================================================================
 * Volume Footprint provider boundary. Vendor adapters (Rithmic R|Protocol, T4, CQG, …) implement this and
 * convert their exchange time & sales into `engines/volumeFootprint/types` messages. The engine, service
 * and UI depend ONLY on this file.
 *
 * Adapter contract:
 *  • declare capabilities honestly — especially the aggressor source:
 *      EXCHANGE   the exchange / provider supplies the aggressor side (e.g. CME MDP 3.0 trade aggressor)
 *      CLASSIFIED the adapter classifies with a documented method, named in `classificationMethod`
 *      NONE       no aggressor side → every trade is sent as UNKNOWN (never forced to BUY / SELL)
 *  • every trade carries the actual exchange CONTRACT (e.g. "GCZ6"), per-feed sequence number and trade id
 *    when the vendor has them, the exchange timestamp and the local receive timestamp (ms);
 *  • heartbeats with the exchange clock when the market is quiet;
 *  • report status honestly (CONNECTING / LIVE / DISCONNECTED / RECONNECTED / DATA_UNAVAILABLE);
 *  • never fill missing trades, never derive trades from candles, never use MT5 / spot / CFD data.
 * ========================================================================== */

export interface FootprintProviderInfo {
  id: string;
  name: string;
  /** TEST providers are only allowed in tests and the dev harness. */
  test?: boolean;
}

export interface FootprintSink {
  message(m: FootprintMsg): void;
  status(instrumentId: InstrumentId, status: FPFeedStatus, detail?: string | null): void;
  capabilities(instrumentId: InstrumentId, caps: FootprintCapabilities): void;
}

export interface FootprintTradeProvider {
  readonly info: FootprintProviderInfo;
  connect(sink: FootprintSink): void;
  disconnect(): void;
  subscribe(instrument: InstrumentDefinition): void;
  unsubscribe(instrumentId: InstrumentId): void;
}
