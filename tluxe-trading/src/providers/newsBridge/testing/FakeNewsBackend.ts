/**
 * TEST DATA ONLY — an in-memory stand-in for the LOCAL TLUXE news backend (bridge/news) used by automated tests.
 * Records are shaped like the backend's normalized Trading Economics output; values are fabricated for tests only.
 * Never imported by production code; there is no setting that enables it.
 */
import type { BridgeCalendarEvent, BridgeFeedKind, BridgeFeedStatus, BridgeFeedView, BridgeHeadline, BridgeHealth } from '../protocol';

export function feedView(feed: BridgeFeedKind, status: BridgeFeedStatus, over: Partial<BridgeFeedView> = {}): BridgeFeedView {
  const configured = status !== 'NOT_CONFIGURED';
  return {
    feed,
    provider: feed === 'breaking' ? null : 'tradingeconomics',
    providerName: feed === 'breaking' ? null : 'Trading Economics',
    configured,
    enabled: configured && status !== 'DISABLED',
    status,
    detail: status === 'NOT_CONFIGURED' ? 'No licensed breaking-news provider is configured.' : null,
    latency: status === 'LIVE' ? 'REALTIME' : 'DELAYED',
    delaySec: status === 'LIVE' ? null : 300,
    staleAfterMs: 1_020_000,
    lastSuccessMs: configured ? 1 : null,
    lastDataMs: configured ? 1 : null,
    lastAttemptMs: configured ? 1 : null,
    error: null,
    ...over,
  };
}

let seq = 0;
export function calEvent(o: Partial<BridgeCalendarEvent> & { providerEventId: string; event: string; scheduledAt: number }): BridgeCalendarEvent {
  return {
    id: `tradingeconomics:${o.providerEventId}`,
    dedupKey: `tradingeconomics:${o.providerEventId}`,
    provider: 'tradingeconomics',
    providerName: 'Trading Economics',
    category: null,
    country: 'United States',
    currency: 'USD',
    reference: null,
    importance: 'HIGH',
    importanceRaw: 3,
    actual: null,
    forecast: null,
    previous: null,
    revised: null,
    teForecast: null,
    unit: null,
    source: 'TEST DATA',
    sourceUrl: null,
    url: null,
    providerUpdatedAt: null,
    releaseStatus: o.actual ? 'RELEASED' : 'SCHEDULED',
    receivedAt: 1,
    firstReceivedAt: 1,
    lastChangedAt: 1,
    revision: 0,
    seq: ++seq,
    ...o,
  };
}

export class FakeNewsBackend {
  calls: { url: string; headers: Record<string, string> }[] = [];
  down = false;
  unauthorized = false;
  startedAtMs = 1;
  feeds: Record<BridgeFeedKind, BridgeFeedView> = {
    calendar: feedView('calendar', 'DELAYED'),
    macro: feedView('macro', 'DISABLED'),
    breaking: feedView('breaking', 'NOT_CONFIGURED'),
  };
  events: BridgeCalendarEvent[] = [];
  headlines: Record<'macro' | 'breaking', BridgeHeadline[]> = { macro: [], breaking: [] };
  private seq = 0;

  /** Add / revise an event (a revision keeps its id and gets a new sequence number, like the backend store). */
  upsert(e: BridgeCalendarEvent): void {
    const i = this.events.findIndex((x) => x.dedupKey === e.dedupKey);
    const rec = { ...e, seq: ++this.seq };
    if (i >= 0) this.events[i] = rec;
    else this.events.push(rec);
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    if (this.down) throw new TypeError('Failed to fetch');
    if (this.unauthorized) return new Response('{"error":{"code":"UNAUTHORIZED"}}', { status: 401 });
    const u = new URL(url);
    const since = Number(u.searchParams.get('since') ?? 0);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname === '/v1/health') {
      const h: BridgeHealth = { service: 'tluxe-news', version: '1.0.0', startedAtMs: this.startedAtMs, timeMs: Date.now(), feeds: this.feeds, demoKey: false };
      return json(h);
    }
    if (u.pathname === '/v1/calendar') return json({ feed: 'calendar', seq: this.seq, reset: since > this.seq, events: this.events.filter((e) => e.seq > since) });
    if (u.pathname === '/v1/headlines') {
      const f = (u.searchParams.get('feed') ?? 'macro') as 'macro' | 'breaking';
      return json({ feed: f, seq: this.seq, reset: false, headlines: this.headlines[f].filter((h) => h.seq > since) });
    }
    return new Response('{}', { status: 404 });
  };
}
