import type { FeedStatus } from '../../engines/orderFlow/types';

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
