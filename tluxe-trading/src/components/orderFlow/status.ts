import type { FeedStatus, OrderFlowEventType } from '../../engines/orderFlow/types';

export const STATUS_TONE: Record<FeedStatus, 'ok' | 'warn' | 'bad' | 'muted'> = {
  LIVE: 'ok',
  CONNECTING: 'warn',
  STALE: 'warn',
  RESYNCING: 'warn',
  SEQUENCE_GAP: 'bad',
  DISCONNECTED: 'bad',
  DATA_UNAVAILABLE: 'muted',
};
export const statusText = (s: FeedStatus) => s.replace(/_/g, ' ');

/** What each order-flow detector measures: executed PRINTS only, or a genuine displayed BOOK (Level-2 depth). */
export const EV_BASIS: Record<OrderFlowEventType, 'PRINTS' | 'BOOK'> = { LARGE_TRADE: 'PRINTS', DEPTH_SWEEP: 'PRINTS', LIQUIDITY_HIT: 'BOOK', STACKING: 'BOOK', PULLING: 'BOOK', ABSORPTION_CANDIDATE: 'BOOK' };
