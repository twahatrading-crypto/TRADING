/* ============================================================================
 * TLUXE Order Flow Pro - normalized model (independent engine; shares no state with any other engine).
 *
 * Source of every value: the local Order Flow Pro backend (IBKR TWS API, read-only), the TLUXE gateway's existing
 * read-only market-data endpoints (GatewaySource: Databento CME trades + IBKR price-level depth), or, in the dev
 * harness / unit tests only, a DEMO fixture (`SourceInfo.demo = true`, never shown as LIVE).
 *
 * Two different things are kept apart everywhere:
 *   - RESTING liquidity = displayed size in the IBKR price-level book (MBP, limited rows, not full book, not MBO);
 *   - EXECUTED volume   = trade prints (IBKR tick-by-tick "AllLast" / "Last").
 * IBKR prints carry NO exchange aggressor flag: there a side is only ever INFERRED by the quote rule against the
 * prevailing IBKR bid / ask and labelled so. Databento CME trades carry the EXCHANGE-reported aggressor side
 * (method 'EXCHANGE', never inferred). Anything ambiguous or unreported stays UNKNOWN.
 * ========================================================================== */

export type OfpRoot = 'GC' | 'SI';

export type OfpTf = '1m' | '5m' | '15m' | '1h';

/** Feed state as reported by the backend, never upgraded by the browser. */
export type FeedState =
  | 'DISABLED' // connection to IB Gateway is switched off in the backend config (phase-1 default)
  | 'BACKEND_OFFLINE' // the local backend itself is not reachable
  | 'GATEWAY_OFFLINE' // backend up, IB Gateway API socket not reachable
  | 'AUTH_REQUIRED' // IB Gateway running but its API refuses connections (login screen)
  | 'CONNECTING'
  | 'LIVE' // real-time (market data type 1) with events arriving
  | 'FROZEN' // market data type 2
  | 'DELAYED' // market data type 3
  | 'DELAYED_FROZEN' // market data type 4
  | 'STALE' // subscribed but nothing received for the stale window
  | 'NOT_ENTITLED'
  | 'COMPETING_SESSION' // IBKR 10197: the same IBKR username holds market data elsewhere - requests stopped
  | 'IDENTITY_UNCONFIRMED' // backend config lacks the separate-IBKR-username acknowledgement - no connection attempted
  | 'ACCOUNT_UNVERIFIED' // IB Gateway did not report its account(s) in time - paper/live unverifiable, disconnected
  | 'MODE_MISMATCH' // declared paper/live does not match the account IB Gateway is logged in to - disconnected
  | 'DEMO' // DEMO fixture - never LIVE
  // TLUXE gateway source (website): the gateway or its upstream is not reachable / reports no usable data /
  // trades and depth refer to different contracts (never merged).
  | 'DISCONNECTED'
  | 'UNAVAILABLE'
  | 'CONTRACT_MISMATCH';

/** IBKR reqMarketDataType values, reported verbatim (1 real-time, 2 frozen, 3 delayed, 4 delayed-frozen). */
export type MarketDataType = 'REALTIME' | 'FROZEN' | 'DELAYED' | 'DELAYED_FROZEN';

export type CapabilityState = 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_ENTITLED' | 'UNVERIFIED' | 'DEMO';

export interface ContractInfo {
  root: OfpRoot;
  /** IBKR local symbol, e.g. GCZ6. */
  localSymbol: string;
  conId: number | null;
  /** YYYYMMDD last trade date as IBKR reports it. */
  expiry: string;
  exchange: 'COMEX';
  tradingClass: string;
  multiplier: string;
  /** True only when the backend resolved it through reqContractDetails (never for DEMO). */
  verified: boolean;
}

export interface Capabilities {
  depth: CapabilityState;
  /** Tick-by-tick trade prints. */
  trades: CapabilityState;
  /** Side classification of prints (always INFERRED by quote rule when available). */
  aggressor: CapabilityState;
  historicalBars: CapabilityState;
}

export interface SourceStatus {
  root: OfpRoot;
  feed: FeedState;
  marketDataType: MarketDataType | null;
  contract: ContractInfo | null;
  capabilities: Capabilities;
  /** Rows actually granted for the depth subscription (IBKR price-level depth, not full book). */
  depthRows: number;
  /** Receive time of the newest event (ms, backend clock). */
  lastEventMs: number | null;
  /** Backend receive -> browser apply latency estimate (ms). */
  latencyMs: number | null;
  /** Human-readable reasons / limitations, shown in diagnostics verbatim. */
  diagnostics: string[];
  /** Contracts the backend VERIFIED through reqContractDetails (standard trading class only, e.g. never SIL). */
  availableContracts?: ContractInfo[];
  /** Backend process session: changes on every backend start (the browser then re-syncs from a fresh snapshot). */
  sessionId?: string;
  /** Separate health signals reported by the backend (never collapsed into one flag). */
  health?: FeedHealth;
  classification?: ClassificationStats;
  /** Gateway source only: provenance + independent freshness of every upstream stream (never collapsed). */
  provenance?: GatewayProvenance;
}

/** Freshness / state of ONE upstream stream as observed through the TLUXE gateway. */
export type StreamLiveness = 'LIVE' | 'QUIET' | 'STALE' | 'DISCONNECTED' | 'UNAVAILABLE' | 'CONTRACT_MISMATCH';

export interface StreamProvenance {
  state: StreamLiveness;
  /** e.g. "Databento GLBX.MDP3 trades (CME)" / "Interactive Brokers price-level depth". */
  provider: string;
  /** What the event timestamps mean: exchange event time, the VPS depth service's update time, or bar open time. */
  timeBasis: 'EXCHANGE_EVENT' | 'VPS_DEPTH_UPDATE' | 'BAR_OPEN';
  /** Contract as reported by THIS stream (e.g. GCZ6). */
  contract: string | null;
  /** Newest event time (ms, `timeBasis`) and its age at the last successful poll. */
  lastMs: number | null;
  ageMs: number | null;
  /** Last successful request to the gateway for this stream (browser clock). */
  lastPollMs: number | null;
  detail: string | null;
}

export interface GatewayProvenance {
  trades: StreamProvenance;
  depth: StreamProvenance;
  bars: StreamProvenance;
  /** Aggressor side source of the trades: exchange-reported (Databento CME), or none. Never inferred here. */
  aggressor: 'EXCHANGE' | 'NONE';
  /** Data-quality counters since subscription (records rejected by schema / contract checks are never applied). */
  quality: {
    tradesAccepted: number;
    tradesDuplicate: number;
    tradesRejected: number;
    tradesOutOfOrder: number;
    unknownSide: number;
    depthChanges: number;
    depthResyncs: number;
    depthSeqGaps: number;
    depthRejected: number;
    gaps: number;
    requestErrors: number;
    rateLimited: number;
  };
  /** Requests issued to the gateway since subscription (all GET). */
  requests: number;
  /** Which part of the current session's prints is loaded (session statistics are PARTIAL until complete). */
  history?: SessionHistory;
}

export interface SessionHistory {
  /** ETH session start (ms). */
  sessionStart: number;
  /** Prints are loaded from here (ms). Before it: Databento OHLCV bars only (no footprint), or nothing. */
  loadedFrom: number | null;
  /** True when every print of the session that the gateway still holds is loaded. */
  complete: boolean;
  loading: boolean;
  /** Earlier prints loaded on demand so far. */
  historyLoaded: number;
  /** Earlier prints are merged from sessionStart up to this time; (historyThrough, loadedFrom) is still missing. */
  historyThrough: number | null;
  /** Earlier session prints that are no longer available from the gateway (left its trade window): from..to. */
  unavailable: { from: number; to: number } | null;
  error: string | null;
}

/** What a replay actually contains - shown to the user, never implied. */
export interface ReplayProvenance {
  trades: { kind: 'EXACT_PRINTS'; source: string; count: number; from: number | null; to: number | null; complete: boolean; detail: string | null };
  depth: {
    kind: 'RECORDED_TIME_WEIGHTED_AGGREGATE' | 'NONE';
    source: string;
    bucketMs: number | null;
    buckets: number;
    coveredBuckets: number;
    firstRecordedMs: number | null;
    detail: string | null;
  };
  /** Exact historical order-book snapshots are not served by the gateway. */
  exactDepthSnapshots: 'NOT_AVAILABLE';
  gaps: Array<{ from: number; to: number; reason: string }>;
}

export type StreamState = 'OFF' | 'PENDING' | 'ACTIVE' | 'ERROR' | 'NOT_ENTITLED' | 'SUSPENDED';

export interface StreamFreshness {
  lastMs: number | null;
  ageMs: number | null;
  /** FRESH = a message within the classification quote age; AGED = older (not a failure by itself); NONE = never. */
  state: 'FRESH' | 'AGED' | 'NONE';
}

export interface FeedHealth {
  /** 1. Gateway connection (API session, heartbeat, account verification, IBKR server link). */
  connection: string;
  accountVerified: boolean;
  heartbeatAgeMs: number | null;
  ibkrLink: string;
  /** 2. quote freshness · 3. depth freshness · 4. trade activity - independent of each other and of the connection. */
  quotes?: StreamFreshness;
  depth?: StreamFreshness;
  trades?: StreamFreshness & { activity: 'ACTIVE' | 'QUIET' | null };
  /** 7. recording gaps: explicit loss of continuity only (never a quiet market). */
  gaps?: { count: number; last: { from: number; to: number; reason: string } | null; recorderDropped: number };
  /** 5. subscription health per stream. */
  streams: Record<'mkt' | 'depth' | 'trades' | 'hist', StreamState>;
  /** ACTIVE / QUIET (connected + subscribed, no change for a while - never a gap by itself); null = not subscribed. */
  activity: 'ACTIVE' | 'QUIET' | null;
  quietForMs: number | null;
  /** CME Globex weekly schedule only (holidays / halts unknown) - never an exchange 'market open' status. */
  schedule: 'IN_SCHEDULE' | 'DAILY_BREAK' | 'WEEKEND';
  depthPacing: { backoffS: number; pending: string | null; suspended: string | null; retriesInWindow: number };
}

export interface ClassificationStats {
  method: 'QUOTE_RULE' | 'EXCHANGE';
  inferred?: boolean;
  touchSource: 'depth' | 'quote' | null;
  maxQuoteAgeMs?: number;
  prevTouchWindowMs: number;
  reasons: Record<string, number>;
  volume: { BUY: number; SELL: number; UNKNOWN: number };
  unknownVolumeByReason?: Record<string, number>;
  unknownVolumePct: number | null;
}

export type Side = 'BID' | 'ASK';
export type Aggressor = 'BUY' | 'SELL' | 'UNKNOWN';

/** How a print's side was decided. 'EXCHANGE' = aggressor side reported by the exchange (CME via Databento),
 *  never inferred and never re-classified; never used for IBKR prints. */
export type ClassificationMethod = 'QUOTE_RULE' | 'EXCHANGE' | 'NONE';

export interface QuoteEvent {
  kind: 'quote';
  t: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export interface TradeEvent {
  kind: 'trade';
  t: number;
  price: number;
  size: number;
  aggressor: Aggressor;
  method: ClassificationMethod;
  /** Why the side was (not) inferred: AT_ASK, AT_BID, PREV_ASK, PREV_BID (directional) or INSIDE_SPREAD, LOCKED_CROSSED,
   *  NO_QUOTE, QUOTE_STALE, QUOTE_UNHEALTHY, QUOTE_DELAYED_DATA, DATA_TYPE_UNCONFIRMED, QUOTE_AFTER_TRADE, TRADE_DELAYED. */
  basis?: string;
  /** True for IBKR prints (the side is an inference); false for exchange-reported sides (method 'EXCHANGE'). */
  inferred?: boolean;
  /** Receipt time (ms) when it differs from the exchange event time `t` (gateway source: Databento ts_recv). */
  tRecv?: number;
  /** Stable source identifier used for de-duplication (gateway source: contract + transport index). */
  id?: string;
  /**
   * Earlier-session print loaded on demand AFTER newer prints were applied. It is strictly older than every live-loaded
   * bar slot: it is merged into older bars (sums are order-independent) and never changes the tape or the last price.
   */
  history?: boolean;
  /** Age of the reference bid / ask (since its own stream last confirmed it) when the print was classified. */
  quoteAgeMs?: number | null;
  quoteSource?: 'depth' | 'quote' | null;
  /** Quote the classification used (null = none known -> UNKNOWN). */
  bid: number | null;
  ask: number | null;
}

/** One price level's new displayed size (0 = removed). Derived from IBKR row operations by the backend. */
export interface DepthLevelEvent {
  kind: 'depth';
  t: number;
  side: Side;
  price: number;
  size: number;
}

/** Full visible-book replacement (subscription start / reset / resync). */
export interface BookSnapshotEvent {
  kind: 'book';
  t: number;
  bids: Array<[price: number, size: number]>;
  asks: Array<[price: number, size: number]>;
}

/** Explicit gap: nothing between from..to may be trusted (disconnect, reset, sequence gap, stale). */
export interface GapEvent {
  kind: 'gap';
  from: number;
  to: number;
  reason: string;
}

export interface BarEvent {
  kind: 'bar';
  /** Open time ms. */
  t: number;
  tf: OfpTf;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type OfpEvent = QuoteEvent | TradeEvent | DepthLevelEvent | BookSnapshotEvent | GapEvent | BarEvent;

export interface OfpFrame {
  root: OfpRoot;
  /** Contiguous per-root sequence of the first event (backend-assigned). */
  seq: number;
  events: OfpEvent[];
}
