import { describe, expect, it } from 'vitest';
import { chooseBucket, columnAt, DepthHistory, mergeColumns, toColumns, validAt, type HeatmapResponse, type HistoryColumn } from './depthHistory';

/* TEST DATA ONLY - a scripted /api/ibkr/heatmap; no gateway or IBKR connection is involved. */

const resp = (over: Partial<HeatmapResponse> = {}): HeatmapResponse => ({
  root: 'GC',
  contract: 'GCZ6',
  provider: 'Interactive Brokers',
  depthType: 'PRICE_LEVEL',
  mbo: false,
  firstRecordedMs: 10_000,
  lastObservedMs: 13_500,
  bucketMs: 1000,
  from: 10_000,
  to: 14_000,
  columns: [
    [10_000, 1, [[4150.0, 5]], [[4150.1, 3]]],
    [11_000, 1, [[4150.0, 6]], [[4150.1, 3]]],
    [13_000, 0.5, [[4150.0, 7]], []],
  ],
  ...over,
});

const col = (t: number, w = 1000): HistoryColumn => ({ t, w, coverage: 1, valid: Float64Array.from([t, t + w]), bidTicks: new Int32Array(), bidSizes: new Float64Array(), askTicks: new Int32Array(), askSizes: new Float64Array() });

describe('recorded depth history (display side)', () => {
  it('chooseBucket: at most one column per two pixels, never finer than the engine aggregation', () => {
    expect(chooseBucket(15 * 60_000, 1400, 1000)).toBe(2000);
    expect(chooseBucket(60_000, 1400, 1000)).toBe(1000);
    expect(chooseBucket(60_000, 1400, 250)).toBe(250);
    expect(chooseBucket(3 * 24 * 3600_000, 1000, 1000)).toBe(300_000);
  });

  it('toColumns keeps the served prices / sizes exactly (ticks from the tick size)', () => {
    const c = toColumns(resp(), 0.1);
    expect(c.map((x) => x.t)).toEqual([10_000, 11_000, 13_000]); // 12 000 had no recorded coverage: no column
    expect([...c[0]!.bidTicks]).toEqual([41500]);
    expect([...c[0]!.bidSizes]).toEqual([5]);
    expect([...c[0]!.askTicks]).toEqual([41501]);
    expect(c[2]!.coverage).toBe(0.5);
  });

  it('mergeColumns: a re-served range replaces its columns - one column per timestamp', () => {
    const cur = [col(1000), col(2000), col(3000)];
    const m = mergeColumns(cur, [col(3000), col(4000)], 3000, 5000);
    expect(m.map((x) => x.t)).toEqual([1000, 2000, 3000, 4000]);
    expect(new Set(m.map((x) => x.t)).size).toBe(m.length);
  });

  it('only the exact recorded-valid intervals of a coarse bucket are paintable (no pre-record, no cross-gap)', () => {
    const [c] = toColumns(resp({ bucketMs: 60_000, columns: [[0, 0.6, [[4150.0, 5]], [], [[17_600, 30_000], [40_000, 60_000]]]] }), 0.1);
    expect(validAt(c!, 17_599)).toBe(false); // before the first recorded snapshot
    expect(validAt(c!, 17_600)).toBe(true);
    expect(validAt(c!, 35_000)).toBe(false); // inside a feed gap
    expect(validAt(c!, 59_999)).toBe(true);
  });

  it('columnAt finds the covering bucket, null in a gap', () => {
    const cols = [col(1000), col(2000), col(5000)];
    expect(columnAt(cols, 2500)?.t).toBe(2000);
    expect(columnAt(cols, 3500)).toBeNull();
    expect(columnAt(cols, 999)).toBeNull();
  });

  it('DepthHistory loads the visible window, exposes the recorded edge, and resets on a contract change', async () => {
    const urls: string[] = [];
    let body = resp();
    const h = new DepthHistory('GC', 0.1, () => 1000, async (u) => {
      urls.push(u);
      return { ok: true, status: 200, json: async () => body };
    }, () => 14_000);
    h.ensure(10_000, 14_000, 800);
    await new Promise((r) => setTimeout(r, 0));
    expect(urls[0]).toMatch(/^\/api\/ibkr\/heatmap\?root=GC&from=\d+&to=\d+&bucket=1000$/); // same origin, no credential
    expect(h.firstRecordedMs).toBe(10_000);
    expect(h.columns.map((c) => c.t)).toEqual([10_000, 11_000, 13_000]);
    expect(h.coverEnd()).toBe(13_500); // the last confirmed observation, not the bucket end
    body = resp({ contract: 'GCG7', columns: [[13_000, 1, [[4170.0, 1]], []]], from: 13_000 });
    await h.live();
    expect(h.contract).toBe('GCG7');
    expect(h.columns.map((c) => c.t)).toEqual([13_000]); // the old contract's depth is dropped, never shown under the new one
    h.destroy();
  });

  it('a failed request keeps what was loaded and reports the error', async () => {
    let ok = true;
    const h = new DepthHistory('SI', 0.005, () => 1000, async () => (ok ? { ok: true, status: 200, json: async () => resp({ root: 'SI', contract: 'SIZ6' }) } : { ok: false, status: 503, json: async () => ({}) }), () => 14_000);
    h.ensure(10_000, 14_000, 800);
    await new Promise((r) => setTimeout(r, 0));
    ok = false;
    await h.live();
    expect(h.error).toMatch(/HTTP 503/);
    expect(h.columns.length).toBe(3);
    h.destroy();
  });
});
