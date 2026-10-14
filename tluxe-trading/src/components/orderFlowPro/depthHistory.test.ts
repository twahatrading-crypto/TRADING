import { describe, expect, it, vi } from 'vitest';
import { HistoryBudget } from '../../providers/orderFlowPro/historyBudget';
import { bucketFor, chunkSpan, DepthHistory, MAX_CACHED_CELLS, MAX_REQUESTS_PER_MIN } from './depthHistory';

/*
 * The recorded-depth loader for the heatmap. Responses are constructed here (test only), in the gateway's
 * /api/ibkr/heatmap shape; nothing is LIVE.
 */
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const TICK = { GC: 0.1, SI: 0.005 } as const;

function body(root: 'GC' | 'SI', contract: string, from: number, to: number, bucket: number, opts: { gapFrom?: number; gapTo?: number; levels?: number } = {}) {
  const columns: unknown[] = [];
  for (let t = from; t < to; t += bucket) {
    if (opts.gapFrom !== undefined && t >= opts.gapFrom && t < opts.gapTo!) continue; // recorded gap: no column
    const mid = root === 'GC' ? 4200 : 60.5;
    const tk = TICK[root];
    const n = opts.levels ?? 3;
    const bids = Array.from({ length: n }, (_, i) => [+(mid - i * tk).toFixed(3), 2 + i]);
    const asks = Array.from({ length: n }, (_, i) => [+(mid + (i + 1) * tk).toFixed(3), 3 + i]);
    columns.push([t, 1, bids, asks, [[t, t + bucket]]]);
  }
  return { root, contract, depthType: 'PRICE_LEVEL', mbo: false, bucketMs: bucket, from, to, firstRecordedMs: from, columns };
}

function setup(contractFor: Record<string, string> = { GC: 'GCZ6', SI: 'SIZ6' }, status = 200) {
  let now = T0;
  const resolvers: Array<() => void> = [];
  let hold = false;
  const fetchImpl = vi.fn(async (url: string) => {
    const q = new URL(url, 'https://x');
    const root = q.searchParams.get('root') as 'GC' | 'SI';
    const from = Number(q.searchParams.get('from'));
    const to = Number(q.searchParams.get('to'));
    const bucket = Number(q.searchParams.get('bucket'));
    if (hold) await new Promise<void>((r) => resolvers.push(r));
    return new Response(JSON.stringify(body(root, contractFor[root]!, from, to, bucket, { gapFrom: T0 - 3 * 3600_000 + 60_000, gapTo: T0 - 3 * 3600_000 + 120_000 })), { status });
  });
  const budget = new HistoryBudget(10, () => now);
  const h = new DepthHistory((r) => TICK[r], fetchImpl as unknown as typeof fetch, () => now, undefined, budget);
  return { h, budget, fetchImpl, advance: (ms: number) => (now += ms), holdOn: () => (hold = true), release: () => resolvers.splice(0).forEach((r) => r()) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('bucket / chunk bounds', () => {
  it('bucket keeps >= 3 px per column; chunks <= 900 columns and <= 12 h', () => {
    expect(bucketFor(3 / 1000)).toBe(1000);
    expect(bucketFor(2 / 1000)).toBe(5000);
    expect(bucketFor(1 / 1000)).toBe(5000);
    expect(bucketFor(1e-6)).toBe(300_000);
    expect(chunkSpan(1000)).toBe(900_000);
    expect(chunkSpan(15_000)).toBe(13_500_000);
    expect(chunkSpan(300_000)).toBe(12 * 3600_000);
  });
});

describe('DepthHistory', () => {
  it('requests only time before the live recorder, once per chunk (cached / deduplicated)', async () => {
    const { h, fetchImpl } = setup();
    const before = T0 - 3600_000;
    h.ensure('GC', 'GCZ6', T0 - 2 * 3600_000, T0, 15_000, before);
    h.ensure('GC', 'GCZ6', T0 - 2 * 3600_000, T0, 15_000, before); // overlapping, same view
    await settle();
    const n = fetchImpl.mock.calls.length;
    expect(n).toBeGreaterThan(0);
    for (const c of fetchImpl.mock.calls) expect(Number(new URL(String(c[0]), 'https://x').searchParams.get('to'))).toBeLessThanOrEqual(before);
    h.ensure('GC', 'GCZ6', T0 - 2 * 3600_000, T0, 15_000, before);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(n);
    const cols = h.columns('GC', 'GCZ6', 15_000, T0 - 2 * 3600_000, before);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.every((c) => c.t + c.dt <= before && c.source === 'RECORDED')).toBe(true);
    // side, price (tick) and displayed contracts preserved
    expect(cols[0]!.cells).toEqual(expect.arrayContaining([{ tick: 42000, side: 'BID', avg: 2 }, { tick: 42001, side: 'ASK', avg: 3 }]));
  });

  it('at most 8 heat requests per minute across GC + SI (+ <= 2 one-time reads = <= 10); the rest is DEFERRED (no loop)', async () => {
    const { h, fetchImpl, advance } = setup();
    const before = T0;
    h.ensure('GC', 'GCZ6', T0 - 40 * 900_000, T0, 1000, before); // 40 chunks of 15 min wanted
    h.ensure('SI', 'SIZ6', T0 - 40 * 900_000, T0, 1000, before);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_REQUESTS_PER_MIN);
    expect(h.rangeState('SI', 'SIZ6', 1000, T0 - 40 * 900_000, T0).deferred).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_REQUESTS_PER_MIN); // nothing fires by itself
    advance(61_000);
    h.ensure('SI', 'SIZ6', T0 - 40 * 900_000, T0, 1000, before);
    await settle();
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2 * MAX_REQUESTS_PER_MIN);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(MAX_REQUESTS_PER_MIN);
  });

  it('a failed chunk is not retried', async () => {
    const { h, fetchImpl, advance } = setup(undefined, 503);
    h.ensure('GC', 'GCZ6', T0 - 900_000, T0, 1000, T0);
    await settle();
    advance(120_000);
    h.ensure('GC', 'GCZ6', T0 - 900_000, T0, 1000, T0);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.rangeState('GC', 'GCZ6', 1000, T0 - 900_000, T0)).toMatchObject({ failed: 1, detail: 'recorded depth unavailable (HTTP 503)' });
    expect(h.columns('GC', 'GCZ6', 1000, T0 - 900_000, T0)).toEqual([]);
  });

  it('another contract in the response is rejected (GCG7 never on a GCZ6 chart; SIH7 never on SIZ6)', async () => {
    const { h } = setup({ GC: 'GCG7', SI: 'SIH7' });
    h.ensure('GC', 'GCZ6', T0 - 900_000, T0, 1000, T0);
    h.ensure('SI', 'SIZ6', T0 - 900_000, T0, 1000, T0);
    await settle();
    expect(h.columns('GC', 'GCZ6', 1000, T0 - 900_000, T0)).toEqual([]);
    expect(h.columns('SI', 'SIZ6', 1000, T0 - 900_000, T0)).toEqual([]);
    expect(h.rangeState('GC', 'GCZ6', 1000, T0 - 900_000, T0).detail).toMatch(/GCG7 ≠ GCZ6 - not used/);
  });

  it('contract change: cached history of the old contract is dropped; an obsolete in-flight response is ignored', async () => {
    const { h, holdOn, release } = setup();
    h.ensure('GC', 'GCZ6', T0 - 900_000, T0, 1000, T0);
    await settle();
    expect(h.columns('GC', 'GCZ6', 1000, T0 - 900_000, T0).length).toBeGreaterThan(0);
    h.keepOnly('GC', 'GCG7'); // roll
    expect(h.columns('GC', 'GCZ6', 1000, T0 - 900_000, T0)).toEqual([]);
    holdOn();
    h.ensure('GC', 'GCG7', T0 - 1800_000, T0 - 900_000, 1000, T0);
    h.keepOnly('GC', null); // mismatch while the request is in flight
    release();
    await settle();
    await settle();
    expect(h.columns('GC', 'GCG7', 1000, T0 - 1800_000, T0)).toEqual([]);
  });

  it('recorded gaps stay gaps (no column is invented)', async () => {
    const { h } = setup();
    const gapFrom = T0 - 3 * 3600_000 + 60_000;
    h.ensure('GC', 'GCZ6', T0 - 3 * 3600_000, T0 - 3 * 3600_000 + 900_000, 1000, T0);
    await settle();
    const cols = h.columns('GC', 'GCZ6', 1000, T0 - 3 * 3600_000, T0 - 3 * 3600_000 + 900_000);
    expect(cols.some((c) => c.t >= gapFrom && c.t < gapFrom + 60_000)).toBe(false);
    expect(cols.length).toBe(900 - 60);
  });

  it('memory is bounded (least-recently-used chunks evicted)', async () => {
    const { h, advance } = setup();
    // ~900 columns x 40 cells per chunk; load enough chunks (spread over minutes) to exceed the bound
    for (let i = 0; i < 14; i++) {
      advance(61_000);
      const from = T0 - (i + 1) * 10 * 900_000;
      h.ensure('GC', 'GCZ6', from, from + 10 * 900_000, 1000, T0);
      await settle();
    }
    expect(h.cachedCells).toBeLessThanOrEqual(MAX_CACHED_CELLS);
  });
});

describe('page-wide recorded-depth budget (heatmap + one-time read + replay share <= 10 / min)', () => {
  it('heatmap requests stop when other readers already used the shared budget', async () => {
    const { h, budget, fetchImpl } = setup();
    for (let i = 0; i < 7; i++) expect(budget.tryTake()).toBe(true); // e.g. one-time reads + replays
    h.ensure('GC', 'GCZ6', T0 - 20 * 900_000, T0, 1000, T0);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 7 + 3 = 10
    expect(budget.used()).toBe(10);
  });
  it('acquire waits (single timer) for the next free slot, never exceeding the limit', async () => {
    let now = 0;
    const waits: number[] = [];
    const b = new HistoryBudget(10, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    for (let i = 0; i < 10; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(await b.acquire()).toBe(true);
    expect(waits).toEqual([60_000]);
    expect(b.used()).toBe(1);
  });
  it('acquire gives up after the bounded wait instead of looping', async () => {
    const b = new HistoryBudget(0, () => 0, async () => {});
    expect(await b.acquire(1000)).toBe(false);
  });
});
