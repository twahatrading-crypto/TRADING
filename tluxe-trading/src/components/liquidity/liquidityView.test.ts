import { describe, expect, it } from 'vitest';
import { DEFAULT_LIQUIDITY_SETTINGS } from '../../engines/liquidity/config';
import { analyzeLiquidity } from '../../engines/liquidity/engine';
import * as F from '../../engines/liquidity/fixtures/scenarios';
import { filterPools, liquidityDrawables, liquidityMarkers, liquidityViewState, sortByRelevance, stateLabel } from './liquidityView';

const S = { ...DEFAULT_LIQUIDITY_SETTINGS };
const snap = (c = F.repeatedSweep()) => analyzeLiquidity({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: 0.01, settings: S, candles: c, lastBarClosed: true });

describe('24: page state — never stale as LIVE', () => {
  const s = snap();
  it.each([
    [{ connection: 'LIVE' as const }, 'LIVE'],
    [{ connection: 'DELAYED' as const }, 'LIVE'],
    [{ connection: 'LIVE' as const, feedCode: 'STALE' as const }, 'STALE'],
    [{ connection: 'DISCONNECTED' as const }, 'STALE'],
    [{ connection: 'LIVE' as const, feedCode: 'ERROR' as const }, 'ERROR'],
  ])('%o → %s', (o, want) => {
    expect(liquidityViewState({ tradable: true, snapshots: [s], ...o })).toBe(want);
  });
  it('no data: OFFLINE when disconnected, INSUFFICIENT HISTORY when live but short, UNAVAILABLE for categories', () => {
    expect(liquidityViewState({ tradable: true, connection: 'DISCONNECTED', snapshots: [] })).toBe('OFFLINE');
    expect(liquidityViewState({ tradable: true, connection: 'LIVE', snapshots: [snap(F.cleanBSL().slice(0, 30))] })).toBe('INSUFFICIENT_HISTORY');
    expect(liquidityViewState({ tradable: false, connection: 'LIVE', snapshots: [s] })).toBe('UNAVAILABLE');
    expect(liquidityViewState({ tradable: true, connection: 'DISCONNECTED', snapshots: [s], replay: true })).toBe('REPLAY');
  });
});

describe('table, chart and markers', () => {
  const pools = snap().pools;
  it('FORMING / INVALIDATED are never listed; CONSUMED only on request', () => {
    const listed = filterPools(pools, { side: 'all', tf: 'ALL', state: 'ALL' });
    expect(listed.every((p) => p.state !== 'FORMING' && p.state !== 'INVALIDATED' && p.state !== 'CONSUMED')).toBe(true);
    expect(filterPools(pools, { side: 'all', tf: 'ALL', state: 'CONSUMED' }).every((p) => p.state === 'CONSUMED')).toBe(true);
  });
  it('relevance puts open liquidity first', () => {
    const sorted = sortByRelevance(filterPools(pools, { side: 'all', tf: 'ALL', state: 'ALL' }));
    const firstTaken = sorted.findIndex((p) => p.state === 'SWEPT');
    if (firstTaken >= 0) expect(sorted.slice(0, firstTaken).every((p) => p.state === 'ACTIVE' || p.state === 'TESTED')).toBe(true);
  });
  it('labels: "H1 BSL | 82", "SWEPT + RECLAIMED"; markers only for real sweep events of this timeframe', () => {
    const d = liquidityDrawables({ pools, filters: { side: 'all', tf: 'ALL', state: 'ALL' }, settings: S, selectedId: null, cluster: null });
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(S.maxDisplayedPools);
    for (const x of d) expect(x.label).toMatch(/^H1 (BSL|SSL) \| /);
    const swept = pools.find((p) => p.sweeps.length === 2)!;
    expect(stateLabel(swept)).toBe('SWEPT + RECLAIMED');
    const m = liquidityMarkers(pools, 'H1', { max: 100 });
    const events = pools.flatMap((p) => p.sweeps.map((e) => e.time));
    expect(m.filter((x) => x.kind === 'sweep').map((x) => x.time).sort()).toEqual([...events].sort());
    expect(liquidityMarkers(pools, 'M15')).toEqual([]);
    // Limited to drawn pools and the newest events.
    expect(liquidityMarkers(pools, 'H1', { poolIds: new Set() })).toEqual([]);
    expect(liquidityMarkers(pools, 'H1', { max: 1 })).toHaveLength(1);
  });
});
