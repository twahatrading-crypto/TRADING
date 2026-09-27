/* Wire types of the local TLUXE Databento bridge (bridge/databento). Prices are decimal (Databento fixed-point
 * 1e-9 converted by the bridge); times are nanoseconds (…Ns) or milliseconds (…Ms). No credentials ever. */

export type DbRoot = 'GC' | 'SI';
export const DB_ROOTS: readonly DbRoot[] = ['GC', 'SI'];
export type DbStatus = 'CONNECTING' | 'SYNCING' | 'LIVE' | 'DEGRADED' | 'STALE' | 'RECONNECTING' | 'UNAVAILABLE' | 'AUTH_ERROR';
export type DbFreshness = 'LIVE' | 'DELAYED' | 'STALE' | 'OFFLINE' | 'UNAVAILABLE';
export type DbBookState = 'NO_DATA' | 'SYNCING' | 'VALID' | 'DEGRADED' | 'INVALID';

export interface DbInstrumentStatus {
  root: DbRoot;
  provider: 'Databento';
  dataset: string;
  subscribed: string;
  stypeIn: string;
  contract: string | null;
  instrumentId: number | null;
  status: DbStatus;
  freshness: DbFreshness;
  reasons: string[];
  book: { state: DbBookState; epoch: number; reason: string | null; orders: number; bidLevels: number; askLevels: number; counts: Record<string, number>; best: [number | null, number | null] };
  tape: { replaying: boolean; lagMs: number | null; contract: string | null; counts: Record<string, number>; volume: Record<string, number>; retained: number; lastIndex: number };
  candles: { bars: number; lastClosed: number | null };
  lastEventNs: number | null;
  lastRecvNs: number | null;
  lastEventAgeMs: number | null;
  counts: Record<string, number>;
  roll: { from: string; to: string; fromId: number; toId: number; atMs: number } | null;
}

export interface DbSession {
  state: string;
  connectedAtMs: number | null;
  reconnects: number;
  resyncs: number;
  lastMessageMs: number | null;
  lastError: { code: string; message: string; atMs: number } | null;
  reconnectStorm: boolean;
}

export interface DbHealth {
  provider: 'Databento';
  dataset: string;
  contractMode: 'auto' | 'manual';
  sessions: { book: DbSession; tape: DbSession };
  instruments: Record<DbRoot, DbInstrumentStatus>;
  rolls: { root: DbRoot; from: string; to: string; fromId: number; toId: number; tsEventNs: number; atMs: number }[];
  metrics: Record<string, number | null>;
  retention: { maxTrades: number; maxFrames: number; publishMs: number; replayHours: number };
  timeMs: number;
  bridge: { version: string; startedAtMs: number; heartbeatAtMs: number };
}

export interface DbTrade {
  /** Bridge transport index (continuity of the bridge -> browser stream). NOT an exchange sequence number. */
  i: number;
  tsEventNs: number;
  tsRecvNs: number;
  price: number;
  size: number;
  side: 'A' | 'B' | 'N';
  aggressor: 'BUY' | 'SELL' | 'UNKNOWN';
  /** Databento `sequence` as supplied (venue channel sequence; not contiguous per instrument). */
  sequence: number;
  key: string;
  contract: string;
}

export interface DbBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface DbFrameInstrument {
  contract: string | null;
  instrumentId: number | null;
  status: DbInstrumentStatus;
  snapshot?: { epoch: number; bids: [number, number, number][]; asks: [number, number, number][] };
  levels?: ['B' | 'A', number, number][];
  trades?: DbTrade[];
  bars?: DbBar[];
  forming?: DbBar;
}
export interface DbFrame {
  cursor: number;
  timeMs: number;
  instruments: Partial<Record<DbRoot, DbFrameInstrument>>;
}
export interface DbFeedResponse {
  cursor: number;
  reset: boolean;
  frames: DbFrame[];
}
export interface DbBookResponse {
  root: DbRoot;
  contract: string | null;
  instrumentId: number | null;
  cursor: number;
  state: DbBookState;
  epoch: number;
  book: { bids: [number, number, number][]; asks: [number, number, number][] } | null;
  lastEventNs: number | null;
  lastRecvNs: number | null;
}
export interface DbTradesResponse {
  root: DbRoot;
  contract: string | null;
  instrumentId?: number;
  trades: DbTrade[];
  complete: boolean;
  lastIndex: number;
  cursor: number;
}
export interface DbCandlesResponse {
  root: DbRoot;
  contract: string | null;
  instrumentId: number | null;
  timeframe: string;
  bars: DbBar[];
  source: 'databento';
  schema: 'ohlcv-1m';
  cursor: number;
}

export const nsToMs = (ns: number) => Math.floor(ns / 1_000_000);
