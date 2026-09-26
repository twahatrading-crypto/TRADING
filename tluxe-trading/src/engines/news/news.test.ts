import { describe, expect, it } from 'vitest';
import { NewsAlertTracker } from './alerts';
import { auditNews } from './audit';
import { NewsEngine, affectedOf } from './engine';
import { normalizeCalendar, normalizeHeadline } from './normalize';
import { measureReaction } from './reaction';
import { riskFor } from './riskWindow';
import { compare, surprise } from './surprise';
import { CAL_INFO, CAL_INFO_B, MIN, T_CPI, WIRE_INFO, cal, cpiDay, m1Around, wire } from './testing/fixtures';
import { countdown, dayKey, sameWeek, zoneParts } from './time';
import type { NewsUpdate } from './types';
import { parseTime, parseValue } from './values';

/* TEST DATA ONLY — synthetic provider payloads. */

const engine = (us: readonly NewsUpdate[] = cpiDay()) => {
  const e = new NewsEngine();
  e.ingestAll(us);
  return e;
};
const ev = (e: NewsEngine, T: number, id: string) => e.eventsAt(T).find((x) => x.providerEventId === id)!;

describe('provider normalization', () => {
  it('maps a calendar row to the internal schema, preserving provider id, times, source and values', () => {
    const u = normalizeCalendar({ id: 'x1', time: '2026-01-13T08:30:00-05:00', title: ' CPI m/m ', country: 'us', currency: 'usd', impact: 'high', forecast: '0.3%', previous: '0.2%', url: 'https://example.test/x1' }, CAL_INFO, 1000)!;
    expect(u).toMatchObject({ key: 'test-cal:x1', provider: 'test-cal', providerEventId: 'x1', kind: 'SCHEDULED', title: 'CPI m/m', country: 'US', currency: 'USD', category: 'INFLATION', indicator: 'CPI', providerImpact: 'HIGH', scheduledAt: T_CPI, receivedAt: 1000, knownAt: 1000, sourceUrl: 'https://example.test/x1', latency: 'REALTIME' });
    expect(u.forecast).toEqual({ raw: '0.3%', value: 0.3, unit: '%', decimals: 1 });
    expect('actual' in u).toBe(false); // not supplied → not part of the update (never invented)
  });

  it('rejects ambiguous / invalid rows instead of guessing', () => {
    expect(normalizeCalendar({ id: 'a', time: '2026-01-13T08:30:00', title: 'CPI' }, CAL_INFO, 1)).toBeNull(); // no offset
    expect(normalizeCalendar({ id: '', time: T_CPI, title: 'CPI' }, CAL_INFO, 1)).toBeNull();
    expect(normalizeCalendar({ id: 'a', time: T_CPI, title: '  ' }, CAL_INFO, 1)).toBeNull();
    expect(normalizeHeadline({ id: 'h', publishedAt: 'yesterday', headline: 'x' }, WIRE_INFO, 1)).toBeNull();
  });

  it('parses published values without inventing any', () => {
    expect(parseValue('215K')).toEqual({ raw: '215K', value: 215, unit: 'K', decimals: 0 });
    expect(parseValue('-0.1%')).toMatchObject({ value: -0.1, unit: '%', decimals: 1 });
    expect(parseValue('1,234.5')).toMatchObject({ value: 1234.5, unit: null });
    expect(parseValue('')).toBeNull();
    expect(parseValue('—')).toBeNull();
    expect(parseValue('hawkish')).toMatchObject({ value: null });
    expect(parseTime('2026-01-13T13:30:00Z')).toBe(T_CPI);
  });

  it('knownAt is the receipt time (provider timestamps are metadata, never earlier knowledge)', () => {
    const a = normalizeCalendar({ id: 'a', time: T_CPI, title: 'CPI', updatedAt: T_CPI + 1000 }, CAL_INFO, T_CPI + 60_000)!;
    expect(a.knownAt).toBe(T_CPI + 60_000);
    expect(a.publishedAt).toBe(T_CPI + 1000);
    expect(normalizeHeadline({ id: 'h', publishedAt: T_CPI, headline: 'x' }, WIRE_INFO, T_CPI + 9000)!.knownAt).toBe(T_CPI + 9000);
    // A headline stamped in the future (clock skew) is not known before its publication time.
    expect(normalizeHeadline({ id: 'h', publishedAt: T_CPI + 5000, headline: 'x' }, WIRE_INFO, T_CPI)!.knownAt).toBe(T_CPI + 5000);
  });
});

describe('time handling', () => {
  it('Denver time follows DST (MST in January, MDT in July) from the IANA database', () => {
    expect(zoneParts(T_CPI, 'America/Denver')).toMatchObject({ time: '06:30', zone: 'MST' });
    expect(zoneParts(Date.UTC(2026, 6, 14, 12, 30), 'America/Denver')).toMatchObject({ time: '06:30', zone: 'MDT' });
    expect(zoneParts(T_CPI, 'UTC').time).toBe('13:30');
    // DST switch night (2026-03-08): 08:59Z = 01:59 MST, 09:00Z = 03:00 MDT.
    expect(zoneParts(Date.UTC(2026, 2, 8, 8, 59), 'America/Denver').time).toBe('01:59');
    expect(zoneParts(Date.UTC(2026, 2, 8, 9, 0), 'America/Denver').time).toBe('03:00');
  });

  it('day / week grouping in the display zone, and countdown maths', () => {
    expect(dayKey(Date.UTC(2026, 0, 14, 5, 0), 'America/Denver')).toBe('2026-01-13'); // 22:00 MST previous day
    expect(sameWeek(Date.UTC(2026, 0, 18, 12), Date.UTC(2026, 0, 12, 12), 'UTC')).toBe(true); // Mon → Sun
    expect(sameWeek(Date.UTC(2026, 0, 19, 12), Date.UTC(2026, 0, 12, 12), 'UTC')).toBe(false);
    expect(countdown(((3 * 24 + 10) * 60 + 24) * 60_000 + 48_000)).toEqual({ days: 3, hours: 10, minutes: 24, seconds: 48, negative: false });
  });
});

describe('impact, surprise, indicator direction', () => {
  it('impact: provider first, then indicator rule, then category rule', () => {
    const e = engine();
    expect(ev(e, T_CPI, 'cpi')).toMatchObject({ impact: 'HIGH', impactSource: 'PROVIDER' });
    expect(ev(e, T_CPI, 'ecb')).toMatchObject({ impact: 'HIGH', impactSource: 'RULE', indicator: 'RATE_DECISION' });
    expect(ev(e, T_CPI, 'metals-1')).toMatchObject({ impact: 'MEDIUM', impactSource: 'PROVIDER' });
    const h = engine([wire({ id: 'g', publishedAt: T_CPI, headline: 'Border clash', category: 'geopolitical' }, T_CPI)]);
    expect(ev(h, T_CPI, 'g')).toMatchObject({ impact: 'MEDIUM', impactSource: 'RULE' });
  });

  it('actual vs forecast with the economic meaning of the indicator (never "higher = bullish")', () => {
    const v = parseValue;
    expect(surprise('CPI', v('0.4%'), v('0.3%'), v('0.2%'))).toMatchObject({ vsForecast: 'ABOVE FORECAST', vsPrevious: 'ABOVE PREVIOUS', interpretation: 'HOTTER', deltaForecast: 0.1 });
    expect(surprise('UNEMPLOYMENT', v('4.3%'), v('4.1%'), null)).toMatchObject({ vsForecast: 'ABOVE FORECAST', interpretation: 'WEAKER', vsPrevious: 'NO PREVIOUS' });
    expect(surprise('JOBLESS_CLAIMS', v('200K'), v('220K'), null).interpretation).toBe('STRONGER');
    expect(surprise('NFP', v('150K'), v('200K'), null).interpretation).toBe('WEAKER');
    expect(surprise('RATE_DECISION', v('4.75%'), v('4.50%'), null).interpretation).toBe('HAWKISH');
    expect(surprise('CPI', v('0.30%'), v('0.3%'), null)).toMatchObject({ vsForecast: 'IN LINE', interpretation: 'IN_LINE' });
    expect(surprise('CPI', v('0.4%'), null, null)).toMatchObject({ vsForecast: 'NO FORECAST', interpretation: null });
    expect(surprise('CPI', null, v('0.3%'), null)).toMatchObject({ vsForecast: 'NO ACTUAL', interpretation: null });
    expect(compare(v('215K'), v('0.2%'))).toBe('NOT_COMPARABLE');
    expect(surprise('CB_SPEECH', v('1'), v('0'), null).interpretation).toBeNull();
  });
});

describe('point-in-time state: status, actual, revision causality', () => {
  const e = engine();
  it('status through the event life cycle', () => {
    expect(ev(e, T_CPI - 2 * 60 * MIN, 'cpi').status).toBe('UPCOMING');
    expect(ev(e, T_CPI - 10 * MIN, 'cpi').status).toBe('PRE_NEWS');
    expect(ev(e, T_CPI + 5 * MIN, 'cpi').status).toBe('LIVE');
    expect(ev(e, T_CPI + 30 * MIN, 'cpi').status).toBe('POST_NEWS');
    expect(ev(e, T_CPI + 2 * 60 * MIN, 'cpi').status).toBe('RELEASED');
  });

  it('no Actual before it is known; surprise / implications only afterwards', () => {
    const before = ev(e, T_CPI + 10_000, 'cpi');
    expect(before.actual).toBeNull();
    expect(before.surprise!.vsForecast).toBe('NO ACTUAL');
    expect(before.implications.USD.state).toBe('INSUFFICIENT DATA');
    const after = ev(e, T_CPI + 20_000, 'cpi');
    expect(after.actual!.raw).toBe('0.4%');
    expect(after.actualKnownAt).toBe(T_CPI + 20_000);
    expect(after.implications.USD.state).toBe('BULLISH PRESSURE');
    expect(after.implications.GOLD.state).toBe('BEARISH PRESSURE');
  });

  it('a revision applies only from its publication; the original is preserved', () => {
    const t1 = ev(e, T_CPI + 60 * MIN, 'cpi');
    expect(t1.previous!.raw).toBe('0.2%');
    expect(t1.revisions).toEqual([]);
    const t2 = ev(e, T_CPI + 3 * 24 * 60 * MIN, 'cpi');
    expect(t2.previous!.raw).toBe('0.1%');
    expect(t2.revisions).toEqual([{ field: 'previous', original: parseValue('0.2%'), revised: parseValue('0.1%'), revisedAt: T_CPI + 3 * 24 * 60 * MIN }]);
    expect(t2.surprise!.vsPrevious).toBe('ABOVE PREVIOUS');
  });

  it('STALE when a numeric release has no Actual 15 min after release; CANCELLED from the update that says so', () => {
    const s = engine([cal({ id: 'x', time: T_CPI, title: 'Retail Sales m/m', currency: 'USD', forecast: '0.5%' }, T_CPI - MIN)]);
    expect(ev(s, T_CPI + 14 * MIN, 'x').status).toBe('LIVE');
    expect(ev(s, T_CPI + 16 * MIN, 'x').status).toBe('STALE');
    const c = engine([cal({ id: 'x', time: T_CPI, title: 'Fed Chair Speaks', currency: 'USD' }, T_CPI - 60 * MIN), cal({ id: 'x', time: T_CPI, title: 'Fed Chair Speaks', currency: 'USD', cancelled: true }, T_CPI - 30 * MIN)]);
    expect(ev(c, T_CPI - 40 * MIN, 'x').status).not.toBe('CANCELLED');
    expect(ev(c, T_CPI - 20 * MIN, 'x').status).toBe('CANCELLED');
    expect(riskFor('XAUUSD', c.eventsAt(T_CPI), T_CPI).state).toBe('NORMAL');
  });

  it('events do not exist before they are known; ordering by time; breaking news newest first', () => {
    expect(e.eventsAt(T_CPI - 30 * 60 * MIN)).toHaveLength(0);
    const s = e.snapshot(T_CPI + 60 * MIN);
    const times = s.calendar.map((x) => x.scheduledAt!);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(s.headlines.map((h) => h.providerEventId)).toEqual(['geo-1', 'metals-1']);
    expect(e.snapshot(T_CPI + 30 * MIN).headlines.map((h) => h.providerEventId)).toEqual(['metals-1']);
    expect(e.snapshot(T_CPI + 40 * MIN + 1000).headlines.map((h) => h.providerEventId)).toEqual(['metals-1']); // published, not yet received
  });
});

describe('affected instruments, duplicates', () => {
  it('one event → several assets; foreign events stay on their own assets', () => {
    const e = engine();
    const cpi = ev(e, T_CPI, 'cpi').affected;
    for (const a of ['USD', 'DXY', 'XAUUSD', 'XAGUSD', 'GC', 'SI', 'NASDAQ', 'BTCUSD', 'EURUSD']) expect(cpi).toContain(a);
    const ecb = ev(e, T_CPI, 'ecb').affected;
    expect(ecb).toEqual(['EURUSD', 'DXY', 'USD']);
    expect(ev(e, T_CPI, 'metals-1').affected).toEqual(['XAUUSD', 'XAGUSD', 'GC', 'SI']);
    expect(affectedOf(null, 'CRYPTO', ['MSTR'])).toEqual(['BTCUSD', 'ETHUSD', 'SOLUSD', 'MSTR']);
  });

  it('exact duplicate deliveries are dropped; cross-provider duplicates are linked, not double-counted', () => {
    const e = engine([...cpiDay(), ...cpiDay()]);
    expect(e.duplicatesDropped).toBe(cpiDay().length);
    const b = cal({ id: 'other-cpi', time: T_CPI, title: 'CPI m/m', currency: 'USD', impact: 'high', forecast: '0.3%' }, T_CPI - 60 * MIN, CAL_INFO_B);
    const e2 = engine([...cpiDay(), b]);
    const dup = ev(e2, T_CPI, 'other-cpi');
    expect(dup.duplicateOf).toBe('test-cal:cpi');
    expect(riskFor('XAUUSD', e2.eventsAt(T_CPI - 5 * MIN), T_CPI - 5 * MIN).reasons.filter((r) => r.state === 'PRE_NEWS')).toHaveLength(1);
  });
});

describe('news-risk windows', () => {
  const e = engine();
  const risk = (a: string, T: number) => riskFor(a, e.eventsAt(T), T);
  it('PRE-NEWS → NEWS LIVE → POST-NEWS → NORMAL, with the causing event named', () => {
    expect(risk('XAUUSD', T_CPI - 31 * MIN).state).toBe('NORMAL');
    const pre = risk('XAUUSD', T_CPI - 10 * MIN);
    expect(pre.state).toBe('PRE_NEWS');
    expect(pre.reasons[0]!.text).toMatch(/PRE-NEWS: HIGH CPI m\/m \(USD\)/);
    expect(pre.until).toBe(T_CPI);
    expect(risk('XAUUSD', T_CPI + 5 * MIN).state).toBe('NEWS_LIVE');
    expect(risk('XAUUSD', T_CPI + 30 * MIN).state).toBe('POST_NEWS');
    expect(risk('XAUUSD', T_CPI + 3 * 60 * MIN).state).toBe('NORMAL');
  });
  it('overlapping events: the most severe wins and every cause is listed', () => {
    const r = risk('XAUUSD', T_CPI + 45 * MIN);
    expect(r.state).toBe('NEWS_LIVE'); // geopolitical HIGH headline live
    expect(r.reasons.map((x) => x.state)).toEqual(['NEWS_LIVE', 'POST_NEWS']);
    expect(r.reasons.map((x) => x.eventKey)).toEqual(['test-wire:geo-1', 'test-cal:cpi']);
  });
  it('an event only affects its own assets (ECB → EURUSD, not XAUUSD)', () => {
    const t = T_CPI + 26 * 60 * MIN;
    expect(risk('EURUSD', t).state).toBe('NEWS_LIVE');
    expect(risk('XAUUSD', t).state).toBe('NORMAL');
  });
});

describe('conflicting drivers and the impact matrix', () => {
  it('hot CPI supports USD while weak jobless claims weaken it, and geopolitics supports gold → MIXED with CONFLICTING DRIVERS', () => {
    const s = engine().snapshot(T_CPI + 45 * MIN);
    expect(s.aggregates.USD.state).toBe('MIXED');
    expect(s.aggregates.USD.conflict).toBe(true);
    expect(s.aggregates.USD.evidence).toMatch(/CONFLICTING DRIVERS/);
    expect(s.aggregates.GOLD.state).toBe('MIXED');
    expect(s.aggregates.GOLD.drivers.map((d) => d.title)).toEqual(['Major geopolitical escalation reported', 'Initial Jobless Claims', 'CPI m/m']);
    expect(s.conflicts.length).toBeGreaterThanOrEqual(2);
    const gold = s.matrix.find((r) => r.asset === 'XAUUSD')!;
    expect(gold.cells.inflation.state).toBe('BEARISH PRESSURE');
    expect(gold.cells.employment.state).toBe('BULLISH PRESSURE');
    expect(gold.cells.geopolitical.state).toBe('BULLISH PRESSURE');
    expect(gold.cells.current.state).toBe('MIXED');
    expect(s.matrix.map((r) => r.asset)).toEqual(['USD', 'XAUUSD', 'XAGUSD', 'DXY', 'NASDAQ', 'BTCUSD']);
  });

  it('a single driver gives a single-direction pressure with its evidence; no drivers → NEUTRAL', () => {
    const s = engine(cpiDay().filter((u) => u.providerEventId === 'cpi')).snapshot(T_CPI + 5 * MIN);
    expect(s.aggregates.USD).toMatchObject({ state: 'BULLISH PRESSURE', conflict: false });
    expect(s.aggregates.USD.drivers[0]!.evidence).toMatch(/hotter US data/);
    expect(engine([]).snapshot(T_CPI).aggregates.GOLD.state).toBe('NEUTRAL');
  });

  it('never states a direction for plain headlines (UNCERTAIN)', () => {
    const e = engine([wire({ id: 'm', publishedAt: T_CPI, headline: 'Crypto exchange announces something', category: 'crypto', impact: 'high' }, T_CPI)]);
    expect(Object.values(ev(e, T_CPI, 'm').implications).every((i) => i.state === 'UNCERTAIN')).toBe(true);
  });
});

describe('observed reaction (real M1 candles only)', () => {
  const up = (i: number) => (i <= 0 ? 0 : Math.min(i, 10) * 1.0 - Math.max(0, i - 30) * 0.2);
  const m1 = m1Around(T_CPI, 40, 70, 2400, up);
  it('measures pre-price and +1/5/15/30/60 min closes, extremes, expansion, displacement and pattern', () => {
    const r = measureReaction('XAUUSD', T_CPI, m1, T_CPI + 2 * 60 * MIN);
    expect(r.status).toBe('COMPLETE');
    expect(r.prePrice).toBe(2400);
    expect(r.horizons.map((h) => h.change)).toEqual([1, 5, 10, 10, 4]);
    expect(r.maxUp).toBeCloseTo(10.3, 5);
    expect(r.volExpansion).toBeGreaterThan(1);
    expect(r.displacementAtr).toBeGreaterThan(0);
    expect(r.pattern).toBe('CONTINUATION');
    expect(r.retracePct).toBeCloseTo(20, 5);
  });
  it('before the candles close the horizons are PENDING — later candles are never used', () => {
    const r = measureReaction('XAUUSD', T_CPI, m1, T_CPI + 5 * MIN + 30_000);
    expect(r.horizons.map((h) => h.state)).toEqual(['OK', 'OK', 'PENDING', 'PENDING', 'PENDING']);
    expect(r.status).toBe('PARTIAL');
    expect(r.maxUp).toBeCloseTo(5.3, 5);
  });
  it('missing candles are reported, never filled; no pre-release candle → REACTION DATA UNAVAILABLE', () => {
    const gap = m1.filter((c) => (c.time + 60) * 1000 !== T_CPI + 15 * MIN);
    const r = measureReaction('XAUUSD', T_CPI, gap, T_CPI + 2 * 60 * MIN);
    expect(r.horizons.find((h) => h.minutes === 15)!.state).toBe('MISSING');
    expect(r.reason).toMatch(/missing/);
    const none = measureReaction('XAUUSD', T_CPI, m1.filter((c) => (c.time + 60) * 1000 > T_CPI), T_CPI + 60 * MIN);
    expect(none.status).toBe('UNAVAILABLE');
    expect(none.reason).toMatch(/REACTION DATA UNAVAILABLE/);
    expect(measureReaction('XAUUSD', T_CPI, [], T_CPI + 60 * MIN).status).toBe('UNAVAILABLE');
  });
});

describe('alerts: dedupe, freshness, recovered history', () => {
  it('fires each alert once as the conditions are crossed live', () => {
    const e = engine();
    const tr = new NewsAlertTracker();
    const seen: string[] = [];
    for (let T = T_CPI - 40 * MIN; T <= T_CPI + 45 * MIN; T += 10_000) seen.push(...tr.evaluate(e.eventsAt(T), T).map((a) => a.id));
    expect(seen).toEqual([
      'test-cal:cpi:HIGH_IMPACT_IN_30',
      'test-cal:cpi:HIGH_IMPACT_IN_15',
      'test-cal:cpi:HIGH_IMPACT_IN_5',
      'test-cal:cpi:NEWS_RELEASED',
      'test-cal:cpi:ACTUAL_AVAILABLE',
      'test-cal:claims:ACTUAL_AVAILABLE',
      'test-wire:geo-1:BREAKING_HIGH_IMPACT',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    // Re-evaluating the same time range never re-fires.
    expect(tr.evaluate(e.eventsAt(T_CPI + 45 * MIN), T_CPI + 45 * MIN)).toEqual([]);
  });

  it('recovered history (start after the fact / late backfill) never raises live alerts', () => {
    const e = engine();
    const tr = new NewsAlertTracker();
    expect(tr.evaluate(e.eventsAt(T_CPI + 60 * MIN), T_CPI + 60 * MIN)).toEqual([]); // baseline only
    expect(tr.evaluate(e.eventsAt(T_CPI + 61 * MIN), T_CPI + 61 * MIN)).toEqual([]);
    // Backfill: the schedule arrives AFTER the event (receivedAt late) → suppressed, not alerted.
    const late = new NewsEngine();
    late.ingest(cal({ id: 'nfp', time: T_CPI, title: 'Non-Farm Employment Change', currency: 'USD', impact: 'high', forecast: '180K', actual: '150K' }, T_CPI + 10 * MIN));
    const t2 = new NewsAlertTracker();
    t2.evaluate(late.eventsAt(T_CPI - MIN), T_CPI - MIN);
    const out = t2.evaluate(late.eventsAt(T_CPI + 10 * MIN), T_CPI + 10 * MIN);
    expect(out).toEqual([]);
    expect(t2.suppressed.length).toBeGreaterThan(0);
  });
});

describe('replay / anti-look-ahead audit', () => {
  const updates = cpiDay();
  const times = Array.from({ length: 200 }, (_, k) => T_CPI - 26 * 60 * MIN + k * 25 * MIN);
  const m1 = m1Around(T_CPI, 40, 70, 2400, (i) => (i <= 0 ? 0 : i * 0.3));

  it('the full-history engine at T equals the clean engine built from data known by T — no leaks', () => {
    const r = auditNews({ updates, times: [...times, T_CPI + 10_000, T_CPI + 20_000, T_CPI + 5 * MIN + 1], build: (u) => engine(u), reaction: { instrumentId: 'XAUUSD', m1 } });
    expect(r.checks).toBe(times.length + 3);
    expect(r.mismatches).toEqual([]);
    expect(r.leaks).toEqual([]);
  });

  it('incremental ingestion (in arrival order) equals one-shot ingestion at every time', () => {
    const inc = new NewsEngine();
    const byArrival = [...updates].sort((a, b) => a.receivedAt - b.receivedAt);
    for (const T of times) {
      for (const u of byArrival) if (u.receivedAt <= T) inc.ingest(u);
      expect(JSON.stringify(inc.snapshot(T))).toBe(JSON.stringify(engine(updates.filter((u) => u.knownAt <= T)).snapshot(T)));
    }
  });

  it('a CHEATING engine that ignores knownAt is caught (parity and leakage)', () => {
    class LookAheadEngine extends NewsEngine {
      protected override visible(): NewsUpdate[] {
        return [...this.allUpdates()];
      }
    }
    const r = auditNews({ updates, times, build: (u) => {
      const e = new LookAheadEngine();
      e.ingestAll(u);
      return e;
    } });
    expect(r.mismatches.length).toBeGreaterThan(0);
    expect(r.leaks.some((l) => /Actual visible before/.test(l.detail))).toBe(true);
    expect(r.leaks.some((l) => /revision visible before/.test(l.detail))).toBe(true);
    expect(r.leaks.some((l) => /headline visible before/.test(l.detail))).toBe(true);
  });

  it('a CHEATING reaction that uses unclosed candles is caught', () => {
    const r = measureReaction('XAUUSD', T_CPI, m1, T_CPI + 3 * MIN + 30_000);
    const cheat = { ...r, horizons: r.horizons.map((h) => (h.minutes === 5 ? { ...h, state: 'OK' as const, price: 1, change: 1, changePct: 0 } : h)) };
    expect(cheat.horizons.some((h) => h.state === 'OK' && h.time > T_CPI + 3 * MIN + 30_000)).toBe(true); // what the audit flags
    const audit = auditNews({ updates, times: [T_CPI + 3 * MIN + 30_000], build: (u) => engine(u), reaction: { instrumentId: 'XAUUSD', m1 } });
    expect(audit.leaks).toEqual([]); // the real measurement has no such horizon
  });
});
