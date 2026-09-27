/* Wire types of the local TLUXE news backend (bridge/news). Times are epoch ms (UTC). No credentials ever. */

export type BridgeFeedKind = 'calendar' | 'macro' | 'breaking';
export type BridgeFeedStatus = 'NOT_CONFIGURED' | 'DISABLED' | 'CONNECTING' | 'LIVE' | 'DELAYED' | 'STALE' | 'ERROR';

export interface BridgeFeedView {
  feed: BridgeFeedKind;
  provider: string | null;
  providerName: string | null;
  configured: boolean;
  enabled: boolean;
  status: BridgeFeedStatus;
  detail: string | null;
  latency: 'REALTIME' | 'DELAYED' | 'UNKNOWN';
  delaySec: number | null;
  staleAfterMs: number;
  lastSuccessMs: number | null;
  lastDataMs: number | null;
  lastAttemptMs: number | null;
  error: { code: string; message: string; atMs: number } | null;
  streaming?: { state: string; detail: string | null; lastMessageMs: number | null };
  events?: number;
  items?: number;
}

export interface BridgeHealth {
  service: 'tluxe-news';
  version: string;
  startedAtMs: number;
  timeMs: number;
  feeds: Record<BridgeFeedKind, BridgeFeedView>;
  demoKey: boolean;
}

/** Normalized Trading Economics calendar event (backend te_normalize.normalize_calendar). */
export interface BridgeCalendarEvent {
  id: string;
  dedupKey: string;
  provider: string;
  providerName: string;
  providerEventId: string;
  event: string;
  category: string | null;
  country: string | null;
  currency: string | null;
  reference: string | null;
  scheduledAt: number;
  importance: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  importanceRaw: number | null;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  revised: string | null;
  teForecast: string | null;
  unit: string | null;
  source: string | null;
  sourceUrl: string | null;
  url: string | null;
  providerUpdatedAt: number | null;
  releaseStatus: 'SCHEDULED' | 'RELEASED';
  receivedAt: number;
  firstReceivedAt: number;
  lastChangedAt: number;
  revision: number;
  seq: number;
}

export interface BridgeHeadline {
  id: string;
  dedupKey: string;
  provider: string;
  providerName: string;
  providerItemId: string;
  feed: 'macro' | 'breaking';
  headline: string;
  description: string | null;
  source: string | null;
  sourceUrl: string | null;
  publishedAt: number;
  receivedAt: number;
  category: string | null;
  country: string | null;
  symbol: string | null;
  importance: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  /** Only when the provider genuinely supplies it (Trading Economics does not). */
  providerSentiment: string | null;
  revision: number;
  seq: number;
}

export interface CalendarPage {
  seq: number;
  reset: boolean;
  events: BridgeCalendarEvent[];
}
export interface HeadlinePage {
  seq: number;
  reset: boolean;
  headlines: BridgeHeadline[];
}
