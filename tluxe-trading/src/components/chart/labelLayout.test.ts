import { describe, expect, it } from 'vitest';
import { layoutLabels } from './labelLayout';

describe('layoutLabels', () => {
  it('keeps non-overlapping labels at their preferred position', () => {
    const out = layoutLabels([{ id: 'a', y: 50, height: 20, priority: 1 }, { id: 'b', y: 200, height: 20, priority: 1 }], 400);
    expect(out.find((l) => l.id === 'a')!.top).toBe(40);
    expect(out.find((l) => l.id === 'b')!.top).toBe(190);
  });

  it('separates colliding labels with no overlap, higher priority keeps its spot', () => {
    const reqs = Array.from({ length: 6 }, (_, k) => ({ id: `z${k}`, y: 100 + k, height: 30, priority: k }));
    const out = layoutLabels(reqs, 600);
    expect(out).toHaveLength(6);
    expect(out.find((l) => l.id === 'z0')!.top).toBe(85);
    const sorted = [...out].sort((a, b) => a.top - b.top);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.top).toBeGreaterThanOrEqual(sorted[i - 1]!.top + 30);
  });

  it('keeps labels inside the pane and drops what cannot fit', () => {
    const out = layoutLabels(Array.from({ length: 10 }, (_, k) => ({ id: `z${k}`, y: 5, height: 30, priority: k })), 100);
    expect(out.every((l) => l.top >= 0 && l.top + l.height <= 100)).toBe(true);
    expect(out.length).toBeLessThan(10);
  });

  it('is deterministic', () => {
    const reqs = [{ id: 'a', y: 50, height: 20, priority: 2 }, { id: 'b', y: 52, height: 20, priority: 1 }];
    expect(layoutLabels(reqs, 300)).toEqual(layoutLabels([...reqs].reverse(), 300));
  });
});
