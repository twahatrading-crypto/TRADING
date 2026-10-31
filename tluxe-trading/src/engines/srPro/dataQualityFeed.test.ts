/** TEST DATA ONLY: synthetic daily volume series and bar times for the quality filter and feed labels. */
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { assessQuality } from './dataQuality';
import { feedStatus } from './feedState';

const DAY = 86_400;
const T0 = Date.parse('2026-01-05T00:00:00Z') / 1000;
const d1 = (vols: number[]): Candle[] => vols.map((v, i) => ({ time: T0 + i * DAY, open: 1, high: 1, low: 1, close: 1, volume: v, isClosed: true }) as Candle);

describe('contract liquidity quality', () => {
  it('finds the start of the liquid regime (thin back-month, then active)', () => {
    const q = assessQuality(d1([...Array(60).fill(3), ...Array(40).fill(120_000)]), undefined);
    expect(q.state).toBe('OK');
    expect(q.activeSince).toBe(T0 + 60 * DAY);
    expect(q.thinDays).toBe(60);
    expect(q.stable).toBe(true);
    expect(q.perThreshold.map((p) => p.activeSinceDay)).toEqual(['2026-03-06', '2026-03-06', '2026-03-06']);
  });

  it('isolated thin days (holidays, half days) do not cut the regime', () => {
    const vols = Array(50).fill(100_000);
    vols[20] = 900;
    vols[35] = 1_000;
    vols[36] = 1_200;
    const q = assessQuality(d1(vols), undefined);
    expect(q.activeSince).toBeNull();
    expect(q.explanation).toMatch(/no thin history/);
  });

  it('a gradual ramp is resolved conservatively and flagged when thresholds disagree', () => {
    // 6% → 12% → 25% of the final volume over three 15-day blocks, then fully active.
    const vols = [...Array(15).fill(6_000), ...Array(15).fill(12_000), ...Array(15).fill(25_000), ...Array(25).fill(100_000)];
    const q = assessQuality(d1(vols), undefined);
    expect(q.perThreshold.map((p) => p.activeSinceDay)).toEqual(['2026-01-05', '2026-01-20', '2026-02-04']);
    expect(q.activeSinceDay).toBe('2026-02-04'); // the latest = most conservative
    expect(q.stable).toBe(false);
    expect(q.explanation).toMatch(/ambiguous/);
  });

  it('insufficient or missing volume never invents a cut-off', () => {
    expect(assessQuality(d1([5, 6, 7]), undefined)).toMatchObject({ state: 'INSUFFICIENT_DATA', activeSince: null });
    expect(assessQuality(undefined, undefined)).toMatchObject({ state: 'NO_VOLUME', activeSince: null });
  });

  it('falls back to H1 summed per CME session day', () => {
    const h1: Candle[] = [];
    for (let day = 0; day < 30; day++) for (let h = 0; h < 23; h++) h1.push({ time: T0 + day * DAY + h * 3600, open: 1, high: 1, low: 1, close: 1, volume: day < 10 ? 1 : 5_000, isClosed: true } as Candle);
    const q = assessQuality(undefined, h1);
    expect(q.source).toBe('H1');
    expect(q.activeSince).not.toBeNull();
  });
});

describe('feed label', () => {
  const t = (iso: string) => Date.parse(iso) / 1000;
  it('LIVE / STALE / MARKET CLOSED / OFFLINE / NO DATA / CALENDAR EXPIRED', () => {
    expect(feedStatus({ now: t('2026-10-30T14:01:30Z'), newestBarTime: t('2026-10-30T14:00:00Z'), newestBarSeconds: 60, connected: true }).state).toBe('LIVE');
    expect(feedStatus({ now: t('2026-10-30T14:20:00Z'), newestBarTime: t('2026-10-30T14:00:00Z'), newestBarSeconds: 60, connected: true }).state).toBe('STALE');
    const closed = feedStatus({ now: t('2026-10-31T07:51:00Z'), newestBarTime: t('2026-10-30T20:59:00Z'), newestBarSeconds: 60, connected: true });
    expect(closed).toMatchObject({ state: 'MARKET_CLOSED', current: false });
    expect(closed.detail).toMatch(/Saturday.*last bar 2026-10-30 20:59 UTC/);
    expect(feedStatus({ now: t('2026-10-30T14:01:00Z'), newestBarTime: t('2026-10-30T14:00:00Z'), newestBarSeconds: 60, connected: false }).state).toBe('OFFLINE');
    expect(feedStatus({ now: 0, newestBarTime: null, newestBarSeconds: 60, connected: true }).state).toBe('NO_DATA');
    expect(feedStatus({ now: t('2027-01-05T15:00:00Z'), newestBarTime: t('2026-12-31T15:00:00Z'), newestBarSeconds: 60, connected: true }).state).toBe('CALENDAR_EXPIRED');
  });
  it('a bar received in a scheduled-closed minute is still LIVE (data outranks the calendar)', () => {
    expect(feedStatus({ now: t('2026-11-27T18:31:00Z'), newestBarTime: t('2026-11-27T18:30:00Z'), newestBarSeconds: 60, connected: true }).state).toBe('LIVE');
  });
});
