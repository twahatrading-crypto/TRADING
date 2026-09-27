import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SummaryCards } from '../../components/newsAnalysis/NewsPanels';
import { times } from '../../components/newsAnalysis/newsView';
import { NewsProvidersSettingsPanel } from '../../components/newsProviders/NewsProvidersSettings';
import { AI_CONTEXT_LIMITS, buildAiContext } from '../../services/ai/context/buildAiContext';
import { AI_NEWS_LIMITS } from '../../services/ai/context/newsContext';
import { connectServices, createServices, defaultProviders, type Services } from '../../services/registry';
import { memoryStorage } from '../../test/providers';
import { BridgeCalendarProvider, BridgeHeadlineProvider, categoryHint, toRawCalendar } from './adapters';
import { NewsBridgeClient } from './client';
import { DEFAULT_NEWS_BRIDGE_CONFIG, NEWS_BRIDGE_CONFIG_KEY, sanitizeNewsBridgeConfig } from './config';
import { NewsBridgeFeed } from './NewsBridgeFeed';
import { calEvent, FakeNewsBackend, feedView } from './testing/FakeNewsBackend';

/* TEST DATA ONLY — FakeNewsBackend stands in for the local news backend; nothing here reaches a provider. */

vi.mock('lightweight-charts', () => ({}));

const TOKEN = 'n'.repeat(40);
const FAKE_TE_KEY = 'testclientABC123:testsecretXYZ789';
const MIN = 60_000;

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

function rig(o: { before?: (b: FakeNewsBackend) => void; instrument?: string } = {}) {
  const backend = new FakeNewsBackend();
  o.before?.(backend);
  const cfg = { ...DEFAULT_NEWS_BRIDGE_CONFIG, enabled: true, token: TOKEN, pollMs: 3_600_000 };
  const feed = new NewsBridgeFeed(cfg, { api: new NewsBridgeClient(cfg.url, TOKEN, 5000, backend.fetch) });
  const services = createServices(
    { ...defaultProviders(), newsBridge: feed, newsAnalysis: { calendar: new BridgeCalendarProvider(feed), macro: new BridgeHeadlineProvider(feed, 'macro'), breaking: new BridgeHeadlineProvider(feed, 'breaking') } },
    { storage: memoryStorage({ 'tluxe.instrument.v1': o.instrument ?? 'XAUUSD' }) },
  );
  teardown = connectServices(services);
  const poll = async () => {
    await act(async () => {
      await feed.pollOnce();
    });
    act(() => services.newsAnalysis.publish(true));
  };
  return { backend, feed, services, poll };
}
const st = (s: Services) => s.newsAnalysis.store.getState();
const ev = (s: Services, providerEventId: string) => st(s).snapshot.events.find((e) => e.providerEventId === providerEventId);

describe('News — provider payload normalization into the existing engine', () => {
  it('Actual / Forecast / Previous preserved exactly; missing Actual stays null; importance from the provider', async () => {
    const now = Date.now();
    const r = rig({
      before: (b) => {
        b.upsert(calEvent({ providerEventId: '1', event: 'Core Inflation Rate MoM', category: 'Core Inflation Rate', scheduledAt: now - 30 * MIN, actual: '0.4%', forecast: '0.3%', previous: '0.2%', importance: 'HIGH' }));
        b.upsert(calEvent({ providerEventId: '2', event: 'Non Farm Payrolls', scheduledAt: now + 3 * 60 * MIN, forecast: '150K', previous: '142K', importance: 'HIGH' }));
        b.upsert(calEvent({ providerEventId: '3', event: 'Building Permits', scheduledAt: now + 4 * 60 * MIN, importance: 'LOW', importanceRaw: 1 }));
      },
    });
    await r.poll();
    const cpi = ev(r.services, '1')!;
    expect(cpi.key).toBe('tradingeconomics:1');
    expect([cpi.actual?.raw, cpi.forecast?.raw, cpi.previous?.raw]).toEqual(['0.4%', '0.3%', '0.2%']);
    expect(cpi.impact).toBe('HIGH');
    expect(cpi.impactSource).toBe('PROVIDER');
    expect(cpi.category).toBe('INFLATION');
    const nfp = ev(r.services, '2')!;
    expect(nfp.actual).toBeNull(); // never 0, never the forecast
    expect(nfp.status).toBe('UPCOMING');
    expect(ev(r.services, '3')!.impact).toBe('LOW');
    expect(st(r.services).feeds.calendar).toMatchObject({ provider: 'tradingeconomics', status: 'DELAYED' });
  });

  it('adapter mapping: explicit null Actual, TE Revised supersedes Previous, deterministic category hints', () => {
    const raw = toRawCalendar(calEvent({ providerEventId: '9', event: 'Initial Jobless Claims', scheduledAt: 1, previous: '215K', revised: '218K', importance: 'MEDIUM' }));
    expect(raw).toMatchObject({ id: '9', actual: null, previous: '218K', impact: 'MEDIUM', category: 'employment' });
    expect('actual' in raw).toBe(true);
    expect(categoryHint('Interest Rate', 'Fed Interest Rate Decision')).toBe('central bank');
    expect(categoryHint(null, 'Powell Speech')).toBe('central bank');
    expect(categoryHint('Inflation Rate', 'PCE Price Index YoY')).toBe('inflation');
    expect(categoryHint(null, 'JOLTs Job Openings')).toBe('employment');
    expect(categoryHint(null, 'ISM Manufacturing PMI')).toBe('growth');
    expect(categoryHint(null, '10-Year Note Auction')).toBe('rates');
    expect(categoryHint(null, 'Something Else')).toBeNull();
  });

  it('UTC → Denver display: 12:30 UTC release = 06:30 MDT (summer) / 06:30 MST (winter)', () => {
    const summer = Date.UTC(2026, 9, 14, 12, 30);
    expect(times(summer).denver.time).toMatch(/^06:30/);
    expect(times(summer).denver.zone).toMatch(/MDT|GMT-6|UTC-6/);
    const winter = Date.UTC(2026, 11, 11, 13, 30);
    expect(times(winter).denver.time).toMatch(/^06:30/);
    expect(times(winter).denver.zone).toMatch(/MST|GMT-7|UTC-7/);
  });

  it('duplicate provider updates are de-duplicated; a revision updates the SAME event', async () => {
    const now = Date.now();
    const base = calEvent({ providerEventId: '7', event: 'Retail Sales MoM', scheduledAt: now - 5 * MIN, forecast: '0.5%', previous: '0.3%', importance: 'HIGH' });
    const r = rig({ before: (b) => b.upsert(base) });
    await r.poll();
    // The same record delivered again (backend replays after a browser reconnect) → still one event.
    r.feed.subscribe('calendar', () => {})();
    await r.poll();
    expect(st(r.services).snapshot.events.filter((e) => e.providerEventId === '7')).toHaveLength(1);
    // Actual published + Previous revised → the same event is updated, the revision is kept.
    r.backend.upsert({ ...base, actual: '0.7%', revised: '0.4%', releaseStatus: 'RELEASED', revision: 1 });
    await r.poll();
    const e = st(r.services).snapshot.events.filter((x) => x.providerEventId === '7');
    expect(e).toHaveLength(1);
    expect(e[0]!.actual?.raw).toBe('0.7%');
    expect(e[0]!.previous?.raw).toBe('0.4%');
    expect(e[0]!.revisions.map((v) => [v.field, v.original.raw, v.revised.raw])).toEqual([['previous', '0.3%', '0.4%']]);
  });
});

describe('News — truthful status', () => {
  it('no provider → no events, feeds NOT_CONNECTED (nothing invented)', () => {
    const services = createServices(defaultProviders(memoryStorage()), { storage: memoryStorage() });
    teardown = connectServices(services);
    expect(services.newsBridge).toBeNull();
    const s = st(services);
    expect(s.snapshot.events).toEqual([]);
    expect([s.feeds.calendar.status, s.feeds.breaking.status, s.feeds.macro.status]).toEqual(['NOT_CONNECTED', 'NOT_CONNECTED', 'NOT_CONNECTED']);
  });

  it('backend without credentials → NOT_CONNECTED; backend down → DISCONNECTED; bad token → ERROR', async () => {
    const r = rig({ before: (b) => (b.feeds = { calendar: feedView('calendar', 'NOT_CONFIGURED', { detail: 'TRADING_ECONOMICS_API_KEY is not set on the news backend.' }), macro: feedView('macro', 'NOT_CONFIGURED'), breaking: feedView('breaking', 'NOT_CONFIGURED') }) });
    await r.poll();
    expect(st(r.services).feeds.calendar.status).toBe('NOT_CONNECTED');
    expect(st(r.services).feeds.calendar.detail).toMatch(/TRADING_ECONOMICS_API_KEY/);
    expect(r.backend.calls.some((c) => c.url.includes('/v1/calendar'))).toBe(false); // nothing fetched when not configured
    r.backend.down = true;
    await r.poll();
    expect(st(r.services).feeds.calendar.status).toBe('DISCONNECTED');
    r.backend.down = false;
    r.backend.unauthorized = true;
    await r.poll();
    expect(st(r.services).feeds.calendar.status).toBe('ERROR');
  });

  it('backend STALE → STALE; a delayed REST source is never shown LIVE; streaming LIVE only when the backend says so', async () => {
    const r = rig();
    await r.poll();
    expect(st(r.services).feeds.calendar.status).toBe('DELAYED');
    r.backend.feeds.calendar = feedView('calendar', 'STALE', { detail: 'No successful refresh for 1200 s.' });
    await r.poll();
    expect(st(r.services).feeds.calendar.status).toBe('STALE');
    r.backend.feeds.calendar = feedView('calendar', 'LIVE');
    await r.poll();
    expect(st(r.services).feeds.calendar.status).toBe('LIVE');
    expect(st(r.services).feeds.calendar.latency).toBe('REALTIME');
  });

  it('breaking news with no licensed provider stays NOT CONNECTED and shows no headlines', async () => {
    const r = rig();
    await r.poll();
    expect(st(r.services).feeds.breaking.status).toBe('NOT_CONNECTED');
    expect(st(r.services).snapshot.headlines).toEqual([]);
    expect(r.backend.calls.some((c) => c.url.includes('feed=breaking'))).toBe(false);
  });

  it('News Risk never shows NORMAL when the calendar itself is unavailable (disconnected or stale)', async () => {
    const r = rig();
    const view = () => {
      const { unmount } = render(
        <ServicesProvider services={r.services}>
          <SummaryCards st={st(r.services)} />
        </ServicesProvider>,
      );
      const risk = screen.getByTestId('nw-risk-card').textContent!;
      const usd = screen.getByTestId('nw-usd-card').textContent!;
      unmount();
      return { risk, usd };
    };
    r.backend.down = true;
    await r.poll();
    expect(view().risk).not.toMatch(/NORMAL/);
    expect(view().risk).toMatch(/NEWS DATA UNAVAILABLE/);
    expect(view().usd).toMatch(/NEWS DATA UNAVAILABLE/);
    r.backend.down = false;
    r.backend.feeds.calendar = feedView('calendar', 'STALE');
    await r.poll();
    expect(view().risk).not.toMatch(/NORMAL/);
    expect(view().risk).toMatch(/CALENDAR STALE/);
    r.backend.feeds.calendar = feedView('calendar', 'DELAYED');
    await r.poll();
    expect(view().risk).toMatch(/NORMAL/); // only with a usable calendar
    expect(view().risk).toMatch(/in the calendar data/);
  });

  it('a HIGH event inside its window drives PRE-NEWS risk with the event id as evidence', async () => {
    const now = Date.now();
    const r = rig({ before: (b) => b.upsert(calEvent({ providerEventId: '55', event: 'CPI MoM', scheduledAt: now + 10 * MIN, forecast: '0.3%', previous: '0.2%', importance: 'HIGH' })) });
    await r.poll();
    const risk = st(r.services).snapshot.risk['XAUUSD']!;
    expect(risk.state).toBe('PRE_NEWS');
    expect(risk.reasons[0]!.eventKey).toBe('tradingeconomics:55');
  });
});

describe('News — Event Reaction needs real candles', () => {
  it('no market candles → reaction UNAVAILABLE (never simulated or interpolated)', async () => {
    const now = Date.now();
    const r = rig({ before: (b) => b.upsert(calEvent({ providerEventId: '77', event: 'CPI YoY', scheduledAt: now - 20 * MIN, actual: '3.1%', forecast: '3.0%', previous: '2.9%', importance: 'HIGH' })) });
    await r.poll();
    const res = r.services.newsAnalysis.reaction('tradingeconomics:77');
    expect(res.status).toBe('UNAVAILABLE');
    expect(res.horizons.every((h) => h.price === null)).toBe(true);
    expect(res.prePrice).toBeNull();
  });
});

describe('News — secrets never reach the browser or TLUXE AI', () => {
  it('only the backend token is sent (header); a provider key is refused as a token; no provider key in the source', async () => {
    expect(sanitizeNewsBridgeConfig({ enabled: true, token: FAKE_TE_KEY }).token).toBe('');
    expect(defaultProviders(memoryStorage({ [NEWS_BRIDGE_CONFIG_KEY]: JSON.stringify({ enabled: true, token: FAKE_TE_KEY }) })).newsBridge).toBeNull();
    const r = rig();
    await r.poll();
    for (const c of r.backend.calls) {
      expect(c.url).toMatch(/^http:\/\/127\.0\.0\.1:8768\/v1\/(health|calendar|headlines)/);
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toMatch(/[?&](c|client|key)=/);
    }
    const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/testing/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    for (const [f, s] of Object.entries(sources)) {
      expect(s, f).not.toMatch(/api\.tradingeconomics\.com|stream\.tradingeconomics\.com/);
      expect(s, f).not.toMatch(/TRADING_ECONOMICS_API_KEY\s*[:=]\s*['"][^'"]+['"]/);
      expect(s, f).not.toMatch(/tradingview\.com|google\.com\/search|twitter\.com/);
    }
  });

  it('TLUXE AI gets a bounded, instrument-relevant, read-only news section with evidence keys and no secrets', async () => {
    const now = Date.now();
    const r = rig({
      before: (b) => {
        for (let k = 0; k < 60; k++) b.upsert(calEvent({ providerEventId: `u${k}`, event: `CPI test ${k}`, scheduledAt: now + (k + 1) * 30 * MIN, forecast: '0.3%', previous: '0.2%', importance: 'HIGH' }));
        for (let k = 0; k < 30; k++) b.upsert(calEvent({ providerEventId: `r${k}`, event: `Retail Sales ${k}`, scheduledAt: now - (k + 1) * 10 * MIN, actual: '0.5%', forecast: '0.3%', previous: '0.1%', importance: 'MEDIUM' }));
        b.upsert(calEvent({ providerEventId: 'eur', event: 'ECB Interest Rate Decision', currency: 'EUR', country: 'Euro Area', scheduledAt: now + 20 * MIN, importance: 'HIGH' }));
      },
    });
    await r.poll();
    const ctx = buildAiContext(r.services, Date.now());
    expect(ctx.news.status).toBe('DELAYED');
    const n = ctx.news.value!;
    expect(n.label).toBe('OBSERVED PROVIDER DATA (not AI interpretation)');
    expect(n.nextHighImpact.length).toBeLessThanOrEqual(AI_NEWS_LIMITS.next);
    expect(n.recentReleases.length).toBeLessThanOrEqual(AI_NEWS_LIMITS.released);
    expect(n.today.length).toBeLessThanOrEqual(AI_NEWS_LIMITS.today);
    expect(n.recentReleases[0]).toMatchObject({ provider: 'tradingeconomics', actual: '0.5%', forecast: '0.3%', previous: '0.1%' });
    expect(n.nextHighImpact.every((e) => e.key.startsWith('tradingeconomics:') && e.actual === null)).toBe(true);
    // EUR event is not relevant to XAUUSD (selected); it stays in storage but not in the XAUUSD context.
    expect(n.nextHighImpact.some((e) => e.key === 'tradingeconomics:eur')).toBe(false);
    expect(st(r.services).snapshot.events.some((e) => e.providerEventId === 'eur')).toBe(true);
    const json = JSON.stringify(ctx);
    expect(json.length).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.totalChars);
    expect(json).not.toMatch(/testsecret|testclient|Bearer|n{40}/);
  });

  it('EURUSD selected → the ECB event is included (instrument relevance is presentation / context logic)', async () => {
    const now = Date.now();
    const r = rig({ instrument: 'EURUSD', before: (b) => b.upsert(calEvent({ providerEventId: 'eur', event: 'ECB Interest Rate Decision', currency: 'EUR', country: 'Euro Area', scheduledAt: now + 20 * MIN, importance: 'HIGH' })) });
    await r.poll();
    expect(buildAiContext(r.services, Date.now()).news.value!.nextHighImpact.map((e) => e.key)).toEqual(['tradingeconomics:eur']);
  });

  it('calendar unavailable → AI news context UNAVAILABLE (no events handed to the model)', async () => {
    const r = rig({ before: (b) => (b.down = true) });
    await r.poll();
    const ctx = buildAiContext(r.services, Date.now());
    expect(ctx.news.status).toBe('UNAVAILABLE');
    expect(ctx.news.value).toBeUndefined();
    expect(ctx.news.reason).toMatch(/No news provider is delivering data/);
  });
});

describe('News — one feed loop, settings', () => {
  it('HMR / repeated connectServices never duplicates polling or subscriptions; teardown stops the loop', async () => {
    const r = rig();
    await r.poll();
    expect(r.feed.listenerCount()).toBe(3);
    connectServices(r.services);
    expect(r.feed.listenerCount()).toBe(3);
    expect(r.feed.isRunning()).toBe(true);
    teardown!();
    teardown = null;
    expect(r.feed.listenerCount()).toBe(0);
    expect(r.feed.isRunning()).toBe(false);
  });

  it('Settings → News Providers: provider, enabled, connected, freshness, last update — no provider key in the page', async () => {
    const r = rig();
    await r.poll();
    render(
      <ServicesProvider services={r.services}>
        <NewsProvidersSettingsPanel />
      </ServicesProvider>,
    );
    const cal = screen.getByTestId('news-provider-calendar').textContent!;
    expect(cal).toMatch(/Economic Calendar/);
    expect(cal).toMatch(/Connected/);
    expect(cal).toMatch(/Trading Economics/);
    expect(cal).toMatch(/Enabled: yes/);
    expect(cal).toMatch(/Freshness: Delayed/);
    expect(cal).toMatch(/Last update:/);
    expect(within(screen.getByTestId('news-provider-breaking')).getByText('Not Connected')).toBeTruthy();
    expect(within(screen.getByTestId('news-provider-macro')).getByText('Not Connected')).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/testsecret|TRADING_ECONOMICS_API_KEY=/);
  });
});
