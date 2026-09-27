import type { BreakingNewsProvider, EconomicCalendarProvider, MacroNewsProvider, NewsFeedStatus, NewsProviderInfo, NewsProviderSink, RawCalendarEvent, RawHeadline } from '../news/types';
import type { NewsBridgeEvent, NewsBridgeFeed } from './NewsBridgeFeed';
import type { BridgeCalendarEvent, BridgeFeedKind, BridgeFeedView, BridgeHeadline } from './protocol';

/*
 * Thin adapters: the local news backend (bridge/news) exposed through the EXISTING news provider contract
 * (providers/news/types) — the News engine, service and page are unchanged. Nothing here creates data:
 *   - rows come only from the backend (Trading Economics); a missing Actual stays null;
 *   - status is the backend's truthful feed status (LIVE only with TE streaming; REST refresh = DELAYED);
 *   - backend unreachable / not configured → DISCONNECTED / NOT_CONNECTED (the page shows DATA UNAVAILABLE).
 */

/** Provider category / event text → the engine's category vocabulary (deterministic; unknown → null, never guessed). */
export function categoryHint(category: string | null, event: string): string | null {
  const t = `${category ?? ''} ${event}`.toLowerCase();
  if (/interest rate|fed |fomc|federal reserve|monetary policy|central bank|powell|\becb\b|\bboe\b|\bboj\b|\bboc\b|\bsnb\b|\brba\b/.test(` ${t} `)) return 'central bank';
  if (/inflation|\bcpi\b|\bpce\b|\bppi\b|price index|deflator/.test(t)) return 'inflation';
  if (/payroll|employment|unemployment|jobless|claims|jolts|\badp\b|labou?r|earnings|job /.test(t)) return 'employment';
  if (/treasury|bond|auction|yield|\bnote\b|\bbill\b/.test(t)) return 'rates';
  if (/\bgdp\b|retail sales|\bpmi\b|\bism\b|industrial|durable|growth|sentiment|confidence|housing|trade balance/.test(t)) return 'growth';
  return null;
}

function feedStatus(v: BridgeFeedView): { status: NewsFeedStatus; detail: string | null } {
  switch (v.status) {
    case 'LIVE':
      return { status: 'LIVE', detail: v.detail };
    case 'DELAYED':
      return { status: 'DELAYED', detail: v.detail };
    case 'STALE':
      return { status: 'STALE', detail: v.detail };
    case 'CONNECTING':
      return { status: 'CONNECTING', detail: v.detail };
    case 'ERROR':
      return { status: 'ERROR', detail: v.detail };
    default: // NOT_CONFIGURED / DISABLED
      return { status: 'NOT_CONNECTED', detail: v.detail };
  }
}

abstract class BridgeAdapter<T> {
  protected sink: NewsProviderSink<T> | null = null;
  private off: (() => void) | null = null;
  protected view: BridgeFeedView | null = null;
  private lastStatus = '';
  readonly info: NewsProviderInfo;

  constructor(
    protected readonly feed: NewsBridgeFeed,
    protected readonly kind: BridgeFeedKind,
    id: string,
    name: string,
  ) {
    // Capabilities reflect what the backend currently delivers (never upgraded): REALTIME only while TE streaming is live.
    // The adapter heartbeats on every successful backend poll while the backend feed is fresh.
    const info = { id, name, kind, staleAfterMs: 90_000 } as NewsProviderInfo;
    Object.defineProperties(info, {
      latency: { enumerable: true, get: () => (this.view?.status === 'LIVE' ? 'REALTIME' : this.view ? 'DELAYED' : 'UNKNOWN') },
      delaySec: { enumerable: true, get: () => (this.view && this.view.status !== 'LIVE' ? this.view.delaySec : null) },
    });
    this.info = info;
  }

  connect(sink: NewsProviderSink<T>): void {
    this.sink = sink;
    sink.status('CONNECTING', 'Connecting to the TLUXE news backend.');
    this.off?.();
    this.off = this.feed.subscribe(this.kind, (e) => this.onEvent(e));
  }
  disconnect(): void {
    this.off?.();
    this.off = null;
    this.sink = null;
  }

  private setStatus(status: NewsFeedStatus, detail: string | null): void {
    const k = `${status}|${detail}`;
    if (k === this.lastStatus) return;
    this.lastStatus = k;
    this.sink?.status(status, detail);
  }

  protected abstract items(e: NewsBridgeEvent): T[] | null;

  private onEvent(e: NewsBridgeEvent): void {
    if (!this.sink) return;
    if (e.kind === 'offline') {
      this.view = null;
      return this.setStatus(e.reason === 'UNAUTHORIZED' ? 'ERROR' : 'DISCONNECTED', e.message);
    }
    if (e.kind === 'health') {
      this.view = e.view;
      const s = feedStatus(e.view);
      this.setStatus(s.status, s.detail);
      if (s.status === 'LIVE' || s.status === 'DELAYED') this.sink.heartbeat();
      return;
    }
    const out = this.items(e);
    if (out && out.length) this.sink.items(out);
  }
}

/** Normalized Trading Economics row → the engine's RawCalendarEvent (all provider values passed through). */
export function toRawCalendar(e: BridgeCalendarEvent): RawCalendarEvent {
  return {
    id: e.providerEventId,
    time: e.scheduledAt,
    title: e.event,
    country: e.country,
    currency: e.currency,
    impact: e.importance,
    // Explicit null = "the provider has no value (yet)" — never 0, never the forecast.
    actual: e.actual,
    forecast: e.forecast,
    // Trading Economics "Revised" is the revised previous figure: when present it supersedes Previous, so the engine
    // records the change as a revision of the SAME event (original kept in its revision history).
    previous: e.revised ?? e.previous,
    updatedAt: e.providerUpdatedAt,
    category: categoryHint(e.category, e.event),
    url: e.sourceUrl ?? e.url,
    instruments: [],
  };
}

export function toRawHeadline(h: BridgeHeadline): RawHeadline {
  return {
    id: h.providerItemId,
    publishedAt: h.publishedAt,
    headline: h.headline,
    source: h.source,
    url: h.sourceUrl,
    category: categoryHint(h.category, h.headline),
    impact: h.importance,
    country: h.country,
    currency: null, // not supplied by the provider for news items - never guessed
    instruments: [],
  };
}

export class BridgeCalendarProvider extends BridgeAdapter<RawCalendarEvent> implements EconomicCalendarProvider {
  constructor(feed: NewsBridgeFeed) {
    super(feed, 'calendar', 'tradingeconomics', 'Trading Economics · Economic Calendar');
  }
  protected items(e: NewsBridgeEvent): RawCalendarEvent[] | null {
    return e.kind === 'calendar' ? e.events.map(toRawCalendar) : null;
  }
}

export class BridgeHeadlineProvider extends BridgeAdapter<RawHeadline> implements BreakingNewsProvider, MacroNewsProvider {
  constructor(feed: NewsBridgeFeed, kind: 'macro' | 'breaking') {
    super(feed, kind, kind === 'macro' ? 'tradingeconomics-news' : 'breaking-news', kind === 'macro' ? 'Trading Economics · News' : 'Breaking News (no licensed provider configured)');
  }
  protected items(e: NewsBridgeEvent): RawHeadline[] | null {
    return e.kind === 'headlines' ? e.headlines.map(toRawHeadline) : null;
  }
}
