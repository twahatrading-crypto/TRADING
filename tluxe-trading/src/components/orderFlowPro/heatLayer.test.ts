import { describe, expect, it } from 'vitest';
import { cellVisible, columnAt, DEFAULT_HEAT_FILTERS, HEAT_RGB, heatColor, heatTier, hoverAt, type HeatColumn, type HeatTiers } from './heatLayer';

const T: HeatTiers = { medium: 4, strong: 6, veryStrong: 9 };
const col = (t: number, cells: HeatColumn['cells'], dt = 15_000, source: HeatColumn['source'] = 'RECORDED'): HeatColumn => ({ t, dt, validMs: dt, cells, source });

describe('heat tiers (same p75 / p90 / p97 reference as STRONG / MEDIUM)', () => {
  it('maps displayed contracts to WEAK / MEDIUM / STRONG / VERY STRONG', () => {
    expect(heatTier(1, T)).toBe('WEAK');
    expect(heatTier(4, T)).toBe('MEDIUM');
    expect(heatTier(6, T)).toBe('STRONG');
    expect(heatTier(9, T)).toBe('VERY_STRONG');
  });
  it('colours: dark blue -> cyan -> gold -> bright yellow, alpha rising with strength', () => {
    const weak = heatColor(3.9, T);
    const med = heatColor(4, T);
    const strong = heatColor(6, T);
    const very = heatColor(9, T);
    expect(med.rgb).toEqual([...HEAT_RGB.MEDIUM]);
    expect(strong.rgb).toEqual([...HEAT_RGB.STRONG]);
    expect(very.rgb).toEqual([...HEAT_RGB.VERY_STRONG]);
    expect(weak.rgb[2]).toBeGreaterThan(weak.rgb[0]); // blue
    expect(weak.alpha).toBeLessThan(med.alpha);
    expect(med.alpha).toBeLessThan(strong.alpha);
    expect(strong.alpha).toBeLessThan(very.alpha);
  });
  it('smooth: colours interpolate inside a tier', () => {
    const a = heatColor(6.5, T).rgb;
    const b = heatColor(8.5, T).rgb;
    expect(a).not.toEqual(b);
    expect(b[1]).toBeGreaterThan(a[1]); // towards bright yellow
  });
  it('intensity (gain) changes the picture, never the tier', () => {
    expect(heatColor(3, T, 2).rgb).toEqual(heatColor(6, T, 1).rgb);
    expect(heatTier(3, T)).toBe('WEAK');
  });
});

describe('filters', () => {
  it('BID / ASK / strong-only', () => {
    const bid = { tick: 1, side: 'BID' as const, avg: 5 };
    const ask = { tick: 1, side: 'ASK' as const, avg: 7 };
    expect(cellVisible(bid, DEFAULT_HEAT_FILTERS, T)).toBe(true);
    expect(cellVisible(bid, { ...DEFAULT_HEAT_FILTERS, bid: false }, T)).toBe(false);
    expect(cellVisible(ask, { ...DEFAULT_HEAT_FILTERS, ask: false }, T)).toBe(false);
    expect(cellVisible(bid, { ...DEFAULT_HEAT_FILTERS, strongOnly: true }, T)).toBe(false);
    expect(cellVisible(ask, { ...DEFAULT_HEAT_FILTERS, strongOnly: true }, T)).toBe(true);
  });
});

describe('hover: side, contracts, tier, time, observed run (never across a gap, never an order count)', () => {
  const cols = [
    col(0, [{ tick: 42000, side: 'BID', avg: 7 }]),
    col(15_000, [{ tick: 42000, side: 'BID', avg: 7.5 }, { tick: 42001, side: 'ASK', avg: 3 }]),
    col(30_000, [{ tick: 42000, side: 'BID', avg: 6 }]),
    // gap: 45_000..60_000 has no recorded column
    col(60_000, [{ tick: 42000, side: 'BID', avg: 9 }]),
  ];
  it('finds the column by time', () => {
    expect(columnAt(cols, 16_000)).toBe(1);
    expect(columnAt(cols, 50_000)).toBe(-1);
  });
  it('reports BID / contracts / tier / span; the observed run stops at the gap', () => {
    const h = hoverAt(cols, 16_000, 42000, T, DEFAULT_HEAT_FILTERS)!;
    expect(h.cells).toEqual([{ side: 'BID', avg: 7.5, tier: 'STRONG' }]);
    expect(h.t).toBe(15_000);
    expect(h.dt).toBe(15_000);
    expect(h.source).toBe('RECORDED');
    expect(h.observedMs).toBe(45_000); // 0..45 s, not bridged to 60 s
    expect(Object.keys(h).join(' ')).not.toMatch(/order/i);
    expect(hoverAt(cols, 61_000, 42000, T, DEFAULT_HEAT_FILTERS)!.observedMs).toBe(15_000);
  });
  it('ASK side is reported as ASK; filtered-out sides are not hovered', () => {
    expect(hoverAt(cols, 16_000, 42001, T, DEFAULT_HEAT_FILTERS)!.cells[0]).toMatchObject({ side: 'ASK', tier: 'WEAK' });
    expect(hoverAt(cols, 16_000, 42001, T, { ...DEFAULT_HEAT_FILTERS, ask: false })).toBeNull();
  });
});
