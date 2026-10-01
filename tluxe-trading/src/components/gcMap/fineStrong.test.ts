import { describe, expect, it } from 'vitest';
import { analyzeMap, DEFAULT_STRONG, type MapColumn } from './liquidityMap';
import { analyzeFine, FineStrong, strongNowRows, type FineLevel } from './fineStrong';

/*
 * TEST DATA ONLY. The BID 4185.0 pattern below is the REAL 250 ms displayed size of GCZ6 BID 4185.0 recorded on
 * production 2026-10-01 08:19:36.000 - 08:20:35.750 UTC (240 buckets) (one value per 250 ms bucket, 0 = not displayed); the other
 * rows are that capture's last book. Everything else is hand-built.
 */
const REAL_4185 = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29.79, 38, 8.06, 0, 0, 0, 0, 22.46, 24.34, 0, 0, 37.09, 38, 38, 38, 38, 38, 16.57, 0, 22.4, 40, 2.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3.44, 41, 41, 41, 41, 41, 41, 41, 40.12, 12.96, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26.73, 41, 41, 41, 14.92, 0, 26.4, 41, 41, 41, 41, 6.89, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 37.39, 38, 0.76, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4.1, 38, 38, 38, 38.1, 39, 39, 39, 39, 39, 38.2, 39, 39, 39, 39, 39, 39, 39, 38.13, 38, 38,
];
const T0 = Date.UTC(2026, 9, 1, 8, 19, 36); // first bucket of REAL_4185 (1790842776000)
const LEVEL = 41850;
const BIDS: [number, number][] = [[41855, 3], [41854, 3], [41853, 3.87], [41852, 4], [41851, 4], [41849, 3], [41848, 5], [41847, 6], [41846, 6]];
const ASKS: [number, number][] = [[41858, 1], [41859, 2], [41860, 5.87], [41861, 3.13], [41862, 6.13], [41863, 5], [41864, 7], [41865, 4], [41866, 5], [41867, 6]];
const P = { ...DEFAULT_STRONG }; // the page defaults: 10 lots, 2.5x, 10 s, $5 (50 ticks)

function col(t: number, w: number, bids: [number, number][], asks: [number, number][], valid?: number[]): MapColumn {
  const b = [...bids].filter((x) => x[1] > 0).sort((x, y) => y[0] - x[0]);
  const a = [...asks].filter((x) => x[1] > 0).sort((x, y) => x[0] - y[0]);
  return { t, w, valid: Float64Array.from(valid ?? [t, t + w]), bidTicks: Int32Array.from(b.map((x) => x[0])), bidSizes: Float64Array.from(b.map((x) => x[1])), askTicks: Int32Array.from(a.map((x) => x[0])), askSizes: Float64Array.from(a.map((x) => x[1])) };
}
/** 250 ms columns with the level's displayed size per bucket. */
const fineCols = (sizes: number[], t0 = T0, level = LEVEL) => sizes.map((s, i) => col(t0 + i * 250, 250, [...BIDS, [level, s]], ASKS));
/** A chart column: the time-weighted displayed size of each price over a coarser bucket (what the server serves). */
function aggregate(cols: MapColumn[], w: number): MapColumn[] {
  const out: MapColumn[] = [];
  for (let t = Math.floor(cols[0]!.t / w) * w; t <= cols[cols.length - 1]!.t; t += w) {
    const inB = cols.filter((c) => c.t >= t && c.t < t + w);
    if (!inB.length) continue;
    const vt = inB.length * 250;
    const sum = (side: 'b' | 'a') => {
      const m = new Map<number, number>();
      for (const c of inB) {
        const [tk, sz] = side === 'b' ? [c.bidTicks, c.bidSizes] : [c.askTicks, c.askSizes];
        tk.forEach((k, i) => m.set(k, (m.get(k) ?? 0) + (sz[i]! * 250) / vt));
      }
      return [...m];
    };
    out.push(col(t, w, sum('b'), sum('a'), [inB[0]!.t, inB[inB.length - 1]!.t + 250]));
  }
  return out;
}
const book = (cols: MapColumn[]) => {
  const c = cols[cols.length - 1]!;
  return { bids: [...c.bidTicks].map((tick, i) => ({ tick, size: c.bidSizes[i]! })), asks: [...c.askTicks].map((tick, i) => ({ tick, size: c.askSizes[i]! })) };
};
/** The page pipeline for STRONG LIQUIDITY NOW: 250 ms series -> FineStrong -> rows. `chart` is accepted and ignored on purpose. */
function strongNow(fine: MapColumn[], _chart: MapColumn[]) {
  const fs = new FineStrong();
  fs.update(fine, P);
  return { rows: strongNowRows(book(fine), fs.levels, P), level: fs.levels.get(`BID${LEVEL}`) };
}
/** What the previous code did: the age of the level in the last CHART bucket. */
const bucketAge = (chart: MapColumn[]) => analyzeMap(chart).cells.filter((c) => c.c === chart.length - 1 && c.tick === LEVEL && c.side === 'BID')[0]?.observedMs ?? 0;

describe('Strong persistence comes from the 250 ms series only (real BID 4185.0 regression)', () => {
  const fine = fineCols(REAL_4185);
  it('250 ms truth: ~5 s of continuous presence -> does NOT qualify (fragmented presence before is never bridged)', () => {
    const { rows, level } = strongNow(fine, fine);
    expect(level!.observedMs).toBe(5250); // 4.1 lots appeared at 08:20:30.750, continuous to 08:20:36.000
    expect(level!.runStart).toBe(T0 + 219 * 250);
    expect(level!.qualifiedAt).toBeNull();
    expect(rows.bids).toEqual([]);
  });
  it.each([5_000, 10_000, 60_000, 300_000])('a %i ms chart bucket does NOT make it qualify, and the age stays ~5 s', (w) => {
    const chart = aggregate(fine, w);
    const { rows, level } = strongNow(fine, chart);
    expect(rows.bids).toEqual([]);
    expect(level!.observedMs).toBe(5250);
    if (w >= 10_000) expect(bucketAge(chart)).toBeGreaterThanOrEqual(10_000); // the old bucket-derived age WAS inflated here
  });
});

describe('a truly persistent level qualifies at the same real time whatever the chart', () => {
  // 40 lots continuously for 15 s (60 buckets), after 5 s of absence
  const sizes = [...Array(20).fill(0), ...Array(60).fill(40)];
  const fine = fineCols(sizes);
  const start = T0 + 20 * 250;
  it('qualifies when 10 s of continuous 250 ms presence is reached - not before (never back-dated)', () => {
    const { rows, level } = strongNow(fine, fine);
    expect(level!.observedMs).toBe(15_000);
    expect(level!.runStart).toBe(start);
    expect(level!.qualifiedAt).toBe(start + 10_000);
    expect(rows.bids.map((r) => [r.tick, r.size, r.observedMs, r.qualifiedAt, r.runStart])).toEqual([[LEVEL, 40, 15_000, start + 10_000, start]]);
  });
  it.each([250, 5_000, 10_000, 60_000, 300_000])('identical with a %i ms chart bucket', (w) => {
    expect(strongNow(fine, aggregate(fine, w))).toEqual(strongNow(fine, fine));
  });
});

describe('incremental = one analysis of everything (exact), gaps end runs, nothing bridged', () => {
  // deterministic real-shaped series: several levels appearing / vanishing / growing, one 3 s feed gap
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const N = 2400; // 10 minutes of 250 ms buckets
  const levels = [41845, 41848, 41850, 41860, 41863];
  const state = new Map<number, number>(levels.map((l) => [l, 0]));
  const cols: MapColumn[] = [];
  for (let i = 0; i < N; i++) {
    if (i >= 1200 && i < 1212) continue; // FEED GAP: no recorded depth
    for (const l of levels) {
      const s = state.get(l)!;
      const r = rnd();
      state.set(l, s === 0 ? (r < 0.02 ? 12 + Math.floor(r * 2000) : 0) : r < 0.004 ? 0 : s);
    }
    const t = T0 + i * 250;
    cols.push(col(t, 250, [...BIDS.filter((b) => !levels.includes(b[0])), ...levels.filter((l) => l < 41858).map((l): [number, number] => [l, state.get(l)!])], [...ASKS.filter((a) => !levels.includes(a[0])), ...levels.filter((l) => l >= 41858).map((l): [number, number] => [l, state.get(l)!])]));
  }
  const strip = (m: ReadonlyMap<string, FineLevel>) => [...m.values()].sort((a, b) => a.tick - b.tick || a.side.localeCompare(b.side));
  it('fed every 2 s like the page: levels and strong intervals equal a single analysis of all columns at every step', () => {
    const fs = new FineStrong();
    let checked = 0;
    for (let n = 8; n <= cols.length; n += 8) {
      const prefix = cols.slice(0, n);
      fs.update(prefix, P);
      if (n % 400 === 0 || n === cols.length - (cols.length % 8)) {
        const ref = analyzeFine(prefix, P, null);
        const got = strip(fs.levels);
        const want = [...ref.last].sort((a, b) => a.tick - b.tick || a.side.localeCompare(b.side));
        expect(got).toEqual(want);
        const key = (x: { side: string; tick: number; from: number; to: number }) => `${x.side}${x.tick}@${x.from}-${x.to}`;
        expect(fs.intervals().map(key).sort()).toEqual(ref.intervals.map(key).sort());
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  }, 60_000);
  it('dropping columns older than the oldest anchor (memory) changes nothing', () => {
    const fs = new FineStrong();
    let kept = cols.slice(0, 8);
    for (let n = 8; n <= cols.length; n += 8) {
      kept = [...kept, ...cols.slice(n - 8 === 0 ? 8 : n - 8, n)].filter((c, i, a) => i === 0 || c.t > a[i - 1]!.t);
      const keep = fs.update(kept, P);
      if (keep !== null) kept = kept.filter((c) => c.t >= keep);
    }
    const ref = analyzeFine(cols.slice(0, cols.length - (cols.length % 8)), P, null);
    expect(strip(fs.levels)).toEqual([...ref.last].sort((a, b) => a.tick - b.tick || a.side.localeCompare(b.side)));
  }, 60_000);
  it('a feed gap ends every run (FEED_GAP): no run and no strong interval crosses it', () => {
    const ref = analyzeFine(cols, P, null);
    const gap0 = T0 + 1200 * 250;
    const gap1 = T0 + 1212 * 250;
    for (const iv of ref.intervals) expect(iv.to <= gap0 || iv.from >= gap1).toBe(true);
    for (const l of ref.last) expect(l.runStart).toBeGreaterThanOrEqual(gap1);
  });
  it('a run present in the first analysed bucket is a LOWER BOUND (start unknown) - never presented as exact', () => {
    const fs = new FineStrong();
    fs.update(fineCols(Array(60).fill(40)), P);
    const l = fs.levels.get(`BID${LEVEL}`)!;
    expect(l.lowerBound).toBe(true);
    expect(strongNowRows(book(fineCols(Array(60).fill(40))), fs.levels, P).bids[0]!.lowerBound).toBe(true);
  });
  it('the thresholds are the same and still apply (size, relative, distance)', () => {
    const fine = fineCols([...Array(20).fill(0), ...Array(60).fill(9)]); // 9 lots for 15 s: below the 10-lot minimum
    expect(strongNow(fine, fine).rows.bids).toEqual([]);
  });
});
