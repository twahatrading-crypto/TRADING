import { describe, expect, it } from 'vitest';
import { NewsEngine } from '../../engines/news/engine';
import { MIN, T_CPI, cal } from '../../engines/news/testing/fixtures';
import { measureReaction } from '../../engines/news/reaction';
import { m1Around } from '../../engines/news/testing/fixtures';
import { filterCalendar, reactionOverlay, timelineOf } from './newsView';

/* TEST DATA ONLY. */
const e = new NewsEngine();
e.ingestAll([
  cal({ id: 'a', time: T_CPI, title: 'CPI m/m', currency: 'USD', impact: 'high', forecast: '0.3%' }, T_CPI - 3 * 24 * 60 * MIN),
  cal({ id: 'b', time: T_CPI + 24 * 60 * MIN, title: 'Retail Sales m/m', currency: 'USD', impact: 'medium' }, T_CPI - 3 * 24 * 60 * MIN),
  cal({ id: 'c', time: T_CPI + 2 * 24 * 60 * MIN, title: 'ECB Main Refinancing Rate', currency: 'EUR' }, T_CPI - 3 * 24 * 60 * MIN),
  cal({ id: 'd', time: T_CPI + 7 * 24 * 60 * MIN, title: 'CPI m/m', currency: 'USD', impact: 'high' }, T_CPI - 3 * 24 * 60 * MIN),
]);
const now = T_CPI - 60 * MIN; // Tue 12:30 UTC
const ids = (range: 'TODAY' | 'TOMORROW' | 'WEEK' | 'ALL', impact: 'ALL' | 'HIGH' | 'MEDIUM' | 'LOW' = 'ALL', currency: 'ALL' | 'USD' | 'EUR' = 'ALL', tz = 'UTC') =>
  filterCalendar(e.snapshot(now).calendar, { range, impact, currency, now, tz }).map((x) => x.providerEventId);

describe('calendar filters (display time zone)', () => {
  it('today / tomorrow / this week / all', () => {
    expect(ids('TODAY')).toEqual(['a']);
    expect(ids('TOMORROW')).toEqual(['b']);
    expect(ids('WEEK')).toEqual(['a', 'b', 'c']);
    expect(ids('ALL')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('impact and currency filters', () => {
    expect(ids('ALL', 'HIGH')).toEqual(['a', 'c', 'd']); // ECB rate decision = HIGH by indicator rule
    expect(ids('ALL', 'ALL', 'EUR')).toEqual(['c']);
  });
  it('day boundaries follow the chosen zone (Tokyo is already on the next day)', () => {
    expect(ids('TODAY', 'ALL', 'ALL', 'Asia/Tokyo')).toEqual(['a']);
    expect(ids('TODAY', 'ALL', 'ALL', 'Pacific/Honolulu')).toEqual(['a']);
  });
});

describe('timeline and reaction marks', () => {
  it('timeline is chronological and marks only what happened', () => {
    const ev = e.snapshot(T_CPI + 10 * MIN).calendar.find((x) => x.providerEventId === 'a')!;
    const r = measureReaction('XAUUSD', T_CPI, m1Around(T_CPI, 30, 20, 2400, (i) => Math.max(0, i)), T_CPI + 10 * MIN);
    const steps = timelineOf(ev, r, T_CPI + 10 * MIN);
    const t = steps.map((s) => s.time ?? Infinity);
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(steps.find((s) => s.label === '+15 m reaction')!.done).toBe(false);
    expect(steps.find((s) => s.label === '+5 m reaction')!.done).toBe(true);
    const ov = reactionOverlay(r, T_CPI, 2);
    expect(ov.markers[0]!.text).toBe('RELEASE');
    expect(ov.markers.filter((m) => m.text.startsWith('+'))).toHaveLength(2);
    expect(reactionOverlay({ ...r, status: 'UNAVAILABLE' }, T_CPI, 2)).toEqual({ markers: [], lines: [] });
  });
});
