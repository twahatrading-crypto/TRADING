import type { InstrumentId } from '../../types/instruments';

/* ============================================================================
 * VOLUME FOOTPRINT — normalized, vendor-neutral EXECUTED-TRADE messages. Provider adapters
 * (Rithmic, T4, CQG, …) convert their wire format into these. Times are epoch MILLISECONDS.
 *
 * Nothing here may be produced from MT5 / spot / CFD data or from OHLC candles: a footprint needs
 * individual exchange trades and an aggressor side. The engine NEVER classifies trades itself.
 * ========================================================================== */

/** Where the aggressor side of the feed comes from (declared by the provider, never guessed). */
export type AggressorSource = 'EXCHANGE' | 'CLASSIFIED' | 'NONE';
export type Aggressor = 'BUY' | 'SELL' | 'UNKNOWN';

export interface FootprintCapabilities {
  /** Individual exchange trades (time & sales). */
  trades: boolean;
  /**
   * EXCHANGE   — aggressor side supplied by the exchange / provider (e.g. CME MDP 3.0 aggressor flag)
   * CLASSIFIED — the PROVIDER classifies with a documented method (named in `classificationMethod`)
   * NONE       — no aggressor side: every trade stays UNKNOWN
   */
  aggressor: AggressorSource;
  classificationMethod: string | null;
  /** Per-trade sequence numbers (gap detection possible). */
  sequenced: boolean;
  /** Unique trade ids (duplicate detection by id). */
  tradeIds: boolean;
  /** Exchange timestamps on trades (else only receive time). */
  exchangeTimestamps: boolean;
}
export const NO_FOOTPRINT_CAPS: Readonly<FootprintCapabilities> = Object.freeze({ trades: false, aggressor: 'NONE', classificationMethod: null, sequenced: false, tradeIds: false, exchangeTimestamps: false });

interface Base {
  instrumentId: InstrumentId;
  /** Local receive time (ms) — the engine's knowledge clock (replay to T = messages received by T). */
  recvTime: number;
}
export interface FPTradeMsg extends Base {
  type: 'trade';
  /** Exchange contract, e.g. "GCZ6". Different contracts are never combined. */
  contract: string;
  seq: number | null;
  tradeId: string | null;
  /** Exchange time (ms). */
  exchTime: number;
  price: number;
  size: number;
  aggressor: Aggressor;
}
/** Keep-alive with the exchange clock: lets candles close when the market is quiet. */
export interface FPHeartbeatMsg extends Base {
  type: 'heartbeat';
  exchTime: number;
}
export type FPFeedStatus = 'CONNECTING' | 'LIVE' | 'DISCONNECTED' | 'RECONNECTED' | 'DATA_UNAVAILABLE';
export interface FPStatusMsg extends Base {
  type: 'status';
  status: FPFeedStatus;
  detail: string | null;
}
export interface FPCapsMsg extends Base {
  type: 'caps';
  caps: FootprintCapabilities;
}
export type FootprintMsg = FPTradeMsg | FPHeartbeatMsg | FPStatusMsg | FPCapsMsg;

/* ------------------------------ engine output ------------------------------ */

export type FPTimeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1';

export interface FPRow {
  /** Row lower edge (price aggregation applied). */
  price: number;
  bid: number;
  ask: number;
  unknown: number;
  total: number;
  /** ask − bid (classified volume only). */
  delta: number;
  buyImb: boolean;
  sellImb: boolean;
  /** Ratio that produced the imbalance (null = the compared side was 0). */
  buyRatio: number | null;
  sellRatio: number | null;
}

export interface FPImbalance {
  id: string;
  candleId: string;
  tf: FPTimeframe;
  /** Candle close time (s). */
  time: number;
  price: number;
  side: 'BUY' | 'SELL';
  /** The two numbers compared (ask of this row vs bid of the compared row, or the reverse). */
  ask: number;
  bid: number;
  comparedPrice: number;
  ratio: number | null;
  stacked: boolean;
  state: 'ACTIVE' | 'TESTED' | 'CONSUMED';
  testedAt: number | null;
  consumedAt: number | null;
}

export interface FPStack {
  id: string;
  candleId: string;
  tf: FPTimeframe;
  time: number;
  side: 'BUY' | 'SELL';
  low: number;
  high: number;
  levels: number;
  ratios: (number | null)[];
  state: 'ACTIVE' | 'TESTED' | 'CONSUMED';
  testedAt: number | null;
  consumedAt: number | null;
}

export type FPEventType =
  | 'STACKED BUY IMBALANCE'
  | 'STACKED SELL IMBALANCE'
  | 'ABSORPTION CANDIDATE'
  | 'EXHAUSTION CANDIDATE'
  | 'DELTA DIVERGENCE CANDIDATE'
  | 'UNFINISHED AUCTION CANDIDATE'
  | 'LARGE TRADE'
  | 'SEQUENCE GAP'
  | 'LATE TRADE EXCLUDED'
  | 'FEED DISCONNECTED'
  | 'FEED RECONNECTED'
  | 'CONTRACT CHANGED';

export interface FPEvent {
  /** Deterministic id. */
  id: string;
  type: FPEventType;
  tf: FPTimeframe | null;
  /** Event time (s): candle close for candle events, exchange time for trade / integrity events. */
  time: number;
  price: number | null;
  volume: number | null;
  delta: number | null;
  candleId: string | null;
  /** Measured evidence only — never inferred intent. */
  evidence: string;
}

export interface FPCandle {
  id: string;
  tf: FPTimeframe;
  contract: string;
  /** Open time (s). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
  unknown: number;
  delta: number;
  /** delta / (bid + ask) × 100; null when nothing is classified. */
  deltaPct: number | null;
  poc: number;
  pocVolume: number;
  /** Extremes of the intra-candle running delta (trade order). */
  maxDelta: number;
  minDelta: number;
  trades: number;
  largeTrades: number;
  rows: FPRow[];
  buyImbalances: number;
  sellImbalances: number;
  stackedBuy: number;
  stackedSell: number;
  absorption: number;
  exhaustion: number;
  closed: boolean;
  /** Integrity flags of this candle (never repaired with invented trades). */
  gap: boolean;
  interrupted: boolean;
  late: number;
}

export type IntegrityState = 'GOOD' | 'DEGRADED' | 'UNAVAILABLE';
export interface FPIntegrity {
  state: IntegrityState;
  reasons: string[];
  accepted: number;
  duplicates: number;
  outOfOrder: number;
  late: number;
  gaps: number;
  missing: number;
  disconnects: number;
  reconnects: number;
  contractChanges: number;
  lastSeq: number | null;
  lastExchTime: number | null;
  lastRecvTime: number | null;
  /** recvTime − exchTime of the last trade (ms). */
  latencyMs: number | null;
  feed: FPFeedStatus;
}

export type FootprintStatus = 'ACTIVE' | 'UNCLASSIFIED' | 'UNAVAILABLE';

export interface FPTfSummary {
  tf: FPTimeframe;
  candles: number;
  current: FPCandle | null;
  lastClosed: FPCandle | null;
}

export interface FootprintSnapshot {
  instrumentId: InstrumentId;
  contract: string | null;
  previousContracts: string[];
  caps: FootprintCapabilities;
  status: FootprintStatus;
  /** Human reason when status ≠ ACTIVE (which capability is missing). */
  statusReason: string | null;
  knowledgeTime: number | null;
  lastPrice: number | null;
  integrity: FPIntegrity;
  cvd: number;
  /** FULL = every trade classified; PARTIAL = some UNKNOWN volume excluded; UNAVAILABLE = none classified. */
  cvdAvailability: 'FULL' | 'PARTIAL' | 'UNAVAILABLE';
  sessionStart: number | null;
  sessionDelta: number;
  unknownVolume: number;
  settingsKey: string;
  mtf: FPTfSummary[];
}
