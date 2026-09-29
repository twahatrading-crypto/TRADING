import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTRUMENTS } from '../../config/instruments';
import { FULL_CAPS, TEST_TICK } from '../../engines/orderFlow/testing/scenarios';
import type { OrderFlowCapabilities, OrderFlowMsg } from '../../engines/orderFlow/types';
import { memoryStorage } from '../../test/providers';
import { connectServices, createServices, defaultProviders, type Services } from '../../services/registry';
import { composeOrderFlowProviders } from '../level2/composeOrderFlow';
import { ScriptedOrderFlowProvider } from '../orderFlow/testing/ScriptedOrderFlowProvider';
import type { OrderFlowSink } from '../orderFlow/types';
import { panelsOf } from '../../services/orderFlow/view';
import { IBKR_DEPTH_CAPS, IbkrDepthProvider, feedStatusOf, ibkrBook, ibkrHealth, type IbkrRow } from './IbkrDepthProvider';
import { visibleImbalance } from './ibkrView';

/* TEST DATA ONLY - a scripted TLUXE gateway answers /api/ibkr/*; no IBKR connection or account is involved. */

interface RootGw {
  state: string;
  detail: string | null;
  valid: boolean;
  epoch: number;
  depthSeq: number;
  bids: [number, number][];
  asks: [number, number][];
  changes: [number, 'bid' | 'ask', number, number, number][];
  rows?: { bids: IbkrRow[]; asks: IbkrRow[] };
  lastUpdateMs?: number;
}

function fakeGateway() {
  const roots: Record<string, RootGw> = {
    GC: { state: 'CONNECTING', detail: null, valid: false, epoch: 1, depthSeq: 0, bids: [], asks: [], changes: [] },
  };
  const urls: string[] = [];
  const fetchImpl = async (u: string) => {
    urls.push(u);
    const q = new URL(u, 'https://tluxe.example');
    const r = roots[q.searchParams.get('root') ?? 'GC'];
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (q.pathname.endsWith('/status')) return ok({ configured: true, link: { connected: true }, session: { state: r?.state }, roots: { GC: { state: r?.state } } });
    if (!r) return { ok: false, status: 400, json: async () => ({}) };
    const live = r.valid && r.state === 'LIVE';
    if (q.pathname.endsWith('/book')) return ok({ root: 'GC', state: r.state, detail: r.detail, valid: live, epoch: r.epoch, depthSeq: r.depthSeq, lastDepthMs: 1_000, serverMs: 1_000, bids: live ? r.bids : [], asks: live ? r.asks : [], rows: live ? r.rows : undefined, lastUpdateMs: r.lastUpdateMs });
    const epoch = Number(q.searchParams.get('epoch'));
    const after = Number(q.searchParams.get('after'));
    const resync = !live || epoch !== r.epoch || after > r.depthSeq;
    return ok({ state: r.state, detail: r.detail, valid: live, epoch: r.epoch, depthSeq: r.depthSeq, serverMs: 1_000, resync, changes: resync ? [] : r.changes.filter((c) => c[0] > after), rows: live ? r.rows : undefined, lastUpdateMs: r.lastUpdateMs });
  };
  return { roots, urls, fetchImpl };
}

function recordingSink() {
  const msgs: OrderFlowMsg[] = [];
  const statuses: [string, string, string | null | undefined][] = [];
  const caps: OrderFlowCapabilities[] = [];
  const sink: OrderFlowSink = {
    message: (m) => msgs.push(m),
    status: (_id, stream, status, detail) => statuses.push([stream, status, detail]),
    capabilities: (_id, c) => caps.push(c),
    contract: () => {},
  };
  return { sink, msgs, statuses, caps };
}

const GC = INSTRUMENTS.find((x) => x.id === 'GC')!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('IbkrDepthProvider (depth only, via the TLUXE gateway)', () => {
  it('snapshot then contiguous price-level changes; capabilities declared once; never MBO', async () => {
    const gw = fakeGateway();
    const p = new IbkrDepthProvider({ fetchImpl: gw.fetchImpl, pollMs: 100, statusMs: 1000 });
    const r = recordingSink();
    p.connect(r.sink);
    p.subscribe(GC);
    expect(r.caps).toEqual([IBKR_DEPTH_CAPS]);
    expect(IBKR_DEPTH_CAPS.depth).toBe('MBP');
    expect(r.statuses.at(-1)?.[1]).toBe('CONNECTING');
    Object.assign(gw.roots.GC!, { state: 'LIVE', valid: true, depthSeq: 10, bids: [[4150.0, 5]], asks: [[4150.1, 3]] });
    await vi.advanceTimersByTimeAsync(2100);
    const snap = r.msgs.find((m) => m.type === 'snapshot');
    expect(snap).toMatchObject({ type: 'snapshot', instrumentId: 'GC', seq: 1, bids: [{ price: 4150.0, size: 5 }], asks: [{ price: 4150.1, size: 3 }] });
    expect(r.statuses.at(-1)?.[1]).toBe('LIVE');
    gw.roots.GC!.changes = [
      [11, 'bid', 4150.0, 9, 2_000],
      [12, 'ask', 4150.1, 0, 2_001],
    ];
    gw.roots.GC!.depthSeq = 12;
    await vi.advanceTimersByTimeAsync(150);
    const depth = r.msgs.filter((m) => m.type === 'depth');
    expect(depth.map((m) => [m.seq, m.type === 'depth' && m.action, m.type === 'depth' && m.size, m.exchTime])).toEqual([
      [2, 'set', 9, 2_000],
      [3, 'delete', 0, 2_001],
    ]);
    expect(r.caps).toHaveLength(1); // availability changes never re-declare capabilities (that would rebuild the engine)
    p.disconnect();
  });

  it('IBKR not LIVE: book invalidated FIRST (sequence break), then an honest non-LIVE status; resync from a fresh snapshot', async () => {
    const gw = fakeGateway();
    const p = new IbkrDepthProvider({ fetchImpl: gw.fetchImpl, pollMs: 100 });
    const r = recordingSink();
    p.connect(r.sink);
    p.subscribe(GC);
    Object.assign(gw.roots.GC!, { state: 'LIVE', valid: true, depthSeq: 10, bids: [[4150.0, 5]], asks: [[4150.1, 3]] });
    await vi.advanceTimersByTimeAsync(2100);
    Object.assign(gw.roots.GC!, { state: 'AUTH_REQUIRED', valid: false, detail: 'IBKR login / 2FA required' });
    await vi.advanceTimersByTimeAsync(150);
    const marker = r.msgs.at(-1)!;
    expect(marker).toMatchObject({ type: 'depth', seq: 3 }); // seq 2 skipped: the engine enters SEQUENCE GAP
    expect(r.statuses.at(-1)).toEqual(['depth', 'DATA_UNAVAILABLE', 'IBKR AUTH REQUIRED — IBKR login / 2FA required']);
    Object.assign(gw.roots.GC!, { state: 'LIVE', valid: true, detail: null, epoch: 2, depthSeq: 40, bids: [[4151.0, 2]], asks: [[4151.1, 4]], changes: [] });
    await vi.advanceTimersByTimeAsync(2100);
    const snap = r.msgs.at(-1)!;
    expect(snap).toMatchObject({ type: 'snapshot', seq: 4, bids: [{ price: 4151.0, size: 2 }] }); // seq above the marker: never applied
    expect(r.statuses.at(-1)?.[1]).toBe('LIVE');
    p.disconnect();
  });

  it('only GC / SI; states map to engine statuses; only same-origin gateway URLs (never localhost / a VPS / a home PC)', async () => {
    const gw = fakeGateway();
    const p = new IbkrDepthProvider({ fetchImpl: gw.fetchImpl });
    const r = recordingSink();
    p.connect(r.sink);
    p.subscribe(INSTRUMENTS.find((x) => x.id === 'XAUUSD')!);
    expect(r.statuses.at(-1)?.[1]).toBe('DATA_UNAVAILABLE');
    p.subscribe(GC);
    await vi.advanceTimersByTimeAsync(2500);
    expect(gw.urls.length).toBeGreaterThan(0);
    expect(gw.urls.every((u) => u.startsWith('/api/ibkr/'))).toBe(true);
    expect(ibkrHealth.getState().status?.configured).toBe(true);
    expect(feedStatusOf('LIVE')).toBe('LIVE');
    expect(feedStatusOf('STALE')).toBe('STALE');
    expect(feedStatusOf('OFFLINE')).toBe('DISCONNECTED');
    for (const s of ['AUTH_REQUIRED', 'NOT_ENTITLED', 'NOT_CONFIGURED', 'CONTRACT_UNRESOLVED'] as const) expect(feedStatusOf(s)).toBe('DATA_UNAVAILABLE');
    p.disconnect();
  });
});

describe('provider isolation through the real OrderFlowService (Databento-style trades + IBKR depth)', () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  function setup() {
    const gw = fakeGateway();
    const ibkr = new IbkrDepthProvider({ fetchImpl: gw.fetchImpl, pollMs: 100 });
    const t0 = Date.now();
    const trades: OrderFlowMsg[] = Array.from({ length: 40 }, (_, i) => ({ type: 'trade' as const, instrumentId: 'GC' as const, seq: null, exchTime: t0 + i * 100, recvTime: t0 + i * 100 + 5, price: 4150 + (i % 3) * 0.1, size: 1 + (i % 4), aggressor: i % 2 ? ('BUY' as const) : ('SELL' as const) }));
    const trade = new ScriptedOrderFlowProvider(trades, { ...FULL_CAPS, depth: 'NONE' }, { tickSize: TEST_TICK, contract: 'GCZ6' });
    const services: Services = createServices({ ...defaultProviders(), orderFlow: composeOrderFlowProviders(ibkr, trade) }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'GC' }), allowTestProviders: true });
    teardown = connectServices(services);
    return { gw, trade, services };
  }

  it('IBKR outage clears depth but never touches the Databento trade history; Databento outage leaves depth LIVE', async () => {
    const { gw, trade, services } = setup();
    trade.emit(20);
    Object.assign(gw.roots.GC!, { state: 'LIVE', valid: true, depthSeq: 10, bids: [[4150.0, 5], [4149.9, 7]], asks: [[4150.1, 3]] });
    await vi.advanceTimersByTimeAsync(2500);
    const engine = () => services.orderFlow.engine()!;
    expect(engine().bookValid).toBe(true);
    const trades = engine().sessionTotals().trades;
    const recorded = services.orderFlow.recording().filter((m) => m.type === 'trade').length;
    expect(trades).toBe(20);
    // IBKR goes offline: depth invalid, trades untouched (no engine rebuild).
    Object.assign(gw.roots.GC!, { state: 'OFFLINE', valid: false, detail: 'IBKR VPS bridge link offline' });
    await vi.advanceTimersByTimeAsync(300);
    expect(engine().bookValid).toBe(false);
    expect(engine().bookView().valid).toBe(false);
    expect(panelsOf(engine()).book).toBeNull(); // the COB shows LEVEL-2 DATA UNAVAILABLE, never the last levels
    expect(engine().sessionTotals().trades).toBe(trades);
    expect(services.orderFlow.recording().filter((m) => m.type === 'trade').length).toBe(recorded);
    services.orderFlow.publish();
    expect(services.orderFlow.store.getState().depth.status).toBe('DISCONNECTED');
    expect(services.orderFlow.store.getState().trade.status).toBe('LIVE');
    // More Databento trades keep flowing while IBKR is down.
    trade.emit(10);
    expect(engine().sessionTotals().trades).toBe(30);
    // IBKR back: a FRESH snapshot rebuilds the book (the continuity marker is never applied).
    Object.assign(gw.roots.GC!, { state: 'LIVE', valid: true, detail: null, epoch: 2, depthSeq: 50, bids: [[4151.0, 2]], asks: [[4151.1, 4]] });
    await vi.advanceTimersByTimeAsync(2500);
    expect(engine().bookValid).toBe(true);
    expect(engine().bookView().bids.map((l) => [l.price, l.size])).toEqual([[4151.0, 2]]);
    expect(engine().sessionTotals().trades).toBe(30);
    // Databento trade stream disconnects: IBKR depth stays LIVE (independent streams).
    trade.setStatus('trade', 'DISCONNECTED', 'Databento offline');
    services.orderFlow.publish();
    expect(services.orderFlow.store.getState().depth.status).toBe('LIVE');
    expect(services.orderFlow.store.getState().trade.status).toBe('DISCONNECTED');
  });
});

describe('IBKR visible price-level rows (DOM)', () => {
  const row = (position: number, price: number, size: number): IbkrRow => ({ position, price, size, marketMaker: null });

  it('shows the rows only while LIVE, never lets an older lastUpdate overwrite newer rows, clears on failure', async () => {
    const gw = fakeGateway();
    const p = new IbkrDepthProvider({ fetchImpl: gw.fetchImpl, pollMs: 100, statusMs: 1000 });
    const r = recordingSink();
    p.connect(r.sink);
    p.subscribe(GC);
    Object.assign(gw.roots.GC!, { state: 'LIVE', valid: true, depthSeq: 1, bids: [[4150.0, 5]], asks: [[4150.1, 3]],
                                  rows: { bids: [row(0, 4150.0, 5)], asks: [row(0, 4150.1, 3)] }, lastUpdateMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2100);
    expect(ibkrBook.getState().GC).toMatchObject({ bids: [{ position: 0, price: 4150.0, size: 5, marketMaker: null }], lastUpdateMs: 2_000 });
    const since = ibkrBook.getState().GC!.since;
    // an older response (lastUpdate 1_500) never replaces the newer rows
    Object.assign(gw.roots.GC!, { rows: { bids: [row(0, 4149.0, 99)], asks: [] }, lastUpdateMs: 1_500 });
    await vi.advanceTimersByTimeAsync(300);
    expect(ibkrBook.getState().GC!.bids[0]!.price).toBe(4150.0);
    Object.assign(gw.roots.GC!, { rows: { bids: [row(0, 4150.2, 7)], asks: [row(0, 4150.3, 1)] }, lastUpdateMs: 2_500 });
    await vi.advanceTimersByTimeAsync(300);
    expect(ibkrBook.getState().GC).toMatchObject({ bids: [{ price: 4150.2, size: 7 }], lastUpdateMs: 2_500, since });
    // not LIVE -> the DOM is cleared (old depth is never shown as live)
    Object.assign(gw.roots.GC!, { state: 'OFFLINE', valid: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(ibkrBook.getState().GC).toBeNull();
    // only the same-origin gateway is ever called - never the VPS, never with a credential
    expect(gw.urls.every((u) => u.startsWith('/api/ibkr/'))).toBe(true);
    p.disconnect();
  });

  it('UNSUPPORTED / NOT_ENTITLED / CONTRACT_MISMATCH are unavailable, not live', () => {
    for (const s of ['UNSUPPORTED', 'NOT_ENTITLED', 'CONTRACT_MISMATCH'] as const) expect(feedStatusOf(s)).toBe('DATA_UNAVAILABLE');
  });

  it('visible-book imbalance uses only the published rows (no inferred orders)', () => {
    const im = visibleImbalance([row(0, 10, 30), row(1, 9.9, 10)], [row(0, 10.1, 20)]);
    expect(im).toEqual({ bid: 40, ask: 20, ratio: 2, imbalance: 20 / 60 });
    expect(visibleImbalance([], [])).toEqual({ bid: 0, ask: 0, ratio: null, imbalance: null });
  });
});
