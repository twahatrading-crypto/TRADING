import { NewsAlertTracker } from '../../engines/news/alerts';
import { NewsEngine } from '../../engines/news/engine';
import { normalizeCalendar, normalizeHeadline } from '../../engines/news/normalize';
import { measureReaction } from '../../engines/news/reaction';
import type { InstrumentRisk, NewsAlert, NewsLatency, NewsSnapshot, NewsUpdate, ReactionResult } from '../../engines/news/types';
import type { NewsFeedStatus, NewsProviders, NewsProviderSink, RawCalendarEvent, RawHeadline } from '../../providers/news/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';
import type { Candle } from '../../types/market';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
export type FeedKind = 'calendar' | 'breaking' | 'macro';

export interface NewsFeedView {
  kind: FeedKind;
  provider: string | null;
  name: string | null;
  status: NewsFeedStatus;
  detail: string | null;
  latency: NewsLatency | null;
  delaySec: number | null;
  lastMessageAt: number | null;
  test: boolean;
}

export interface NewsAnalysisState {
  now: number;
  feeds: Record<FeedKind, NewsFeedView>;
  snapshot: NewsSnapshot;
  alerts: NewsAlert[];
  suppressedAlerts: number;
  /** Active instrument (its M1 candles are the only ones used for reactions). */
  instrumentId: InstrumentId;
  /** Bumps when the active instrument's M1 candles change (reaction recompute). */
  candleVersion: number;
  updates: number;
  duplicatesDropped: number;
}

const UNAVAILABLE: Record<FeedKind, string> = { calendar: 'ECONOMIC CALENDAR UNAVAILABLE', breaking: 'BREAKING NEWS UNAVAILABLE', macro: 'NEWS DATA UNAVAILABLE' };
const MAX_ALERTS = 50;

/**
 * News Analysis runtime (outside React). Providers are connected ONCE (connectServices / main.tsx);
 * every message is stamped with its receipt time and normalized into the point-in-time NewsEngine.
 * Price reactions read the ACTIVE instrument's M1 candles from the existing MarketDataService
 * stream (a listener on the subscription the other engines already hold — no new MT5 request or
 * poll). A 1 s timer re-evaluates time-dependent state (status, countdowns, risk windows, alerts).
 * Nothing here places orders or blocks trading.
 */
export class NewsAnalysisService {
  readonly store: Store<NewsAnalysisState>;
  private readonly news = new NewsEngine();
  private readonly alerts = new NewsAlertTracker();
  private readonly timers: Timers;
  private readonly clock: () => number;
  private readonly feedState: Record<FeedKind, { status: NewsFeedStatus; detail: string | null; lastMessageAt: number | null }> = {
    calendar: { status: 'NOT_CONNECTED', detail: null, lastMessageAt: null },
    breaking: { status: 'NOT_CONNECTED', detail: null, lastMessageAt: null },
    macro: { status: 'NOT_CONNECTED', detail: null, lastMessageAt: null },
  };
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];
  private candleUnsub: (() => void) | null = null;
  private active: InstrumentId;
  private candleVersion = 0;
  /** Provider connects performed (tests: must stay 1 per provider across HMR / page switches). */
  connects = 0;

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
    private readonly providers: NewsProviders,
    o: { timers?: Timers; clock?: () => number } = {},
  ) {
    this.timers = o.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    this.clock = o.clock ?? (() => Date.now());
    this.active = this.instruments.store.getState().activeId;
    this.store = createStore<NewsAnalysisState>(this.compute(false));
  }

  /** Read-only news-risk state for an asset (for other TLUXE engines later). Never blocks anything. */
  riskFor(asset: string): InstrumentRisk | null {
    return this.store.getState().snapshot.risk[asset] ?? null;
  }
  /** Point-in-time state at T (news replay): only what TLUXE had received by T. */
  snapshotAt(T: number): NewsSnapshot {
    return this.news.snapshot(T);
  }
  recording(): readonly NewsUpdate[] {
    return this.news.allUpdates();
  }

  /** Observed reaction of the ACTIVE instrument to an event (real closed M1 candles only). */
  reaction(eventKey: string, at = this.clock()): ReactionResult {
    const e = this.news.eventsAt(at).find((x) => x.key === eventKey);
    const id = this.active;
    const none = (reason: string): ReactionResult => ({ instrumentId: id, status: 'UNAVAILABLE', reason, preTime: null, prePrice: null, horizons: [], maxUp: null, maxDown: null, volExpansion: null, displacementAtr: null, pattern: null, retracePct: null });
    if (!e) return none('Event not known at this time.');
    const t = e.kind === 'SCHEDULED' ? e.scheduledAt : e.publishedAt;
    if (t === null) return none('Event has no release time.');
    if (!e.affected.includes(id)) return none(`REACTION DATA UNAVAILABLE — ${id} is not among the event's affected instruments.`);
    return measureReaction(id, t, this.m1(), at);
  }
  m1(): Candle[] {
    const all = this.market.getCandles(this.active, 'M1');
    return all.some((c) => c.isClosed !== undefined) ? all.filter((c) => c.isClosed === true) : all.slice(0, Math.max(0, all.length - 1));
  }

  start(): () => void {
    if (this.started) return () => this.stop();
    this.started = true;
    const conn = (kind: FeedKind) => {
      const p = this.providers[kind];
      if (!p) return;
      this.connects += 1;
      this.feedState[kind] = { status: 'CONNECTING', detail: null, lastMessageAt: null };
      if (kind === 'calendar') p.connect(this.sink<RawCalendarEvent>(kind, (x, r) => normalizeCalendar(x, p.info, r)) as never);
      else p.connect(this.sink<RawHeadline>(kind, (x, r) => normalizeHeadline(x, p.info, r)) as never);
    };
    (['calendar', 'breaking', 'macro'] as const).forEach(conn);
    this.attach(this.instruments.store.getState().activeId);
    this.unsubs.push(this.instruments.store.subscribe(() => this.attach(this.instruments.store.getState().activeId)));
    this.timer = this.timers.setInterval(() => this.publish(true), 1000);
    this.publish(false);
    return () => this.stop();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.candleUnsub?.();
    this.candleUnsub = null;
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
    for (const k of ['calendar', 'breaking', 'macro'] as const) this.providers[k]?.disconnect();
  }

  private attach(id: InstrumentId): void {
    if (this.candleUnsub && this.active === id) return;
    this.candleUnsub?.();
    this.active = id;
    this.candleVersion += 1;
    // Same (instrument, M1) key the chart / engines use → the market service issues no new request.
    this.candleUnsub = this.market.subscribeCandles(id, 'M1', () => {
      this.candleVersion += 1;
    });
    this.publish(false);
  }

  private sink<T>(kind: FeedKind, norm: (x: T, receivedAt: number) => NewsUpdate | null): NewsProviderSink<T> {
    return {
      items: (items) => {
        const now = this.clock();
        this.feedState[kind].lastMessageAt = now;
        for (const x of items) {
          const u = norm(x, now);
          if (u) this.news.ingest(u);
        }
        this.publish(true);
      },
      heartbeat: () => {
        this.feedState[kind].lastMessageAt = this.clock();
      },
      status: (status, detail) => {
        this.feedState[kind] = { ...this.feedState[kind], status, detail: detail ?? null };
        this.publish(false);
      },
    };
  }

  private feedView(kind: FeedKind, now: number): NewsFeedView {
    const p = this.providers[kind];
    if (!p) return { kind, provider: null, name: null, status: 'NOT_CONNECTED', detail: UNAVAILABLE[kind], latency: null, delaySec: null, lastMessageAt: null, test: false };
    const f = this.feedState[kind];
    let status = f.status;
    let detail = f.detail;
    // Never claim LIVE for a delayed source, nor for a silent one.
    if (status === 'LIVE' && p.info.latency === 'DELAYED') status = 'DELAYED';
    if ((status === 'LIVE' || status === 'DELAYED') && (f.lastMessageAt === null || now - f.lastMessageAt > p.info.staleAfterMs)) {
      status = 'STALE';
      detail = `No message for ${f.lastMessageAt === null ? '—' : Math.round((now - f.lastMessageAt) / 1000)} s.`;
    }
    if (status === 'DISCONNECTED' || status === 'ERROR' || status === 'NOT_CONNECTED') detail = detail ?? UNAVAILABLE[kind];
    return { kind, provider: p.info.id, name: p.info.name, status, detail, latency: p.info.latency, delaySec: p.info.delaySec, lastMessageAt: f.lastMessageAt, test: !!p.info.test };
  }

  private compute(evaluateAlerts: boolean): NewsAnalysisState {
    const now = this.clock();
    const snapshot = this.news.snapshot(now);
    const prev = this.store?.getState();
    let alerts = prev?.alerts ?? [];
    if (evaluateAlerts || !prev) {
      const fresh = this.alerts.evaluate(snapshot.events, now);
      if (fresh.length) alerts = [...fresh, ...alerts].slice(0, MAX_ALERTS);
    }
    return {
      now,
      feeds: { calendar: this.feedView('calendar', now), breaking: this.feedView('breaking', now), macro: this.feedView('macro', now) },
      snapshot,
      alerts,
      suppressedAlerts: this.alerts.suppressed.length,
      instrumentId: this.active,
      candleVersion: this.candleVersion,
      updates: this.news.allUpdates().length,
      duplicatesDropped: this.news.duplicatesDropped,
    };
  }

  publish(evaluateAlerts = true): void {
    this.store.setState(this.compute(evaluateAlerts));
  }
}
