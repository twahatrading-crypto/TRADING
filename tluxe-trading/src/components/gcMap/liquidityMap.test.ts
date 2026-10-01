import { describe, expect, it } from 'vitest';
import { analyzeMap, heatColor, intensityOf, isStrong, strongRunCells, type MapColumn, type Print } from './liquidityMap';

/* TEST DATA ONLY: hand-built recorded-depth columns (10 contiguous rows per side), 250 ms buckets. */
const W = 250;
const T0 = 1_800_000_000_000;
const at = (i: number) => T0 + i * W;
function col(t: number, mid = 1000, over: Record<number, number> = {}, w = W, valid?: number[]): MapColumn {
  const rows = (from: number, step: number) => Array.from({ length: 10 }, (_, i) => from + i * step).map((k) => [k, over[k] ?? 4] as const).filter((x) => x[1] > 0);
  const b = rows(mid - 1, -1);
  const a = rows(mid, 1);
  return { t, w, valid: Float64Array.from(valid ?? [t, t + w]), bidTicks: Int32Array.from(b.map((x) => x[0])), bidSizes: Float64Array.from(b.map((x) => x[1])), askTicks: Int32Array.from(a.map((x) => x[0])), askSizes: Float64Array.from(a.map((x) => x[1])) };
}
const run = (n: number, f: (t: number, i: number) => MapColumn) => Array.from({ length: n }, (_, i) => f(at(i), i));
const WALL = 1004;

describe('no synthetic depth', () => {
  it('nothing recorded -> nothing drawn', () => {
    expect(analyzeMap([])).toEqual({ cells: [], covered: [], refSize: 0 });
  });
  it('every cell is exactly one recorded (bucket, side, price, size > 0); no extra price, no extra time', () => {
    const cols = run(6, (t, i) => col(t, 1000, { [WALL]: i < 3 ? 30 : 0 }));
    const r = analyzeMap(cols);
    const recorded = cols.reduce((n, c) => n + [...c.bidSizes, ...c.askSizes].filter((x) => x > 0).length, 0);
    expect(r.cells.length).toBe(recorded);
    for (const cell of r.cells) {
      const c = cols[cell.c]!;
      const ticks = cell.side === 'BID' ? c.bidTicks : c.askTicks;
      const sizes = cell.side === 'BID' ? c.bidSizes : c.askSizes;
      expect(sizes[ticks.indexOf(cell.tick)]).toBe(cell.size);
    }
    expect(r.cells.filter((c) => c.tick === WALL && c.c >= 3)).toEqual([]); // never extended after it disappeared
  });
});

describe('historical integrity', () => {
  it('observed time grows while the level is present and restarts after an absence', () => {
    const r = analyzeMap(run(8, (t, i) => col(t, 1000, { [WALL]: i === 4 ? 0 : 30 })));
    const w = r.cells.filter((c) => c.tick === WALL);
    expect(w.map((c) => c.observedMs)).toEqual([250, 500, 750, 1000, 250, 500, 750]);
  });
  it('size changes change only their own bucket; a longer history never repaints a prefix', () => {
    const sizes = [30, 30, 60, 10, 30, 30];
    const cols = run(6, (t, i) => col(t, 1000, { [WALL]: sizes[i]! }));
    const short = analyzeMap(cols.slice(0, 4)).cells.map(({ end: _e, ...c }) => c);
    const long = analyzeMap(cols).cells.filter((c) => c.c < 4).map(({ end: _e, ...c }) => c);
    expect(long).toEqual(short);
    expect(analyzeMap(cols).cells.filter((c) => c.tick === WALL).map((c) => c.size)).toEqual(sizes);
  });
  it('relative = size / median of the other displayed levels of the same side', () => {
    const r = analyzeMap([col(T0, 1000, { [WALL]: 20 })]);
    expect(r.cells.find((c) => c.tick === WALL)!.relative).toBe(5);
  });
});

describe('feed gaps are never painted through', () => {
  it('a gap between buckets: coverage stops, runs end FEED_GAP, observed time restarts after reconnect', () => {
    const cols = [...run(4, (t) => col(t, 1000, { [WALL]: 30 })), ...run(4, (t) => col(t + 60_000, 1000, { [WALL]: 30 }))];
    const r = analyzeMap(cols);
    expect(r.covered).toEqual([
      [at(0), at(4)],
      [at(0) + 60_000, at(4) + 60_000],
    ]);
    const w = r.cells.filter((c) => c.tick === WALL);
    expect(w[3]!.end).toBe('FEED_GAP');
    expect(w[4]!.observedMs).toBe(250);
    // no cell lies inside the gap
    for (const c of r.cells) expect(cols[c.c]!.t < at(4) || cols[c.c]!.t >= at(0) + 60_000).toBe(true);
  });
  it('a hole inside a bucket ends runs there (FEED_GAP)', () => {
    const cols = [col(at(0), 1000, { [WALL]: 30 }), col(at(1), 1000, { [WALL]: 30 }, W, [at(1), at(1) + 50, at(1) + 200, at(2)])];
    const r = analyzeMap(cols);
    expect(r.cells.filter((c) => c.tick === WALL)[1]!.end).toBe('FEED_GAP');
  });
});

describe('disappearance: PULLED_CONFIRMED vs OUT_OF_VISIBLE_BOOK vs TRADED', () => {
  const ends = (cols: MapColumn[], prints: Print[] = []) => analyzeMap(cols, prints).cells.filter((c) => c.tick === WALL && c.end).map((c) => c.end);
  it('gone while its price is still inside the displayed range, no executions -> PULLED_CONFIRMED', () => {
    expect(ends(run(4, (t, i) => col(t, 1000, { [WALL]: i < 2 ? 30 : 0 })))).toEqual(['PULLED_CONFIRMED']);
  });
  it('the displayed window moved away from the price -> OUT_OF_VISIBLE_BOOK (never claimed cancelled)', () => {
    expect(ends(run(4, (t, i) => col(t, i < 2 ? 1000 : 990, { [WALL]: 30 })))).toEqual(['OUT_OF_VISIBLE_BOOK']);
  });
  it('executions at the price around the removal (>= half its size) -> TRADED; a small print is not enough', () => {
    const cols = run(4, (t, i) => col(t, 1000, { [WALL]: i < 2 ? 30 : 0 }));
    expect(ends(cols, [{ t: at(2) - 10, tick: WALL, size: 20 }])).toEqual(['TRADED']);
    expect(ends(cols, [{ t: at(2) - 10, tick: WALL, size: 2 }])).toEqual(['PULLED_CONFIRMED']);
    expect(ends(cols, [{ t: at(2) - 10, tick: WALL - 1, size: 40 }])).toEqual(['PULLED_CONFIRMED']);
  });
  it('real pattern (GCZ6 BID 4195.1, 2026-10-01 07:48:21-22): 18 lots shrink to 3.6 then vanish with only 3 lots traded -> PULLED_CONFIRMED, not TRADED', () => {
    const sizes = [18, 18, 15, 3.6, 0];
    const cols = run(5, (t, i) => col(t, 1000, { [WALL]: sizes[i]! }));
    const r = analyzeMap(cols, [{ t: at(4) + 2, tick: WALL, size: 3 }]);
    const end = r.cells.find((c) => c.tick === WALL && c.end)!;
    expect([end.end, end.endVolume, end.removedSize]).toEqual(['PULLED_CONFIRMED', 3, 18]);
    const traded = analyzeMap(cols, [{ t: at(4) + 2, tick: WALL, size: 12 }]).cells.find((c) => c.tick === WALL && c.end)!;
    expect(traded.end).toBe('TRADED');
  });
  it('coarse buckets (> 1 s) merge several books: the reason is not claimed', () => {
    const cols = Array.from({ length: 4 }, (_, i) => col(T0 + i * 5000, 1000, { [WALL]: i < 2 ? 30 : 0 }, 5000));
    expect(ends(cols)).toEqual(['UNDETERMINED']);
  });
});

describe('intensity / strong', () => {
  it('intensity grows with displayed size; colour is a heat scale (dark blue -> white-hot)', () => {
    expect(intensityOf(0, 10)).toBe(0);
    expect(intensityOf(20, 10)).toBe(1);
    expect(intensityOf(5, 10)).toBeLessThan(intensityOf(8, 10));
    expect(heatColor(0)).toEqual([30, 64, 175]);
    expect(heatColor(1)).toEqual([255, 245, 235]);
  });
  it('strong needs size, relative, persistence and distance', () => {
    const p = { minSize: 10, minRelative: 2.5, minPersistMs: 1000, maxDistanceTicks: 10 };
    expect(isStrong({ size: 30, relative: 5, observedMs: 2000, tick: 1004 }, 999.5, p)).toBe(true);
    expect(isStrong({ size: 30, relative: 5, observedMs: 500, tick: 1004 }, 999.5, p)).toBe(false);
    expect(isStrong({ size: 30, relative: 2, observedMs: 2000, tick: 1004 }, 999.5, p)).toBe(false);
    expect(isStrong({ size: 30, relative: 5, observedMs: 2000, tick: 1020 }, 999.5, p)).toBe(false);
    expect(isStrong({ size: 5, relative: 5, observedMs: 2000, tick: 1004 }, 999.5, p)).toBe(false);
  });
});

describe('Strong Only per run', () => {
  it('a run shows from the bucket it qualifies until it ends - never back-dated, no flicker on a dip', () => {
    const sizes = [12, 12, 30, 30, 9, 30, 30, 0, 30];
    const cols = run(9, (t, i) => col(t, 1000, { [WALL]: sizes[i]! }));
    const r = analyzeMap(cols);
    const p = { minSize: 10, minRelative: 2.5, minPersistMs: 750, maxDistanceTicks: 60 };
    const set = strongRunCells(r.cells, cols.map(() => 999.5), p);
    const shown = r.cells.map((c, i) => [c, i] as const).filter(([c]) => c.tick === WALL).map(([c, i]) => [cols[c.c]!.t, set.has(i)]);
    // qualifies at bucket 2 (30 lots, 7.5x, 750 ms observed); the 9-lot dip at 4 stays shown; the run ends at 6;
    // after the absence (bucket 7) the new run at 8 is new evidence and has not qualified yet.
    expect(shown).toEqual([[at(0), false], [at(1), false], [at(2), true], [at(3), true], [at(4), true], [at(5), true], [at(6), true], [at(8), false]]);
  });
});
