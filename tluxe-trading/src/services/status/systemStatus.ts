import type { EngineConfig } from '../../config/engines';
import type { ConnectionState } from '../../types/market';
import type { ProviderStatus } from '../../types/providers';
import type { StatusTone, StatusValue, SystemStatusItem } from '../../types/status';

export interface FeedInput {
  connection: ConnectionState;
  error: string | null;
  /** Whether any source of this kind is mapped for the instrument. */
  supported: boolean;
  /** Provider-specific detail (e.g. "MT5 · LIVE · GOLD.a"); overrides the generic text. */
  detail?: string;
}

export interface StatusInputs {
  browserOnline: boolean;
  /** Symbol of the active instrument, e.g. "XAUUSD". */
  instrument: string;
  price: FeedInput;
  depth: FeedInput;
  ai: ProviderStatus;
  database: ProviderStatus;
  news: ProviderStatus;
  calendar: ProviderStatus;
  engines: EngineConfig[];
  /** Runtime state of implemented engines: 'running' = analysing real data for the active instrument. */
  engineRuntime?: Record<string, 'running' | 'waiting'>;
}

const FEED_DETAIL: Record<ConnectionState, string> = {
  LIVE: 'Live',
  DELAYED: 'Delayed',
  CONNECTING: 'Connecting…',
  DISCONNECTED: 'Disconnected',
  UNAVAILABLE: 'No provider',
};

export function providerStatusValue(status: ProviderStatus): StatusValue {
  switch (status) {
    case 'CONNECTED':
      return 'CONNECTED';
    case 'ERROR':
      return 'ERROR';
    default:
      return 'NOT CONNECTED';
  }
}

export function feedStatusValue(feed: FeedInput): StatusValue {
  if (!feed.supported) return 'UNSUPPORTED';
  if (feed.error) return 'ERROR';
  return feed.connection === 'LIVE' || feed.connection === 'DELAYED' ? 'CONNECTED' : 'NOT CONNECTED';
}


export function buildSystemStatus(i: StatusInputs): SystemStatusItem[] {
  const provider = (id: string, label: string, s: ProviderStatus): SystemStatusItem => ({
    id,
    label,
    value: providerStatusValue(s),
    detail: s === 'CONNECTING' ? 'Connecting…' : undefined,
  });
  const feed = (id: string, label: string, f: FeedInput, unsupported: string): SystemStatusItem => ({
    id,
    label: `${label} · ${i.instrument}`,
    value: feedStatusValue(f),
    detail: !f.supported ? unsupported : (f.detail ?? f.error ?? FEED_DETAIL[f.connection]),
  });
  return [
    { id: 'app', label: 'Application', value: i.browserOnline ? 'ONLINE' : 'OFFLINE', detail: i.browserOnline ? undefined : 'Browser offline' },
    feed('price', 'Price Data', i.price, 'No price source mapped for this instrument'),
    feed('depth', 'Depth Data', i.depth, 'No depth / order-book source exists for this instrument'),
    provider('ai', 'AI', i.ai),
    provider('database', 'Database', i.database),
    provider('news', 'News', i.news),
    provider('calendar', 'Economic Calendar', i.calendar),
    ...i.engines.map<SystemStatusItem>((e) => {
      const id = `engine-${e.id}`;
      if (!e.enabled) return { id, label: e.label, value: 'DISABLED' };
      // An enabled engine with no implementation can never report ONLINE.
      if (!e.implemented) return { id, label: e.label, value: 'ERROR', detail: 'Not implemented' };
      const running = i.engineRuntime?.[e.id] === 'running';
      return {
        id,
        label: e.label,
        value: running ? 'ONLINE' : 'NOT CONNECTED',
        detail: running ? `Analysing ${i.instrument}` : `Waiting for ${i.instrument} market data`,
      };
    }),
  ];
}

export const STATUS_TONE: Record<StatusValue, StatusTone> = {
  ONLINE: 'ok',
  CONNECTED: 'ok',
  OFFLINE: 'bad',
  ERROR: 'bad',
  'NOT CONNECTED': 'warn',
  DISABLED: 'off',
  UNSUPPORTED: 'off',
};
