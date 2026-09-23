import type { EngineConfig } from '../../config/engines';
import type { ConnectionState } from '../../types/market';
import type { ProviderStatus } from '../../types/providers';
import type { StatusTone, StatusValue, SystemStatusItem } from '../../types/status';

export interface StatusInputs {
  browserOnline: boolean;
  market: { connection: ConnectionState; error: string | null };
  ai: ProviderStatus;
  database: ProviderStatus;
  news: ProviderStatus;
  calendar: ProviderStatus;
  engines: EngineConfig[];
}

const MARKET_DETAIL: Record<ConnectionState, string> = {
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

export function marketStatusValue(connection: ConnectionState, error: string | null): StatusValue {
  if (error) return 'ERROR';
  return connection === 'LIVE' || connection === 'DELAYED' ? 'CONNECTED' : 'NOT CONNECTED';
}

export function buildSystemStatus(i: StatusInputs): SystemStatusItem[] {
  const provider = (id: string, label: string, s: ProviderStatus): SystemStatusItem => ({
    id,
    label,
    value: providerStatusValue(s),
    detail: s === 'CONNECTING' ? 'Connecting…' : undefined,
  });
  return [
    { id: 'app', label: 'Application', value: i.browserOnline ? 'ONLINE' : 'OFFLINE', detail: i.browserOnline ? undefined : 'Browser offline' },
    {
      id: 'market',
      label: 'Market Data',
      value: marketStatusValue(i.market.connection, i.market.error),
      detail: i.market.error ?? MARKET_DETAIL[i.market.connection],
    },
    provider('ai', 'AI', i.ai),
    provider('database', 'Database', i.database),
    provider('news', 'News', i.news),
    provider('calendar', 'Economic Calendar', i.calendar),
    ...i.engines.map<SystemStatusItem>((e) => ({
      id: `engine-${e.id}`,
      label: e.label,
      // Enabled engines have no implementation in Phase 1, so they can never report ONLINE.
      value: e.enabled ? 'ERROR' : 'DISABLED',
      detail: e.enabled ? 'Not implemented' : undefined,
    })),
  ];
}

export const STATUS_TONE: Record<StatusValue, StatusTone> = {
  ONLINE: 'ok',
  CONNECTED: 'ok',
  OFFLINE: 'bad',
  ERROR: 'bad',
  'NOT CONNECTED': 'warn',
  DISABLED: 'off',
};
