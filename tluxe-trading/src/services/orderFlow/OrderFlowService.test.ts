import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderFlowEngine } from '../../engines/orderFlow/engine';
import { FULL_CAPS, StreamBuilder, TEST_TICK, baseBook, demoSession } from '../../engines/orderFlow/testing/scenarios';
import type { OrderFlowCapabilities, OrderFlowMsg } from '../../engines/orderFlow/types';
import { ScriptedOrderFlowProvider } from '../../providers/orderFlow/testing/ScriptedOrderFlowProvider';
import type { OrderFlowProviders } from '../../providers/orderFlow/types';
import { memoryStorage } from '../../test/providers';
import { connectServices, createServices, defaultProviders, type Services } from '../registry';
import { ORDER_FLOW_STALE_MS, PUBLISH_MS } from './OrderFlowService';

/* TEST DATA ONLY — scripted provider, never registered in production. */

let teardown: (() => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-06T15:00:00Z'));
});
afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

function setup(orderFlow: OrderFlowProviders | undefined, opts: { allowTest?: boolean; instrument?: string } = {}) {
  const services = createServices({ ...defaultProviders(), ...(orderFlow ? { orderFlow } : {}) }, { storage: memoryStorage({ 'tluxe.instrument.v1': opts.instrument ?? 'GC' }), allowTestProviders: opts.allowTest ?? true });
  teardown = connectServices(services);
  return services;
}
const scripted = (msgs: OrderFlowMsg[] = demoSession(), caps: OrderFlowCapabilities = FULL_CAPS, o: ConstructorParameters<typeof ScriptedOrderFlowProvider>[2] = {}) => new ScriptedOrderFlowProvider(msgs, caps, { tickSize: TEST_TICK, contract: 'TEST-GC', ...o });
const state = (s: Services) => {
  s.orderFlow.publish();
  return s.orderFlow.store.getState();
};

describe('OrderFlowService — no fake fallback', () => {
  it('production default: no Level-2 or trade provider → DATA UNAVAILABLE, nothing derived', () => {
    const s = setup(undefined);
    const st = state(s);
    expect(st.supported).toBe(true);
    expect(st.depth.status).toBe('DATA_UNAVAILABLE');
    expect(st.depth.detail).toBe('LEVEL-2 PROVIDER NOT CONNECTED');
    expect(st.trade.status).toBe('DATA_UNAVAILABLE');
    expect(st.trade.detail).toMatch(/TRADE .*NOT CONNECTED/);
    expect(st.depth.provider).toBeNull();
    expect(st.book).toBeNull();
    expect(st.totals).toBeNull();
    expect(st.cvd).toBe('UNAVAILABLE');
    expect(st.events).toEqual([]);
    expect(st.profile).toEqual([]);
    expect(s.orderFlow.engine()!.allColumns()).toHaveLength(0);
  });

  it('the default provider set has no order-flow providers', () => {
    expect(defaultProviders().orderFlow).toBeUndefined();
  });

  it('the registry refuses a TEST provider unless explicitly allowed', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p }, { allowTest: false });
    expect(p.connects).toBe(0);
    expect(p.subscriptions).toBe(0);
    const st = state(s);
    expect(st.depth.status).toBe('DATA_UNAVAILABLE');
    expect(st.trade.status).toBe('DATA_UNAVAILABLE');
  });

  it('spot / CFD instruments are not supported (no exchange Level-2) and are never subscribed', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p }, { instrument: 'XAUUSD' });
    const st = state(s);
    expect(st.supported).toBe(false);
    expect(st.reason).toMatch(/not an exchange-traded future/);
    expect(st.depth.status).toBe('DATA_UNAVAILABLE');
    expect(p.subscriptions).toBe(0);
  });
});

describe('OrderFlowService — live statuses', () => {
  it('goes LIVE only after a snapshot and fresh messages', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    expect(state(s).depth.status).toBe('CONNECTING'); // provider LIVE, but no snapshot yet
    p.emit(1); // snapshot
    expect(state(s).depth.status).toBe('LIVE');
    expect(state(s).book!.valid).toBe(true);
    expect(state(s).trade.status).toBe('CONNECTING');
    p.emitAll();
    const st = state(s);
    expect(st.trade.status).toBe('LIVE');
    expect(st.contract).toBe('TEST-GC');
    expect(st.events.length).toBeGreaterThan(0);
    expect(st.totals!.total).toBeGreaterThan(0);
  });

  it('becomes STALE when a stream is silent longer than the threshold', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    expect(state(s).depth.status).toBe('LIVE');
    vi.advanceTimersByTime(ORDER_FLOW_STALE_MS + 100);
    expect(state(s).depth.status).toBe('STALE');
    expect(state(s).trade.status).toBe('STALE');
  });

  it('shows the provider status as reported (never upgraded to LIVE)', () => {
    const p = scripted(undefined, undefined, { initialStatus: { depth: 'CONNECTING', trade: 'CONNECTING' } });
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    expect(state(s).depth.status).toBe('CONNECTING');
    p.setStatus('depth', 'LIVE');
    expect(state(s).depth.status).toBe('LIVE');
    expect(state(s).trade.status).toBe('CONNECTING');
  });

  it('depth unavailable while trades remain live (provider without Level-2)', () => {
    const p = scripted(undefined, { ...FULL_CAPS, depth: 'NONE', incrementalDepth: false, snapshotOnDemand: false });
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    const st = state(s);
    expect(st.depth.status).toBe('DATA_UNAVAILABLE');
    expect(st.trade.status).toBe('LIVE');
    expect(st.book).toBeNull(); // depth messages from a provider without Level-2 are never used
    expect(s.orderFlow.engine()!.depth.state).toBe('NO_DATA');
    expect(st.totals!.total).toBeGreaterThan(0);
  });

  it('trade provider only: depth reads LEVEL-2 PROVIDER NOT CONNECTED, trades live', () => {
    const p = scripted();
    const s = setup({ depth: null, trade: p });
    p.emitAll();
    const st = state(s);
    expect(st.depth.status).toBe('DATA_UNAVAILABLE');
    expect(st.depth.detail).toBe('LEVEL-2 PROVIDER NOT CONNECTED');
    expect(st.book).toBeNull();
    expect(st.trade.status).toBe('LIVE');
  });
});

describe('OrderFlowService — gaps, resync, reconnect', () => {
  it('a depth sequence gap requests a snapshot, rebuilds the book, then returns to LIVE', () => {
    const msgs = demoSession();
    const firstDepth = msgs.findIndex((m) => m.type === 'depth');
    const p = scripted(msgs, FULL_CAPS, { drop: new Set([firstDepth]) });
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    expect(p.snapshotRequests).toBe(1);
    const e = s.orderFlow.engine()!;
    expect(e.depth.gaps).toBe(1);
    expect(e.depth.snapshots).toBe(2);
    expect(e.bookValid).toBe(true);
    expect(state(s).depth.status).toBe('LIVE');
    // The rebuilt book equals the provider's true book (nothing lost, nothing invented).
    const ref = new OrderFlowEngine({ instrumentId: 'GC', tickSize: TEST_TICK, capabilities: FULL_CAPS });
    ref.processAll(msgs);
    expect(e.bookView()).toEqual(ref.bookView());
  });

  it('while the resync snapshot is pending: RESYNCING, no book, not LIVE', () => {
    const msgs = demoSession();
    const firstDepth = msgs.findIndex((m) => m.type === 'depth');
    const p = scripted(msgs, FULL_CAPS, { drop: new Set([firstDepth]) });
    const real = p.requestSnapshot.bind(p);
    p.requestSnapshot = () => void (p.snapshotRequests += 1);
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    let st = state(s);
    expect(st.depth.status).toBe('RESYNCING');
    expect(st.book).toBeNull();
    expect(p.snapshotRequests).toBe(1); // requested once, not per message
    real('GC');
    st = state(s);
    expect(st.depth.status).toBe('LIVE');
    expect(st.book!.valid).toBe(true);
  });

  it('without snapshot-on-demand a gap stays SEQUENCE GAP (never LIVE, no book)', () => {
    const msgs = demoSession();
    const firstDepth = msgs.findIndex((m) => m.type === 'depth');
    const p = scripted(msgs, { ...FULL_CAPS, snapshotOnDemand: false }, { drop: new Set([firstDepth]) });
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    const st = state(s);
    expect(st.depth.status).toBe('SEQUENCE_GAP');
    expect(st.book).toBeNull();
    expect(st.depth.integrity!.gaps).toBe(1);
  });

  it('a trade sequence gap flags the trade stream and CVD PARTIAL; depth unaffected', () => {
    const msgs = demoSession();
    const secondTrade = msgs.findIndex((m, i) => m.type === 'trade' && msgs.slice(0, i).some((x) => x.type === 'trade'));
    const p = scripted(msgs, FULL_CAPS, { drop: new Set([secondTrade]) });
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    const st = state(s);
    expect(st.trade.status).toBe('SEQUENCE_GAP');
    expect(st.cvd).toBe('PARTIAL');
    expect(st.depth.status).toBe('LIVE');
  });

  it('disconnect invalidates the book; after reconnect a fresh snapshot is required before LIVE', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    p.setStatus('depth', 'DISCONNECTED');
    let st = state(s);
    expect(st.depth.status).toBe('DISCONNECTED');
    expect(st.book).toBeNull();
    p.setStatus('depth', 'LIVE');
    expect(state(s).depth.status).toBe('CONNECTING'); // waiting for the snapshot
    p.requestSnapshot('GC');
    st = state(s);
    expect(st.depth.status).toBe('LIVE');
    expect(st.book!.valid).toBe(true);
  });
});

describe('OrderFlowService — lifecycle (HMR / subscriptions)', () => {
  it('connectServices is idempotent: exactly one connection and one subscription', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    connectServices(s);
    connectServices(s);
    s.orderFlow.start();
    expect(p.connects).toBe(1);
    expect(p.subscriptions).toBe(1);
  });

  it('HMR dispose + reconnect leaves exactly one live subscription', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    const unsub = vi.spyOn(p, 'unsubscribe');
    teardown!();
    expect(unsub).toHaveBeenCalledTimes(1);
    teardown = connectServices(s);
    expect(p.subscriptions - unsub.mock.calls.length).toBe(1);
  });

  it('instrument switch unsubscribes the old one first; unsupported instruments are not subscribed', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    const unsub = vi.spyOn(p, 'unsubscribe');
    s.instruments.select('XAUUSD');
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(p.subscriptions).toBe(1);
    s.instruments.select('GC');
    expect(p.subscriptions).toBe(2);
    expect(p.subscriptions - unsub.mock.calls.length).toBe(1);
  });

  it('store updates are batched — never one per message', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    const fn = vi.fn();
    const off = s.orderFlow.store.subscribe(fn);
    p.emitAll();
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(PUBLISH_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it('engine settings rebuild deterministically from the recording', () => {
    const msgs = demoSession();
    const p = scripted(msgs);
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    s.orderFlow.setEngineSettings({ largeTradeSize: 1000 });
    const e = s.orderFlow.engine()!;
    expect(e.events().some((x) => x.type === 'LARGE_TRADE')).toBe(false);
    const ref = new OrderFlowEngine({ instrumentId: 'GC', tickSize: TEST_TICK, capabilities: FULL_CAPS, settings: s.orderFlow.engineSettings() });
    ref.processAll(msgs);
    expect(e.digest()).toBe(ref.digest());
    s.orderFlow.setEngineSettings({ largeTradeSize: 50 });
    expect(s.orderFlow.engine()!.events().some((x) => x.type === 'LARGE_TRADE')).toBe(true);
  });

  it('replay of the recording equals the live engine', () => {
    const p = scripted();
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    const r = s.orderFlow.createReplay()!;
    r.step(s.orderFlow.recording().length);
    expect(r.engine.digest()).toBe(s.orderFlow.engine()!.digest());
  });

  it('the scripted resync snapshot reflects only its own TEST book', () => {
    const b = new StreamBuilder();
    const bk = baseBook();
    b.at(0).snapshot(bk.bids, bk.asks);
    const p = scripted(b.msgs);
    const s = setup({ depth: p, trade: p });
    p.emitAll();
    expect(state(s).book!.bestBid).toBe(2436.0);
  });
});
