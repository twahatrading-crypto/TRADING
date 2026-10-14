import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRecordedSeed, resetSeedCache } from '../../components/orderFlowPro/liquidityHistory';
import rec from '../../providers/orderFlowPro/testing/gatewayRecorded.json';
import { DepthRecorder } from './depthRecorder';
import { STRONG_PARAMS } from './engine';
import { classifyBands, DEFAULT_LIQ_PARAMS, liquidityOverlay, quantile, rankOf, referenceColumns, type RecordedSeed, type RefColumn } from './liquidityClass';

/*
 * Recorder sequences below are constructed IN TESTS ONLY to exercise the rules; they are never shown as market data.
 * The recorded heatmap is the real RECORDED fixture (gatewayRecorded.json).
 */
const B = 15_000;
const T0 = Date.UTC(2026, 9, 13, 8, 0, 0);
const TICK = 0.1;

type Ev = { t: number; side: 'BID' | 'ASK'; price: number; size: number };

/**
 * A recorder that observes a stable 10 x 10 book (sizes 1..4) from T0 for `ms`, applying `events` in time order
 * (integrated second by second, as the live recorder is), then `extra` at the end.
 */
function observed(ms: number, extra: (r: DepthRecorder, t: number) => void = () => {}, events: Ev[] = []) {
  const r = new DepthRecorder(TICK);
  const bids: Array<[number, number]> = [];
  const asks: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    bids.push([+(4200 - i * 0.1).toFixed(1), 1 + (i % 4)]);
    asks.push([+(4200.1 + i * 0.1).toFixed(1), 1 + ((i + 2) % 4)]);
  }
  r.applySnapshot({ kind: 'book', t: T0, bids, asks });
  const evs = [...events].sort((a, b) => a.t - b.t);
  for (let t = T0 + 1000; t <= T0 + ms; t += 1000) {
    while (evs.length && evs[0]!.t <= t) {
      const e = evs.shift()!;
      r.applyLevel({ kind: 'depth', ...e });
    }
    r.integrate(t);
  }
  extra(r, T0 + ms);
  return r;
}

/** A recorded seed of `minutes` full 15 s columns ending at T0 (sizes 1..4 everywhere). */
function seed(minutes: number, contract = 'GCZ6'): RecordedSeed {
  const columns: RecordedSeed['columns'] = [];
  for (let t = T0 - minutes * 60_000; t < T0; t += B) {
    const bids: Array<[number, number]> = [];
    const asks: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) {
      bids.push([+(4200 - i * 0.1).toFixed(1), 1 + (i % 4)]);
      asks.push([+(4200.1 + i * 0.1).toFixed(1), 1 + ((i + 2) % 4)]);
    }
    columns.push({ t, coverage: 1, bids, asks });
  }
  return { contract, bucketMs: B, columns };
}

describe('quantile / rank (nearest rank)', () => {
  it('matches hand-computed values', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(s, 0.9)).toBe(9);
    expect(quantile(s, 0.75)).toBe(8);
    expect(quantile(s, 1)).toBe(10);
    expect(rankOf(s, 9)).toBe(0.9);
    expect(rankOf(s, 0)).toBe(0);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe('history gating: nothing is classified without enough valid history', () => {
  it('COLLECTING with only live observation shorter than minHistoryMs', () => {
    const r = observed(5 * 60_000, undefined, [{ t: T0 + 3 * 60_000, side: 'BID', price: 4199.9, size: 60 }]);
    const o = liquidityOverlay(r, null, true, T0 + 5 * 60_000);
    expect(o.status).toBe('COLLECTING');
    expect(o.levels).toEqual([]);
    expect(o.bands).toEqual([]);
    expect(o.strongMin).toBeNull();
    expect(o.liveMs).toBeGreaterThan(4 * 60_000);
  });
  it('a recorded seed of the same contract completes the history (no double counting of overlapping time)', () => {
    const r = observed(3 * 60_000);
    const o = liquidityOverlay(r, seed(30), true, T0 + 3 * 60_000);
    expect(o.status).toBe('READY');
    // lookback = 30 min ending now: 27 min recorded (before the first live column) + 3 min live
    expect(Math.round(o.recordedMs / 60_000)).toBe(27);
    expect(Math.round(o.liveMs / 60_000)).toBe(3);
    const cols = referenceColumns(r, seed(30), T0 + 3 * 60_000 - 30 * 60_000, T0 + 3 * 60_000);
    const ts = cols.map((c) => c.t);
    expect(new Set(ts).size).toBe(ts.length);
  });
  it('a seed with a different bucket is ignored', () => {
    const r = observed(3 * 60_000);
    const o = liquidityOverlay(r, { ...seed(30), bucketMs: 5000 }, true, T0 + 3 * 60_000);
    expect(o.status).toBe('COLLECTING');
  });
});

describe('classes: relative to the instrument own recorded book + observed persistence', () => {
  const now = T0 + 12 * 60_000;
  it('STRONG needs size >= the 90th percentile AND >= 60 s resting; MEDIUM >= 75th AND >= 30 s', () => {
    const r = observed(12 * 60_000, undefined, [
      { t: now - 120_000, side: 'BID', price: 4199.5, size: 40 }, // big for 2 min -> STRONG
      { t: now - 20_000, side: 'ASK', price: 4200.7, size: 40 }, // was 1 contract; big for 20 s -> none
      { t: now - 45_000, side: 'ASK', price: 4200.8, size: 40 }, // big for 45 s -> MEDIUM
    ]);
    const o = liquidityOverlay(r, null, true, now);
    expect(o.status).toBe('READY');
    // reference: sizes 1..4 five times each per column plus the few large cells: p90 = 4; p75 is 3 or 4 depending
    // on how many cells the large levels displaced - always the nearest-rank quantile of the observed cells
    expect(o.strongMin).toBe(4);
    expect([3, 4]).toContain(o.mediumMin);
    expect(o.samples).toBeGreaterThan(900);
    const by = new Map(o.levels.map((l) => [`${l.side}${l.price.toFixed(1)}`, l]));
    expect(by.get('BID4199.5')?.cls).toBe('STRONG');
    expect(by.get('BID4199.5')?.size).toBe(40);
    expect(by.get('BID4199.5')?.persistAtLeast).toBe(false); // started while observed: exact
    expect(by.get('ASK4200.7')).toBeUndefined();
    expect(by.get('ASK4200.6')?.cls).toBe('STRONG'); // already at the STRONG size (4) for 12 min before the jump
    expect(by.get('ASK4200.8')?.cls).toBe('MEDIUM');
  });
  it('a size jump starts the resting clock at the jump (never inherits the smaller-size display time; < 15 s understatement allowed)', () => {
    // price 4199.5 displayed at 2 contracts for 11 min, then 40 contracts for the last 60 s
    const r = observed(12 * 60_000, undefined, [{ t: now - 60_000, side: 'BID', price: 4199.5, size: 40 }]);
    const l = liquidityOverlay(r, null, true, now).levels.find((x) => x.side === 'BID' && x.price.toFixed(1) === '4199.5');
    expect(l?.cls).toBe('MEDIUM'); // 45 s counted at size (oldest cell of the run conservatively excluded): not STRONG
    expect(l!.persistMs).toBeGreaterThanOrEqual(45_000);
    expect(l!.persistMs).toBeLessThanOrEqual(60_000);
    expect(l!.persistAtLeast).toBe(false);
    expect(r.levelStats(now).find((x) => x.side === 'BID' && x.price.toFixed(1) === '4199.5')!.persistMs).toBe(12 * 60_000); // recorder unchanged
  });
  it('a partly-at-size cell never inflates the resting time', () => {
    // jump 20 s ago: the cell [now-30 s, now-15 s) averages above the threshold but was only 5 s at size
    const r = observed(12 * 60_000, undefined, [{ t: now - 20_000, side: 'ASK', price: 4200.7, size: 40 }]);
    const l = liquidityOverlay(r, null, true, now).levels.find((x) => x.side === 'ASK' && x.price.toFixed(1) === '4200.7');
    expect(l).toBeUndefined(); // counted 15 s <= actual 20 s < 30 s: not MEDIUM yet
  });
  it('levels resting since the start of observation are marked "at least" (true start unknown)', () => {
    const r = observed(12 * 60_000);
    const o = liquidityOverlay(r, null, true, now);
    const four = o.levels.filter((l) => l.size === 4);
    expect(four.length).toBeGreaterThan(0);
    expect(four.every((l) => l.persistAtLeast && l.cls === 'STRONG')).toBe(true);
    for (const l of four) expect(l.persistMs).toBe(12 * 60_000);
  });
  it('no current classes when the book is not valid (stale / disconnected / contract mismatch); recorded bands remain', () => {
    const r = observed(12 * 60_000);
    const o = liquidityOverlay(r, null, false, now);
    expect(o.status).toBe('NO_BOOK');
    expect(o.levels).toEqual([]);
    expect(o.bands.length).toBeGreaterThan(0);
  });
  it('a gap resets observed resting time (never carried across)', () => {
    const r = observed(12 * 60_000 - 30_000, (r, t) => {
      r.applyGap({ kind: 'gap', from: t, to: t + 10_000, reason: 'stale' });
      r.applySnapshot({ kind: 'book', t: t + 10_000, bids: [[4200, 4], [4199.9, 1], [4199.8, 1]], asks: [[4200.1, 1], [4200.2, 1]] });
      for (let x = t + 11_000; x <= now; x += 1000) r.integrate(x);
    });
    const o = liquidityOverlay(r, null, true, now);
    for (const l of o.levels) expect(l.persistMs).toBeLessThanOrEqual(20_000);
    expect(o.levels.filter((l) => l.cls === 'STRONG')).toEqual([]); // 20 s < 60 s
  });
  it('the existing strong-level detector is unchanged (same result before / after classification)', () => {
    const r = observed(12 * 60_000, undefined, [{ t: now - 120_000, side: 'BID', price: 4199.5, size: 40 }]);
    const before = JSON.stringify(r.strongLevels(now, STRONG_PARAMS));
    liquidityOverlay(r, seed(30), true, now);
    expect(JSON.stringify(r.strongLevels(now, STRONG_PARAMS))).toBe(before);
  });
});

describe('bands: only where the level was observed', () => {
  const col = (t: number, avg: number, validMs = B): RefColumn => ({ t, validMs, cells: [{ tick: 42000, side: 'BID', avg }], source: 'LIVE' });
  it('>= minBandColumns consecutive cells; STRONG when the mean reaches STRONG', () => {
    const cols = [0, 1, 2, 3].map((i) => col(T0 + i * B, 10));
    const b = classifyBands(cols, B, 8, 5, DEFAULT_LIQ_PARAMS);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ cls: 'STRONG', from: T0, to: T0 + 4 * B, meanAvg: 10, source: 'LIVE' });
    expect(classifyBands(cols.slice(0, 3), B, 8, 5, DEFAULT_LIQ_PARAMS)).toEqual([]);
    expect(classifyBands([0, 1, 2, 3].map((i) => col(T0 + i * B, 6)), B, 8, 5, DEFAULT_LIQ_PARAMS)[0]!.cls).toBe('MEDIUM');
  });
  it('a missing or mostly invalid column ends the band (never bridged)', () => {
    const holed = [0, 1, 3, 4, 5].map((i) => col(T0 + i * B, 10));
    expect(classifyBands(holed, B, 8, 5, DEFAULT_LIQ_PARAMS)).toEqual([]);
    const invalid = [col(T0, 10), col(T0 + B, 10), col(T0 + 2 * B, 10, 1000), col(T0 + 3 * B, 10), col(T0 + 4 * B, 10)];
    expect(classifyBands(invalid, B, 8, 5, DEFAULT_LIQ_PARAMS)).toEqual([]);
  });
});

describe('recorded depth loader: one read per instrument + contract, verified', () => {
  beforeEach(() => resetSeedCache());
  const R = rec as unknown as Record<string, Record<string, unknown>>;
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  it('loads the RECORDED heatmap fixture once (cached, no repeat request)', async () => {
    const f = ok(R.heatmapGC);
    const a = await loadRecordedSeed('GC', 'GCZ6', T0, 30 * 60_000, f as unknown as typeof fetch);
    const b = await loadRecordedSeed('GC', 'GCZ6', T0, 30 * 60_000, f as unknown as typeof fetch);
    expect(a.state).toBe('LOADED');
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledTimes(1);
    const url = (f.mock.calls[0] as unknown[])[0] as string;
    expect(url).toMatch(/^\/api\/ibkr\/heatmap\?root=GC&from=\d+&to=\d+&bucket=15000$/);
  });
  it('a different contract is rejected (never mixed)', async () => {
    const s = await loadRecordedSeed('GC', 'GCG7', T0, 30 * 60_000, ok(R.heatmapGC) as unknown as typeof fetch);
    expect(s).toMatchObject({ state: 'UNAVAILABLE' });
    expect((s as { detail: string }).detail).toMatch(/GCZ6 ≠ live GCG7/);
  });
  it('HTTP errors / bad schema are final for the session (no retry loop)', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429 }));
    const s1 = await loadRecordedSeed('SI', 'SIZ6', T0, 30 * 60_000, f as unknown as typeof fetch);
    const s2 = await loadRecordedSeed('SI', 'SIZ6', T0, 30 * 60_000, f as unknown as typeof fetch);
    expect(s1).toMatchObject({ state: 'UNAVAILABLE' });
    expect(s2).toBe(s1);
    expect(f).toHaveBeenCalledTimes(1);
    const bad = await loadRecordedSeed('GC', 'GCZ6', T0, 30 * 60_000, ok({ nope: 1 }) as unknown as typeof fetch);
    expect(bad).toMatchObject({ state: 'UNAVAILABLE', detail: 'recorded depth response rejected (schema)' });
  });
});
