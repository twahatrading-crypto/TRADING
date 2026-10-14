import { describe, expect, it } from 'vitest';
import { fmtQty, fmtRest, laneLabelSlots, spreadLabels } from './ofpLayout';

describe('liquidity lane label slots', () => {
  it('keeps labels inside the lane, at least `gap` apart, in priority order', () => {
    const ys = [100, 101, 102, 400, 99];
    const s = laneLabelSlots(ys, 30, 56, 500);
    const placed = s.filter((v): v is number => v !== null).sort((a, b) => a - b);
    expect(placed).toHaveLength(5);
    for (let i = 1; i < placed.length; i++) expect(placed[i]! - placed[i - 1]!).toBeGreaterThanOrEqual(30);
    for (const y of placed) {
      expect(y).toBeGreaterThanOrEqual(56);
      expect(y).toBeLessThanOrEqual(500);
    }
  });
  it('labels that do not fit are dropped (null), never stacked: the first (most important) are kept', () => {
    const ys = Array.from({ length: 12 }, (_, i) => 200 + i);
    const s = laneLabelSlots(ys, 30, 56, 176); // room for 5
    expect(s.slice(0, 5).every((v) => v !== null)).toBe(true);
    expect(s.slice(5).every((v) => v === null)).toBe(true);
    const kept = s.filter((v): v is number => v !== null);
    expect(new Set(kept).size).toBe(kept.length);
  });
  it('no room -> nothing placed', () => {
    expect(laneLabelSlots([10, 20], 30, 100, 50)).toEqual([null, null]);
  });
  it('spreadLabels is unchanged for existing callers', () => {
    expect(spreadLabels([10, 12], 16, 8, 100)).toEqual([10, 26]);
  });
});

describe('formatting', () => {
  it('resting time and contracts', () => {
    expect(fmtRest(45_400)).toBe('45s');
    expect(fmtRest(250_000)).toBe('4m 10s');
    expect(fmtRest(3_900_000)).toBe('1h 05m');
    expect(fmtQty(12)).toBe('12');
    expect(fmtQty(5.43)).toBe('5.4');
  });
});
