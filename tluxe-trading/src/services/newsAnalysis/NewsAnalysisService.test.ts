import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN, T_CPI, m1Around } from '../../engines/news/testing/fixtures';
import { ScriptedCalendarProvider, ScriptedHeadlineProvider, TEST_CALENDAR_INFO, TEST_WIRE_INFO } from '../../providers/news/testing/ScriptedNewsProviders';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { connectServices, createServices, defaultProviders, type Services } from '../registry';

/* TEST DATA ONLY — scripted providers, allowed here via allowTestProviders. */

let teardown: (() => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T_CPI - 60 * MIN));
});
afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

const calEvents = () => [
  { id: 'cpi', time: T_CPI, title: 'CPI m/m', country: 'US', currency: 'USD', impact: 'high' as const, forecast: '0.3%', previous: '0.2%' },
  { id: 'claims', time: T_CPI, title: 'Initial Jobless Claims', country: 'US', currency: 'USD', impact: 'medium' as const, forecast: '220K', previous: '215K' },
];

function setup(o: { allowTest?: boolean; instrument?: string } = {}) {
  const cal = new ScriptedCalendarProvider(TEST_CALENDAR_INFO, calEvents());
  const wire = new ScriptedHeadlineProvider(TEST_WIRE_INFO, []);
  const price = new ManualPriceProvider('mt5');
  const services = createServices({ ...defaultProviders(), price: [price], newsAnalysis: { calendar: cal, breaking: wire } }, { storage: memoryStorage({ 'tluxe.instrument.v1': o.instrument ?? 'XAUUSD' }), allowTestProviders: o.allowTest ?? true });
  teardown = connectServices(services);
  return { services, cal, wire, price };
}
const st = (s: Services) => s.newsAnalysis.store.getState();
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('NewsAnalysisService — real-data boundaries', () => {
  it('production default: no providers → every feed DATA UNAVAILABLE, no events, no invented values', () => {
    const services = createServices(defaultProviders(), { storage: memoryStorage() });
    teardown = connectServices(services);
    const x = st(services);
    expect(x.feeds.calendar).toMatchObject({ status: 'NOT_CONNECTED', detail: 'ECONOMIC CALENDAR UNAVAILABLE', provider: null });
    expect(x.feeds.breaking.detail).toBe('BREAKING NEWS UNAVAILABLE');
    expect(x.feeds.macro.detail).toBe('NEWS DATA UNAVAILABLE');
    expect(x.snapshot.events).toEqual([]);
    expect(x.snapshot.nextHigh).toBeNull();
    expect(x.snapshot.risk.XAUUSD!.state).toBe('NORMAL');
    expect(defaultProviders().newsAnalysis).toBeUndefined();
  });

  it('the registry refuses TEST providers unless explicitly allowed', () => {
    const { services, cal } = setup({ allowTest: false });
    expect(cal.connects).toBe(0);
    expect(st(services).feeds.calendar.provider).toBeNull();
  });

  it('a delayed source is never shown LIVE; a silent source becomes STALE; outage → DISCONNECTED', () => {
    const { services, wire, cal } = setup();
    expect(st(services).feeds.breaking.status).toBe('STALE'); // declared LIVE but no message yet
    act(() => wire.heartbeat());
    tick(1000);
    expect(st(services).feeds.breaking.status).toBe('DELAYED');
    expect(st(services).feeds.calendar.status).toBe('LIVE');
    tick(11 * MIN);
    expect(st(services).feeds.calendar.status).toBe('STALE');
    act(() => cal.setStatus('DISCONNECTED', 'provider outage'));
    expect(st(services).feeds.calendar.status).toBe('DISCONNECTED');
    // Data received before the outage remains (point-in-time), nothing is invented after it.
    expect(st(services).snapshot.calendar.map((e) => e.providerEventId)).toEqual(['claims', 'cpi']);
  });
});

describe('NewsAnalysisService — live flow', () => {
  it('receipt-time knowledge, countdown to the next HIGH event, risk window, actual, alerts once', () => {
    const { services, cal } = setup();
    expect(st(services).snapshot.nextHigh!.providerEventId).toBe('cpi');
    tick(35 * MIN); // T−25 min
    expect(st(services).snapshot.risk.XAUUSD!.state).toBe('PRE_NEWS');
    expect(st(services).alerts.map((a) => a.type)).toEqual(['HIGH_IMPACT_IN_30']);
    tick(25 * MIN); // release
    tick(20_000);
    act(() => cal.push([{ ...calEvents()[0]!, actual: '0.4%' }]));
    tick(1000);
    const x = st(services);
    const cpi = x.snapshot.events.find((e) => e.providerEventId === 'cpi')!;
    expect(cpi.actual!.raw).toBe('0.4%');
    expect(cpi.actualKnownAt).toBe(T_CPI + 20_000);
    expect(x.snapshot.risk.XAUUSD!.state).toBe('NEWS_LIVE');
    const types = x.alerts.map((a) => a.type);
    expect(types).toContain('NEWS_RELEASED');
    expect(types).toContain('ACTUAL_AVAILABLE');
    expect(new Set(x.alerts.map((a) => a.id)).size).toBe(x.alerts.length);
    // Redelivery of the same data never duplicates events or alerts.
    act(() => cal.push([{ ...calEvents()[0]!, actual: '0.4%' }]));
    tick(5000);
    expect(st(services).alerts.length).toBe(x.alerts.length);
    // Replay: the point-in-time state before the actual arrived has no actual.
    expect(services.newsAnalysis.snapshotAt(T_CPI + 10_000).events.find((e) => e.providerEventId === 'cpi')!.actual).toBeNull();
    // Read-only risk API for other engines.
    expect(services.newsAnalysis.riskFor('XAUUSD')!.state).toBe('NEWS_LIVE');
  });

  it('observed reaction from the ACTIVE instrument M1 candles only; other instruments UNAVAILABLE', () => {
    const { services, price } = setup();
    vi.setSystemTime(new Date(T_CPI + 70 * MIN));
    const m1 = m1Around(T_CPI, 40, 70, 2400, (i) => (i <= 0 ? 0 : Math.min(i, 10)));
    act(() => {
      price.sink.connection('XAUUSD', 'LIVE');
      price.sink.candles('XAUUSD', 'M1', m1, 'replace');
    });
    tick(1000);
    const r = services.newsAnalysis.reaction('test-calendar:cpi');
    expect(r.instrumentId).toBe('XAUUSD');
    expect(r.status).toBe('COMPLETE');
    expect(r.horizons.map((h) => h.change)).toEqual([1, 5, 10, 10, 10]);
    act(() => services.instruments.select('NASDAQ'));
    const n = services.newsAnalysis.reaction('test-calendar:cpi');
    expect(n.status).toBe('UNAVAILABLE');
    expect(n.instrumentId).toBe('NASDAQ');
  });

  it('recovered history on start never alerts', () => {
    vi.setSystemTime(new Date(T_CPI + 30 * MIN));
    const cal = new ScriptedCalendarProvider(TEST_CALENDAR_INFO, [{ ...calEvents()[0]!, actual: '0.4%' }]);
    const services = createServices({ ...defaultProviders(), newsAnalysis: { calendar: cal } }, { storage: memoryStorage(), allowTestProviders: true });
    teardown = connectServices(services);
    tick(5 * MIN);
    expect(st(services).alerts).toEqual([]);
    expect(st(services).snapshot.events).toHaveLength(1);
  });
});

describe('NewsAnalysisService — lifecycle', () => {
  it('connectServices is idempotent; HMR dispose + reconnect → one connection per provider; no MT5 request added', () => {
    const { services, cal, wire, price } = setup();
    connectServices(services);
    services.newsAnalysis.start();
    expect(cal.connects).toBe(1);
    expect(wire.connects).toBe(1);
    const m1Requests = () => price.requestCandles.mock.calls.filter(([id, tf]) => id === 'XAUUSD' && tf === 'M1').length;
    expect(m1Requests()).toBeLessThanOrEqual(1);
    teardown!();
    expect(cal.disconnects).toBe(1);
    teardown = connectServices(services);
    expect(cal.connects - cal.disconnects).toBe(1);
    expect(m1Requests()).toBeLessThanOrEqual(1);
  });

  it('symbol switch moves the reaction focus to the new active instrument (no stale candles)', () => {
    const { services } = setup();
    act(() => services.instruments.select('XAGUSD'));
    expect(st(services).instrumentId).toBe('XAGUSD');
    expect(services.newsAnalysis.m1()).toEqual([]);
  });
});
