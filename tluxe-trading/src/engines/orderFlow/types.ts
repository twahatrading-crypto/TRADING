import type { InstrumentId } from '../../types/instruments';

/* ============================================================================
 * Normalized order-flow messages (vendor-neutral). Every provider adapter
 * (Rithmic, T4, CQG, Databento, …) converts its wire format into these. The
 * engines never see vendor types. Times are epoch MILLISECONDS.
 *
 * NOTHING here may be produced from MT5 / spot / CFD data: MT5 has no
 * exchange Level-2 book and no exchange aggressor side.
 * ========================================================================== */

export type BookSide = 'bid' | 'ask';
/** Aggressor side AS SUPPLIED by the exchange / provider. Never inferred. */
export type Aggressor = 'BUY' | 'SELL' | 'UNKNOWN';
export type OrderFlowStream = 'depth' | 'trade';

/**
 * Why a displayed size changed, when the provider says so.
 *  add / modify / cancel / execute — reason known (MBO / reason-coded MBP feeds)
 *  set    — new size, cause NOT supplied (plain MBP)
 *  delete — level removed, cause NOT supplied
 */
export type DepthAction = 'add' | 'modify' | 'cancel' | 'execute' | 'set' | 'delete';

interface Base {
  instrumentId: InstrumentId;
  /** Per-stream sequence number from the provider; null when the provider has none. */
  seq: number | null;
  /** Exchange timestamp (ms). */
  exchTime: number;
  /** Local receive timestamp (ms). */
  recvTime: number;
}

export interface DepthLevelIn {
  price: number;
  size: number;
  orders?: number | null;
}

/** Full book at `seq` (the last depth sequence it includes). */
export interface DepthSnapshotMsg extends Base {
  type: 'snapshot';
  bids: DepthLevelIn[];
  asks: DepthLevelIn[];
}

/** One price level's NEW displayed size (MBP semantics; MBO adapters aggregate first). */
export interface DepthUpdateMsg extends Base {
  type: 'depth';
  side: BookSide;
  price: number;
  size: number;
  action: DepthAction;
}

export interface TradeMsg extends Base {
  type: 'trade';
  price: number;
  size: number;
  aggressor: Aggressor;
  tradeId?: string | null;
}

/** Keep-alive per stream (lets the engine tell "no change" from "no data"). */
export interface HeartbeatMsg extends Base {
  type: 'heartbeat';
  stream: OrderFlowStream;
}

export type OrderFlowMsg = DepthSnapshotMsg | DepthUpdateMsg | TradeMsg | HeartbeatMsg;

/** What the connected provider can genuinely supply. Everything defaults to "no". */
export interface OrderFlowCapabilities {
  /** 'NONE' = no Level-2 at all (e.g. MT5). */
  depth: 'NONE' | 'MBP' | 'MBO';
  /** Levels per side the feed publishes (null = unknown / full book). */
  depthLevels: number | null;
  incrementalDepth: boolean;
  trades: boolean;
  /** Exchange-supplied aggressor side on trades. */
  aggressorSide: boolean;
  /** Depth updates say add / cancel / execute (not just the new size). */
  depthReasons: boolean;
  /** Per-stream sequence numbers (gap detection possible). */
  sequenced: boolean;
  /** A fresh snapshot can be requested on demand (resync). */
  snapshotOnDemand: boolean;
}

export const NO_CAPABILITIES: Readonly<OrderFlowCapabilities> = Object.freeze({
  depth: 'NONE',
  depthLevels: null,
  incrementalDepth: false,
  trades: false,
  aggressorSide: false,
  depthReasons: false,
  sequenced: false,
  snapshotOnDemand: false,
});

/** Feed status per stream (depth and trades are independent). */
export type FeedStatus = 'CONNECTING' | 'LIVE' | 'STALE' | 'RESYNCING' | 'DISCONNECTED' | 'DATA_UNAVAILABLE' | 'SEQUENCE_GAP';

/** Engine-side integrity of one stream (derived only from the messages). */
export interface StreamIntegrity {
  /** READY = consistent; AWAITING_SNAPSHOT = no valid book yet / after a gap. */
  state: 'NO_DATA' | 'READY' | 'AWAITING_SNAPSHOT' | 'SEQUENCE_GAP';
  lastSeq: number | null;
  lastExchTime: number | null;
  lastRecvTime: number | null;
  duplicates: number;
  outOfOrder: number;
  gaps: number;
  /** Updates held while waiting for the resync snapshot. */
  buffered: number;
  snapshots: number;
  lastSnapshotExchTime: number | null;
  lastGapAt: number | null;
  /** Processing latency of the last message: recvTime − exchTime (ms). */
  latencyMs: number | null;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBookView {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  totalBid: number;
  totalAsk: number;
  /** False while the book is not trustworthy (no snapshot / gap / resync). */
  valid: boolean;
  /** Best bid ≥ best ask as published (reported, never "fixed"). */
  crossed: boolean;
}

/** Executed volume at one price, aggressor-classified volume kept separate from UNKNOWN. */
export interface VolumeAtPrice {
  price: number;
  buy: number;
  sell: number;
  unknown: number;
}

export type CvdAvailability = 'FULL' | 'PARTIAL' | 'UNAVAILABLE';

export type OrderFlowEventType = 'LARGE_TRADE' | 'LIQUIDITY_HIT' | 'DEPTH_SWEEP' | 'STACKING' | 'PULLING' | 'ABSORPTION_CANDIDATE';

export interface OrderFlowEvent {
  /** Deterministic: type:side:tick:exchTime:seq */
  id: string;
  type: OrderFlowEventType;
  time: number;
  price: number;
  size: number;
  side: Aggressor | BookSide;
  /** Measured evidence only — never inferred intent. */
  evidence: Record<string, number | string | null>;
  /** Human sentence built from the evidence. */
  detail: string;
}
