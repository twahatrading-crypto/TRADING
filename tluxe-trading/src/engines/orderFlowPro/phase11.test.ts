import { describe, expect, it } from 'vitest';
import { spreadLabels, topKThreshold } from '../../components/orderFlowPro/ofpLayout';
import { scheduleLabel } from '../../components/orderFlowPro/ofpFormat';
import { bandTier, DepthRecorder } from './depthRecorder';
import { globexSchedule, nyToUtc } from './nyTime';

const book = (t: number, bids: Array<[number, number]>, asks: Array<[number, number]>) => ({ kind: 'book' as const, t, bids, asks });

describe('observed strong bands (never fabricated)', () => {
  it('a large resting level becomes a band only over the recorded columns where it was seen', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applySnapshot(book(0, [[10, 5], [9, 5], [8, 60]], [[11, 5], [12, 5], [13, 5]]));
    r.applyLevel({ kind: 'depth', t: 60_000, side: 'BID', price: 8, size: 0 }); // pulled after 60 s
    r.integrate(100_000);
    const bands = r.strongBands(0, 100_000, { minRelative: 2.2, minColumns: 4 });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ tick: 8, side: 'BID', from: 0, to: 60_000 });
    expect(bands[0]!.meanRelative).toBeCloseTo(12, 5);
  });

  it('a gap ends the band; nothing is painted across it', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applySnapshot(book(0, [[10, 5], [9, 5], [8, 60]], [[11, 5]]));
    r.applyGap({ kind: 'gap', from: 50_000, to: 120_000, reason: 'test' });
    r.applySnapshot(book(120_000, [[10, 5], [9, 5], [8, 60]], [[11, 5]]));
    r.integrate(200_000);
    const bands = r.strongBands(0, 200_000, { minRelative: 2.2, minColumns: 4 });
    expect(bands.map((b) => [b.from, b.to])).toEqual([
      [0, 50_000],
      [120_000, 200_000],
    ]);
  });

  it('short-lived levels do not qualify', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applySnapshot(book(0, [[10, 5], [9, 5], [8, 60]], [[11, 5]]));
    r.applyLevel({ kind: 'depth', t: 20_000, side: 'BID', price: 8, size: 0 });
    r.integrate(100_000);
    expect(r.strongBands(0, 100_000, { minRelative: 2.2, minColumns: 4 })).toEqual([]);
  });

  it('tiers: cyan < green < yellow < white', () => {
    expect([2.3, 3.5, 5, 7].map(bandTier)).toEqual(['cyan', 'green', 'yellow', 'white']);
  });
});

describe('Liquidity Strength observations', () => {
  it('coverage = valid recorded book time over the lookback; presence per level', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applySnapshot(book(0, [[10, 5], [9, 5], [8, 40]], [[11, 5]]));
    r.applyLevel({ kind: 'depth', t: 30_000, side: 'BID', price: 9, size: 0 });
    r.applyGap({ kind: 'gap', from: 60_000, to: 90_000, reason: 'test' });
    r.applySnapshot(book(90_000, [[10, 5], [8, 40]], [[11, 5]]));
    r.integrate(120_000);
    const cov = r.coverage(120_000, 120_000);
    expect(cov.validMs).toBe(90_000);
    expect(cov.share).toBeCloseTo(0.75, 5);
    const lv = r.observedLevels(120_000, { minRelative: 2.5, minPersistMs: 20_000, lookbackMs: 120_000 });
    const at = (side: string, price: number) => lv.find((l) => l.side === side && l.price === price)!;
    expect(at('BID', 10).coverage).toBe(1);
    expect(at('BID', 8)).toMatchObject({ size: 40, strong: true, persistMs: 30_000 });
    expect(at('BID', 8).historicalAvg).toBeCloseTo(40, 5);
    expect(lv[0]!.price).toBe(8); // ranked by relative strength
  });

  it('no valid book -> nothing observed', () => {
    const r = new DepthRecorder(1, 10_000);
    expect(r.observedLevels(0, { minRelative: 2.5, minPersistMs: 0, lookbackMs: 60_000 })).toEqual([]);
    expect(r.coverage(60_000, 60_000)).toMatchObject({ validMs: 0, share: 0, firstRecorded: null });
  });
});

describe('session schedule labels (never "market open")', () => {
  it('Globex weekly schedule: Sun 18:00 ET -> Fri 17:00 ET with a daily 17:00-18:00 break', () => {
    expect(globexSchedule(nyToUtc(2026, 10, 14, 10, 0))).toBe('IN_SCHEDULE'); // Wed
    expect(globexSchedule(nyToUtc(2026, 10, 14, 17, 30))).toBe('DAILY_BREAK');
    expect(globexSchedule(nyToUtc(2026, 10, 16, 17, 30))).toBe('WEEKEND'); // Fri after close
    expect(globexSchedule(nyToUtc(2026, 10, 17, 12, 0))).toBe('WEEKEND'); // Sat
    expect(globexSchedule(nyToUtc(2026, 10, 18, 17, 59))).toBe('WEEKEND'); // Sun before open
    expect(globexSchedule(nyToUtc(2026, 10, 18, 18, 0))).toBe('IN_SCHEDULE');
  });
  it('labels describe the schedule only', () => {
    for (const s of ['IN_SCHEDULE', 'DAILY_BREAK', 'WEEKEND'] as const) expect(scheduleLabel(s).text).not.toMatch(/market open|\bopen\b/i);
  });
});

describe('label layout and adaptive bubbles', () => {
  it('spreads overlapping labels to the minimum gap, inside bounds, keeping order', () => {
    const ys = spreadLabels([100, 104, 98], 20, 0, 500);
    const sorted = [...ys].sort((a, b) => a - b);
    expect(sorted[1]! - sorted[0]!).toBeGreaterThanOrEqual(20);
    expect(sorted[2]! - sorted[1]!).toBeGreaterThanOrEqual(20);
    expect(ys[2]).toBeLessThan(ys[0]!); // 98 stays above 100
    const bottom = spreadLabels([495, 498], 20, 0, 500);
    expect(Math.max(...bottom)).toBeLessThanOrEqual(500);
  });
  it('top-K threshold limits the number of bubbles', () => {
    const v = [1, 9, 3, 7, 5];
    expect(v.filter((x) => x >= topKThreshold(v, 2))).toEqual([9, 7]);
    expect(topKThreshold(v, 10)).toBe(1);
    expect(topKThreshold([], 3)).toBe(Infinity);
  });
});
