/** TEST BARS ONLY: deterministic offline fixtures for the level arithmetic — never shown as market data. */
import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../../types/market';
import { dayBounds, sessionDate } from './cmeCalendar';
import { asiaWindow, computeKeyLevels, levelUsable, windowLabel, type BarsByTf } from './keyLevels';

const t = (isoUtc: string) => Date.parse(isoUtc) / 1000;
const lvl = (r: ReturnType<typeof computeKeyLevels>, k: string) => r.levels.find((l) => l.kind === k)!;

/** H1 bars covering every CME session hour from `fromDate` to `toDate` (inclusive), price = base + hour index. */
function sessionBars(dates: string[], step: number, priceAt: (time: number) => number, skip?: (time: number) => boolean): Candle[] {
  const out: Candle[] = [];
  for (const d of dates) {
    const b = dayBounds(d);
    for (let s = b.start; s < b.end; s += step) {
      if (skip?.(s)) continue;
      const p = priceAt(s);
      out.push({ time: s, open: p, high: p + 1, low: p - 1, close: p, volume: 100, isClosed: true } as Candle);
    }
  }
  return out;
}

const WEEK1 = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const WEEK2 = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];

describe('Asia windows (exact boundaries, DST)', () => {
  it('CME desk Asia = 18:00–03:00 New York; Tokyo = 09:00–18:00 Tokyo', () => {
    expect(asiaWindow('2026-10-30', 'cme-asia')).toEqual({ from: t('2026-10-29T22:00:00Z'), to: t('2026-10-30T07:00:00Z') });
    expect(asiaWindow('2026-11-02', 'cme-asia')).toEqual({ from: t('2026-11-01T23:00:00Z'), to: t('2026-11-02T08:00:00Z') }); // EST
    expect(asiaWindow('2026-10-30', 'tokyo')).toEqual({ from: t('2026-10-30T00:00:00Z'), to: t('2026-10-30T09:00:00Z') });
    expect(windowLabel(t('2026-10-29T22:00:00Z'), t('2026-10-30T07:00:00Z'))).toBe('Thu 29 Oct 18:00 ET → Fri 30 Oct 03:00 ET (22:00–07:00 UTC)');
  });
});

describe('PDH / PDL / PWH / PWL / Asia from real-shaped session bars', () => {
  // Price encodes the session date so each level is attributable.
  const dayPrice = (s: number) => 4000 + Number(sessionDate(s).slice(8)) * 10;
  const bars: BarsByTf = { H1: sessionBars([...WEEK1, ...WEEK2], 3600, dayPrice) };
  const r = computeKeyLevels(bars, 'cme-asia');

  it('previous day = Thursday 29 Oct when the newest bar is Friday', () => {
    expect(r.stats.sessionDate).toBe('2026-10-30');
    expect(lvl(r, 'PDH')).toMatchObject({ price: 4291, status: 'COMPLETE', sourceTf: 'H1' });
    expect(lvl(r, 'PDL')).toMatchObject({ price: 4289 });
    expect(lvl(r, 'PDH').windowLabel).toBe('Wed 28 Oct 18:00 ET → Thu 29 Oct 17:00 ET (22:00–21:00 UTC)');
  });

  it('previous week = 19–23 Oct', () => {
    expect(lvl(r, 'PWH')).toMatchObject({ price: 4231, status: 'COMPLETE' });
    expect(lvl(r, 'PWL')).toMatchObject({ price: 4189 });
  });

  it("Asia = Friday's 18:00–03:00 ET window, complete", () => {
    expect(lvl(r, 'ASIA_HIGH')).toMatchObject({ price: 4301, status: 'COMPLETE' });
  });

  it('day open / range and ADR need complete days', () => {
    expect(r.stats.dayOpen).toBe(4300);
    expect(r.stats.adr).toBeNull(); // only 9 complete prior days < 70% of 14
    expect(r.stats.adrNote).toMatch(/Only 9/);
  });

  it('prefers the finest timeframe that covers the window', () => {
    const fine = sessionBars(['2026-10-29', '2026-10-30'], 300, dayPrice);
    const r2 = computeKeyLevels({ ...bars, M5: fine }, 'cme-asia');
    expect(lvl(r2, 'PDH').sourceTf).toBe('M5');
    expect(lvl(r2, 'PWH').sourceTf).toBe('H1'); // M5 does not reach back to the previous week
  });
});

describe('coverage failures are flagged, never silently used', () => {
  it('a data gap inside the previous day makes PDH INCOMPLETE_DATA', () => {
    const gap = (s: number) => s >= t('2026-10-29T10:00:00Z') && s < t('2026-10-29T15:00:00Z');
    const r = computeKeyLevels({ H1: sessionBars(WEEK2, 3600, () => 4000, gap) }, 'cme-asia');
    expect(lvl(r, 'PDH').status).toBe('INCOMPLETE_DATA');
    expect(lvl(r, 'PDH').note).toMatch(/gap/);
    expect(levelUsable(lvl(r, 'PDH'))).toBe(false);
  });

  it('a hole in fine data falls back to a coarser series that covers the window (reason kept)', () => {
    const gap = (s: number) => s >= t('2026-10-28T22:00:00Z') && s < t('2026-10-29T18:00:00Z');
    const r = computeKeyLevels({ M5: sessionBars(WEEK2, 300, () => 4000, gap), H1: sessionBars(WEEK2, 3600, () => 4000) }, 'cme-asia');
    expect(lvl(r, 'PDH')).toMatchObject({ status: 'COMPLETE', sourceTf: 'H1' });
    expect(lvl(r, 'PDH').note).toMatch(/H1 used — M5: first M5 bar 1200 min after the window start/);
  });

  it('a holiday is skipped, not treated as missing data', () => {
    const r = computeKeyLevels({ H1: sessionBars(['2026-11-24', '2026-11-25', '2026-11-27'], 3600, () => 4000) }, 'cme-asia');
    expect(r.stats.sessionDate).toBe('2026-11-27');
    expect(lvl(r, 'PDH')).toMatchObject({ status: 'COMPLETE', windowLabel: expect.stringContaining('Wed 25 Nov 17:00 ET') });
  });

  it('a forming Asia window is FORMING', () => {
    const b = sessionBars(['2026-10-29'], 3600, () => 4000);
    const fri = asiaWindow('2026-10-30', 'cme-asia');
    for (let s = fri.from; s < fri.from + 3 * 3600; s += 3600) b.push({ time: s, open: 4010, high: 4012, low: 4008, close: 4010, volume: 5, isClosed: true } as Candle);
    const r = computeKeyLevels({ H1: b }, 'cme-asia');
    expect(lvl(r, 'ASIA_HIGH')).toMatchObject({ status: 'FORMING', price: 4012 });
  });

  it('no bars → empty result', () => {
    expect(computeKeyLevels({} as Record<Timeframe, Candle[]>, 'tokyo').levels).toEqual([]);
  });
});
