import { describe, expect, it } from 'vitest';
import { MAX_LABEL_SHIFT, VP_LABEL_H, VP_LABEL_LANE, placeVpLabels, vpHistogramWidth } from './VolumeProfilePrimitive';

/* TEST DATA ONLY: synthetic pixel positions for the Volume Profile level-label layout (presentation). */
const overlaps = (a: { top: number; height: number }, b: { top: number; height: number }) => a.top < b.top + b.height && b.top < a.top + a.height;

describe('Volume Profile level labels', () => {
  it('reserves a 150 px label lane and a bounded histogram width', () => {
    expect(VP_LABEL_LANE).toBe(150);
    expect(vpHistogramWidth(600)).toBe(150);
    expect(vpHistogramWidth(1400)).toBe(336);
    expect(vpHistogramWidth(4000)).toBe(360);
  });

  it('POC / VAH / VAL are always shown; crowded HVN / LVN labels disappear rather than collide', () => {
    const rows = [
      { id: 'poc', y: 300, tone: 'poc' as const, emphasis: true },
      { id: 'vah', y: 296, tone: 'va' as const, emphasis: false },
      { id: 'val', y: 305, tone: 'va' as const, emphasis: false },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `hvn${i}`, y: 298 + i, tone: 'hvn' as const, emphasis: false })),
      { id: 'lvn-far', y: 600, tone: 'lvn' as const, emphasis: false },
    ];
    const placed = placeVpLabels(rows, 800);
    const ids = placed.map((p) => p.id);
    for (const must of ['poc', 'vah', 'val', 'lvn-far']) expect(ids).toContain(must);
    expect(ids.filter((x) => x.startsWith('hvn')).length).toBeLessThan(10); // some crowded HVN labels hidden
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i]!, placed[j]!)).toBe(false);
    // Every lower-priority label that IS shown sits close to its own line.
    for (const p of placed) {
      const r = rows.find((x) => x.id === p.id)!;
      if (r.tone === 'hvn' || r.tone === 'lvn') expect(Math.abs(p.top + VP_LABEL_H / 2 - r.y)).toBeLessThanOrEqual(MAX_LABEL_SHIFT);
    }
    // POC keeps its preferred position (placed first).
    const poc = placed.find((p) => p.id === 'poc')!;
    expect(Math.abs(poc.top + VP_LABEL_H / 2 - 300)).toBeLessThanOrEqual(1);
    expect(placeVpLabels(rows, 800)).toEqual(placed); // deterministic
  });

  it('uncrowded labels are all shown at their own lines', () => {
    const rows = [0, 1, 2, 3].map((i) => ({ id: `n${i}`, y: 100 + i * 60, tone: 'lvn' as const, emphasis: false }));
    const placed = placeVpLabels(rows, 800);
    expect(placed).toHaveLength(4);
    for (const p of placed) expect(Math.abs(p.top + VP_LABEL_H / 2 - rows.find((r) => r.id === p.id)!.y)).toBeLessThanOrEqual(1);
  });
});
