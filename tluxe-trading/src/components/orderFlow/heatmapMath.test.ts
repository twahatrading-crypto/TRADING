import { describe, expect, it } from 'vitest';
import { DEFAULT_HEATMAP_VIEW } from '../../engines/orderFlow/config';
import type { HeatmapColumn } from '../../engines/orderFlow/engine';
import { bounds, colorAt, columnRows, intensity, percentile, smooth } from './heatmapMath';

const col = (bid: [number, number][], ask: [number, number][], valid = true): HeatmapColumn => ({
  t: 0,
  valid,
  bidTicks: Int32Array.from(bid.map((x) => x[0])),
  bidSizes: Float64Array.from(bid.map((x) => x[1])),
  askTicks: Int32Array.from(ask.map((x) => x[0])),
  askSizes: Float64Array.from(ask.map((x) => x[1])),
  bestBid: null,
  bestAsk: null,
  lastTick: null,
  trades: [],
  buy: 0,
  sell: 0,
  unknown: 0,
  cvd: 0,
});

describe('heatmap normalisation (render-only maths)', () => {
  it('percentile ignores zeros and is monotonic', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([0, 0, 0], 99)).toBe(0);
    const v = [10, 0, 20, 30, 40, 50];
    expect(percentile(v, 0)).toBe(10);
    expect(percentile(v, 100)).toBe(50);
    expect(percentile(v, 50)).toBe(30);
    expect(percentile(v, 60)).toBeLessThanOrEqual(percentile(v, 99));
  });

  it('intensity clamps to 0..1, applies cut-offs, contrast and min depth', () => {
    expect(intensity(0, 10, 100, 1, 1)).toBe(0);
    expect(intensity(5, 10, 100, 1, 1)).toBe(0); // below the lower cut-off
    expect(intensity(500, 10, 100, 1, 1)).toBe(1); // above the upper cut-off
    expect(intensity(55, 10, 100, 1, 1)).toBeCloseTo(0.5);
    expect(intensity(55, 10, 100, 2, 1)).toBeCloseTo(0.25);
    expect(intensity(55, 10, 100, 1, 60)).toBe(0); // under min depth
    expect(intensity(10, 10, 10, 1, 1)).toBe(1); // degenerate range
  });

  it('colorAt: 0 is the background, 1 the hottest stop, every scheme in range', () => {
    expect(colorAt(0, 'blue-red')).toEqual([8, 14, 32]);
    expect(colorAt(1, 'blue-red')).toEqual([239, 68, 68]);
    expect(colorAt(2, 'blue-red')).toEqual([239, 68, 68]);
    for (const s of ['blue-red', 'mono', 'thermal'] as const)
      for (let x = 0; x <= 1; x += 0.05) for (const c of colorAt(x, s)) expect(c >= 0 && c <= 255).toBe(true);
  });

  it('columnRows sums bid + ask sizes into price rows, with price aggregation', () => {
    const c = col([[100, 5], [101, 7]], [[102, 3], [110, 9]]);
    expect([...columnRows(c, 100, 4, 1)]).toEqual([5, 7, 3, 0]);
    expect([...columnRows(c, 100, 2, 2)]).toEqual([12, 3]);
  });

  it('smooth(0) is the identity; smoothing preserves the total over the interior', () => {
    const r = Float64Array.from([0, 0, 9, 0, 0]);
    expect(smooth(r, 0)).toBe(r);
    expect([...smooth(r, 1)]).toEqual([0, 3, 3, 3, 0]);
  });

  it('bounds use only valid columns; auto-normalise uses the visible window', () => {
    const a = col([[1, 10]], [[2, 20]]);
    const b = col([[1, 1000]], [[2, 2000]]);
    const bad = col([[1, 999999]], [], false);
    const all = [a, b, bad];
    const auto = bounds(all, { ...DEFAULT_HEATMAP_VIEW, autoNormalize: true, lowerCutoff: 0, upperCutoff: 100 }, [a, bad]);
    expect(auto).toEqual({ lo: 10, hi: 20 });
    const fixed = bounds(all, { ...DEFAULT_HEATMAP_VIEW, autoNormalize: false, lowerCutoff: 0, upperCutoff: 100 }, [a]);
    expect(fixed).toEqual({ lo: 10, hi: 2000 });
  });

  it('never mutates the columns it reads', () => {
    const c = col([[1, 10]], [[2, 20]]);
    const before = JSON.stringify([...c.bidSizes, ...c.askSizes]);
    columnRows(c, 0, 5, 1);
    bounds([c], DEFAULT_HEATMAP_VIEW, [c]);
    expect(JSON.stringify([...c.bidSizes, ...c.askSizes])).toBe(before);
  });
});
