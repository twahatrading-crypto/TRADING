import type { HLEFeed } from '../../engines/highLowEngine/decision';
import type { ConnectionState, FeedStatusCode } from '../../types/market';

/**
 * Truthful feed state for the High / Low Engine gate. LIVE only when the provider reports fresh
 * data; a delayed / stale / closed feed never counts as live, and an unreachable bridge or a
 * terminal that is not connected to its broker is DISCONNECTED (never reported as LIVE).
 */
export function hleFeedOf(connection: ConnectionState, feedCode: FeedStatusCode | null | undefined): Exclude<HLEFeed, 'REPLAY'> {
  if (feedCode) {
    if (feedCode === 'LIVE' || feedCode === 'INSUFFICIENT_HISTORY') return connection === 'LIVE' ? 'LIVE' : 'DISCONNECTED';
    if (feedCode === 'STALE' || feedCode === 'MARKET_CLOSED') return 'STALE';
    return 'DISCONNECTED';
  }
  if (connection === 'LIVE') return 'LIVE';
  if (connection === 'DELAYED') return 'STALE';
  return 'DISCONNECTED';
}
