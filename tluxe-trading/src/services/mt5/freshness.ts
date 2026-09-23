import type { ConnectionState, FeedStatusCode } from '../../types/market';
import type { TerminalState } from './protocol';

export interface FreshnessInput {
  now: number;
  /** Local receipt time of the last successful bridge health response (ms). Null = never. */
  heartbeatAt: number | null;
  /** A health request has completed (success or failure) at least once. */
  attempted: boolean;
  terminalState: TerminalState | null;
  /** Instrument's regular hours say the market is open; null = unknown. */
  marketOpen: boolean | null;
  lastQuoteAt: number | null;
  /** Open time (ms) of the newest bar on the smallest polled timeframe, and that timeframe in seconds. */
  lastCandleAt: number | null;
  candleTfSec: number | null;
  /** Largest closed-bar count across loaded timeframes (null = none loaded yet). */
  maxClosedBars: number | null;
}

export interface FreshnessThresholds {
  heartbeatStaleMs: number;
  quoteStaleMs: number;
  candleStaleBars: number;
  minHistoryBars: number;
}

/**
 * Freshness rules (evaluated in order):
 *  1. never reached the bridge → MT5_CONNECTING (before first attempt) / MT5_BRIDGE_OFFLINE
 *  2. no heartbeat for heartbeatStaleMs → MT5_BRIDGE_OFFLINE
 *  3. terminal NOT_RUNNING/INITIALIZING → MT5_NOT_RUNNING; DISCONNECTED → ERROR (no broker link)
 *  4. market closed by its regular hours → MARKET_CLOSED (not "stale")
 *  5. no quote yet → MT5_CONNECTED
 *  6. last tick older than quoteStaleMs → STALE
 *  7. newest bar older than (candleStaleBars + 1) bar lengths → STALE
 *  8. fewer than minHistoryBars closed bars on every loaded timeframe → INSUFFICIENT_HISTORY
 *  9. otherwise LIVE
 */
export function freshnessCode(i: FreshnessInput, t: FreshnessThresholds): FeedStatusCode {
  if (i.heartbeatAt === null) return i.attempted ? 'MT5_BRIDGE_OFFLINE' : 'MT5_CONNECTING';
  if (i.now - i.heartbeatAt > t.heartbeatStaleMs) return 'MT5_BRIDGE_OFFLINE';
  if (i.terminalState === 'NOT_RUNNING' || i.terminalState === 'INITIALIZING' || i.terminalState === null) return 'MT5_NOT_RUNNING';
  if (i.terminalState === 'DISCONNECTED') return 'ERROR';
  if (i.marketOpen === false) return 'MARKET_CLOSED';
  if (i.lastQuoteAt === null) return 'MT5_CONNECTED';
  if (i.now - i.lastQuoteAt > t.quoteStaleMs) return 'STALE';
  if (i.lastCandleAt !== null && i.candleTfSec !== null && i.now - i.lastCandleAt > (t.candleStaleBars + 1) * i.candleTfSec * 1000) return 'STALE';
  if (i.maxClosedBars !== null && i.maxClosedBars < t.minHistoryBars) return 'INSUFFICIENT_HISTORY';
  return 'LIVE';
}

/** Coarse connection state for the market store. Only fresh data is ever LIVE. */
export function connectionOf(code: FeedStatusCode): ConnectionState {
  switch (code) {
    case 'LIVE':
    case 'INSUFFICIENT_HISTORY':
      return 'LIVE';
    case 'MT5_CONNECTING':
    case 'MT5_CONNECTED':
      return 'CONNECTING';
    case 'SYMBOL_NOT_FOUND':
    case 'AMBIGUOUS_SYMBOL':
      return 'UNAVAILABLE';
    default:
      return 'DISCONNECTED';
  }
}

export const FEED_LABEL: Record<FeedStatusCode, string> = {
  MT5_BRIDGE_OFFLINE: 'MT5 BRIDGE OFFLINE',
  MT5_NOT_RUNNING: 'MT5 NOT RUNNING',
  MT5_CONNECTING: 'MT5 CONNECTING',
  MT5_CONNECTED: 'MT5 CONNECTED',
  SYMBOL_NOT_FOUND: 'SYMBOL NOT FOUND',
  AMBIGUOUS_SYMBOL: 'AMBIGUOUS SYMBOL',
  MARKET_CLOSED: 'MARKET CLOSED',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT HISTORY',
  LIVE: 'MT5 · LIVE',
  STALE: 'STALE',
  ERROR: 'ERROR',
};
