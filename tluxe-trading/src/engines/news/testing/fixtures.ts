/**
 * TEST DATA ONLY — synthetic provider payloads for unit tests and the bannered dev harness.
 * Never used in production (the registry refuses test providers). Titles are generic indicator
 * names; values are invented and clearly not market data.
 */
import type { NewsProviderInfo, RawCalendarEvent, RawHeadline } from '../../../providers/news/types';
import type { Candle } from '../../../types/market';
import { normalizeCalendar, normalizeHeadline } from '../normalize';
import type { NewsUpdate } from '../types';

export const MIN = 60_000;
/** Tue 2026-01-13 13:30:00Z (08:30 New York, 06:30 Denver). */
export const T_CPI = Date.UTC(2026, 0, 13, 13, 30);

export const CAL_INFO: NewsProviderInfo = { id: 'test-cal', name: 'TEST DATA calendar', kind: 'calendar', latency: 'REALTIME', delaySec: null, staleAfterMs: 5 * MIN, test: true };
export const CAL_INFO_B: NewsProviderInfo = { ...CAL_INFO, id: 'test-cal-b', name: 'TEST DATA calendar B' };
export const WIRE_INFO: NewsProviderInfo = { id: 'test-wire', name: 'TEST DATA wire', kind: 'breaking', latency: 'DELAYED', delaySec: 60, staleAfterMs: 5 * MIN, test: true };

export const cal = (e: RawCalendarEvent, receivedAt: number, info = CAL_INFO): NewsUpdate => normalizeCalendar(e, info, receivedAt)!;
export const wire = (h: RawHeadline, receivedAt: number, info = WIRE_INFO): NewsUpdate => normalizeHeadline(h, info, receivedAt)!;

/** A realistic sequence: schedule known a day ahead, actual arrives 20 s after release, later revision. */
export function cpiDay(actual = '0.4%'): NewsUpdate[] {
  const sched = T_CPI - 24 * 60 * MIN;
  return [
    cal({ id: 'cpi', time: T_CPI, title: 'CPI m/m', country: 'US', currency: 'USD', impact: 'high', forecast: '0.3%', previous: '0.2%' }, sched),
    cal({ id: 'claims', time: T_CPI, title: 'Initial Jobless Claims', country: 'US', currency: 'USD', impact: 'medium', forecast: '220K', previous: '215K' }, sched),
    cal({ id: 'cpi', time: T_CPI, title: 'CPI m/m', country: 'US', currency: 'USD', impact: 'high', forecast: '0.3%', previous: '0.2%', actual }, T_CPI + 20_000),
    cal({ id: 'claims', time: T_CPI, title: 'Initial Jobless Claims', country: 'US', currency: 'USD', impact: 'medium', forecast: '220K', previous: '215K', actual: '240K' }, T_CPI + 25_000),
    // Next month's schedule revises last month's Previous (known only from this later time).
    cal({ id: 'cpi', time: T_CPI, title: 'CPI m/m', country: 'US', currency: 'USD', impact: 'high', forecast: '0.3%', previous: '0.1%', actual }, T_CPI + 3 * 24 * 60 * MIN),
    wire({ id: 'geo-1', publishedAt: T_CPI + 40 * MIN, headline: 'Major geopolitical escalation reported', category: 'geopolitical', impact: 'high' }, T_CPI + 40 * MIN + 5_000),
    wire({ id: 'metals-1', publishedAt: T_CPI - 3 * 60 * MIN, headline: 'Exchange raises metals margin requirements', category: 'metals', impact: 'medium' }, T_CPI - 3 * 60 * MIN + 4_000),
    cal({ id: 'fomc', time: T_CPI + 2 * 24 * 60 * MIN, title: 'FOMC Rate Decision', country: 'US', currency: 'USD', impact: 'high', forecast: '4.50%', previous: '4.50%' }, sched),
    cal({ id: 'ecb', time: T_CPI + 26 * 60 * MIN, title: 'ECB Main Refinancing Rate', country: 'EU', currency: 'EUR', forecast: '2.15%', previous: '2.15%' }, sched),
  ];
}

/** Deterministic M1 candles around a time (TEST DATA). `shape(i)` = close offset from `base`. */
export function m1Around(centerMs: number, before: number, after: number, base: number, shape: (i: number) => number): Candle[] {
  const start = Math.floor(centerMs / 1000 / 60) * 60 - before * 60;
  const out: Candle[] = [];
  let prev = base + shape(-before);
  for (let k = 0; k < before + after; k++) {
    const i = k - before;
    const close = Number((base + shape(i + 1)).toFixed(2));
    out.push({ time: start + k * 60, open: prev, high: Math.max(prev, close) + 0.3, low: Math.min(prev, close) - 0.3, close, volume: null, isClosed: true });
    prev = close;
  }
  return out;
}
