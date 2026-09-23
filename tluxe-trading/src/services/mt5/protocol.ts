/** Wire types of the TLUXE MT5 bridge (bridge/mt5/tluxe_mt5_bridge). All UTC times are epoch ms unless noted. */
import type { Timeframe } from '../../types/market';

export type TerminalState = 'INITIALIZING' | 'CONNECTED' | 'NOT_RUNNING' | 'DISCONNECTED';

export interface BridgeHealth {
  bridge: { version: string; startedAtMs: number; heartbeatAtMs: number };
  terminal: { state: TerminalState; build?: number; company?: string; name?: string; connected?: boolean; tradeAllowed?: boolean };
  account: { server: string; company: string; loginMasked: string; tradeMode: 'demo' | 'real' | 'contest' | 'unknown'; currency: string } | null;
  time: { basis: 'iana' | 'detected' | 'unresolved'; timezone: string | null; offsetSec: number | null; detectedAtMs: number | null };
  error: { code: string; message: string } | null;
}

export interface BridgeSymbol {
  name: string;
  description: string;
  path: string;
  digits: number;
  point: number;
  tickSize: number;
  contractSize: number;
  currencyBase: string;
  currencyProfit: string;
  tradeMode: number;
  visible: boolean;
  spreadFloat: boolean;
}

export interface BridgeQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  spreadPoints: number | null;
  sourceTimeMs: number;
  timeUtcMs: number | null;
  timeBasis: string;
  digits: number;
}

/** One bar. t = UTC open time (s), st = MT5 server-time epoch (s). rv null = no real volume. */
export interface BridgeBar {
  t: number;
  st: number;
  o: number;
  h: number;
  l: number;
  c: number;
  tv: number;
  rv: number | null;
  sp: number;
  closed: boolean;
}

export interface BridgeRates {
  symbol: string;
  timeframe: Timeframe;
  timeBasis: BridgeHealth['time'];
  requested: number;
  returned: number;
  historyLimited: boolean;
  realVolumeAvailable: boolean;
  bars: BridgeBar[];
}
