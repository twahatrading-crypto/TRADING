import { describe, expect, it } from 'vitest';
import { DEFAULT_OB_SETTINGS } from '../../engines/orderBlocks/config';
import { analyzeOrderBlocks } from '../../engines/orderBlocks/engine';
import * as F from '../../engines/orderBlocks/fixtures/scenarios';
import { buildOBMulti } from '../../engines/orderBlocks/mtf';
import type { Candle } from '../../types/market';
import { chartLabel, excerptCandles, filterBlocks, mitigationEvents, obDrawables, obViewState, sortByRelevance } from './obView';

const S = { ...DEFAULT_OB_SETTINGS };
const snap = (c: Candle[] = F.cleanBullish(), s = S) => analyzeOrderBlocks({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: 0.01, settings: s, candles: c, lastBarClosed: true });
const ALL = { type: 'all', tf: 'ALL', state: 'ALL' } as const;

describe('page state — never stale as LIVE', () => {
  const s = snap();
  it.each([
    [{ connection: 'LIVE' as const }, 'LIVE'],
    [{ connection: 'DELAYED' as const }, 'LIVE'],
    [{ connection: 'LIVE' as const, feedCode: 'STALE' as const }, 'STALE'],
    [{ connection: 'DISCONNECTED' as const }, 'STALE'],
    [{ connection: 'LIVE' as const, feedCode: 'ERROR' as const }, 'ERROR'],
  ])('%o → %s', (o, want) => {
    expect(obViewState({ tradable: true, snapshots: [s], ...o })).toBe(want);
  });
  it('no data: MARKET DATA OFFLINE; short history: INSUFFICIENT HISTORY; categories: UNAVAILABLE; replay: REPLAY', () => {
    expect(obViewState({ tradable: true, connection: 'DISCONNECTED', snapshots: [] })).toBe('OFFLINE');
    expect(obViewState({ tradable: true, connection: 'DISCONNECTED', snapshots: [snap(F.cleanBullish().slice(0, 20))] })).toBe('INSUFFICIENT_HISTORY');
    expect(obViewState({ tradable: false, connection: 'LIVE', snapshots: [s] })).toBe('UNAVAILABLE');
    expect(obViewState({ tradable: true, connection: 'DISCONNECTED', snapshots: [s], replay: true })).toBe('REPLAY');
  });
});

describe('table, chart and mitigations', () => {
  it('filters by type / timeframe / state', () => {
    const bull = snap().blocks;
    const bear = snap(F.cleanBearish()).blocks;
    const all = [...bull, ...bear];
    expect(filterBlocks(all, { ...ALL, type: 'bullish' }).every((b) => b.type === 'bullish')).toBe(true);
    expect(filterBlocks(all, { ...ALL, type: 'bearish' }).every((b) => b.type === 'bearish')).toBe(true);
    expect(filterBlocks(all, { ...ALL, tf: 'M15' })).toEqual([]);
    const inv = snap(F.invalidation()).blocks;
    const f = filterBlocks(inv, { ...ALL, state: 'INVALIDATED' });
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((b) => b.state === 'INVALIDATED')).toBe(true);
    expect(filterBlocks(inv, { ...ALL, state: 'FRESH' }).every((b) => b.state === 'FRESH')).toBe(true);
  });

  it('chart label "BULL OB H1 · 82"; zones restricted to live blocks, selected always drawn', () => {
    const blocks = snap().blocks;
    const d = obDrawables({ blocks, filters: ALL, settings: S, selectedId: null, confluence: null });
    expect(d.length).toBeGreaterThan(0);
    for (const x of d) expect(x.label).toMatch(/^(BULL|BEAR) OB H1 · \d+$/);
    expect(chartLabel(blocks[0]!)).toBe(`BULL OB H1 · ${blocks[0]!.score.total}`);
    const inv = snap(F.invalidation()).blocks;
    const dead = inv.find((b) => b.type === 'bullish' && b.state === 'INVALIDATED')!;
    expect(obDrawables({ blocks: inv, filters: ALL, settings: S, selectedId: null, confluence: null }).some((x) => x.id === dead.id)).toBe(false);
    const sel = obDrawables({ blocks: inv, filters: ALL, settings: S, selectedId: dead.id, confluence: null }).find((x) => x.id === dead.id)!;
    expect(sel.selected && sel.spent).toBe(true);
    expect(sel.to).toBe(dead.invalidatedAt);
  });

  it('relevance puts live blocks before mitigated / invalidated ones', () => {
    const blocks = [...snap(F.invalidation()).blocks, ...snap(F.fullMitigation()).blocks.map((b) => ({ ...b, id: `${b.id}-m` })), ...snap().blocks.map((b) => ({ ...b, id: `${b.id}-l` }))];
    const rank = (st: string) => (st === 'MITIGATED' ? 1 : st === 'INVALIDATED' ? 2 : 0);
    const order = sortByRelevance(blocks).map((b) => rank(b.state));
    expect(new Set(order)).toEqual(new Set([0, 1, 2]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('mitigation events are the engine tests, newest first; the excerpt covers origin → test on the block timeframe', () => {
    const candles = F.retest();
    const blocks = snap(candles).blocks;
    const ev = mitigationEvents(blocks);
    expect(ev.length).toBe(blocks.reduce((a, b) => a + b.tests.length, 0));
    expect(ev[0]!.test.depthPct).toBeCloseTo(20, 5);
    const ex = excerptCandles(candles, ev[0]!.block, ev[0]!.test.time);
    expect(ex.some((c) => c.time === ev[0]!.block.originTime)).toBe(true);
    expect(ex.some((c) => c.time === ev[0]!.test.time)).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(40);
    expect(excerptCandles([], ev[0]!.block, ev[0]!.test.time)).toEqual([]);
  });

  it('MTF confluence (separate result) highlights member zones without changing them', () => {
    const h1 = snap();
    const h4 = { ...h1, timeframe: 'H4' as const, blocks: h1.blocks.map((b) => ({ ...b, id: b.id.replace(':H1:', ':H4:'), timeframe: 'H4' as const })) };
    const before = JSON.stringify(h1);
    const multi = buildOBMulti('XAUUSD', { H1: h1, H4: h4 }, S);
    expect(multi.confluences).toHaveLength(1);
    const d = obDrawables({ blocks: multi.blocks, filters: ALL, settings: S, selectedId: null, confluence: multi.confluences[0]! });
    expect(d.filter((x) => x.highlighted)).toHaveLength(2);
    expect(d.every((x) => { const b = multi.blocks.find((y) => y.id === x.id)!; return x.low === b.low && x.high === b.high; })).toBe(true);
    expect(JSON.stringify(h1)).toBe(before);
  });
});
