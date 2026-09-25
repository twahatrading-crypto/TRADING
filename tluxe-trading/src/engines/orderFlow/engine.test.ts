import { describe, expect, it } from 'vitest';
import { DEFAULT_ORDER_FLOW_SETTINGS } from './config';
import { OrderFlowEngine, cmeSessionStart, rangeProfile } from './engine';
import { FULL_CAPS, StreamBuilder, TEST_INSTRUMENT, TEST_T0, TEST_TICK, baseBook, demoSession, generatedSession } from './testing/scenarios';
import type { OrderFlowCapabilities, OrderFlowMsg } from './types';

/* TEST DATA ONLY — every stream here is a hand-built synthetic fixture. */

const engine = (caps: OrderFlowCapabilities = FULL_CAPS, settings = {}) =>
  new OrderFlowEngine({ instrumentId: TEST_INSTRUMENT, tickSize: TEST_TICK, capabilities: caps, settings: { ...DEFAULT_ORDER_FLOW_SETTINGS, ...settings } });

const run = (msgs: readonly OrderFlowMsg[], caps: OrderFlowCapabilities = FULL_CAPS, settings = {}) => {
  const e = engine(caps, settings);
  e.processAll(msgs);
  return e;
};

const withSnapshot = () => {
  const b = new StreamBuilder();
  const bk = baseBook();
  b.at(0).snapshot(bk.bids, bk.asks);
  return b;
};

describe('order book', () => {
  it('builds the book from a snapshot: best bid / ask, spread and totals', () => {
    const e = run(withSnapshot().msgs);
    const v = e.bookView();
    expect(e.bookValid).toBe(true);
    expect(v.valid).toBe(true);
    expect(v.bestBid).toBe(2436.0);
    expect(v.bestAsk).toBe(2436.1);
    expect(v.spread).toBe(0.1);
    expect(v.bids).toHaveLength(10);
    expect(v.asks).toHaveLength(10);
    expect(v.bids[0]!.price).toBeGreaterThan(v.bids[1]!.price);
    expect(v.asks[0]!.price).toBeLessThan(v.asks[1]!.price);
    // sizes 80, 90, … 170 on each side
    expect(v.totalBid).toBe(1250);
    expect(v.totalAsk).toBe(1250);
    expect(v.crossed).toBe(false);
    expect(e.depth.snapshots).toBe(1);
  });

  it('applies incremental add, modify, cancel, execute and delete', () => {
    const b2 = withSnapshot();
    b2.at(100).depth('ask', 2437.1, 40, 'add'); // new level
    b2.at(200).depth('ask', 2436.1, 200, 'modify'); // modify best ask
    b2.at(300).depth('bid', 2436.0, 30, 'cancel'); // partial cancel
    b2.at(400).depth('bid', 2435.9, 50, 'execute'); // partial execution
    b2.at(500).depth('ask', 2436.2, 0, 'delete'); // level removed
    const e2 = run(b2.msgs);
    const s = (side: 'bid' | 'ask', p: number) => e2.book.size(side, e2.book.tick(p));
    expect(s('ask', 2437.1)).toBe(40);
    expect(s('ask', 2436.1)).toBe(200);
    expect(s('bid', 2436.0)).toBe(30);
    expect(s('bid', 2435.9)).toBe(50);
    expect(s('ask', 2436.2)).toBe(0);
    expect(e2.bookView().asks.some((l) => l.price === 2436.2)).toBe(false);
    expect(e2.depth.lastSeq).toBe(5);
  });

  it('removing the best level moves best bid / ask and the spread', () => {
    const b = withSnapshot();
    b.at(100).depth('ask', 2436.1, 0, 'delete').depth('bid', 2436.0, 0, 'delete');
    const v = run(b.msgs).bookView();
    expect(v.bestBid).toBe(2435.9);
    expect(v.bestAsk).toBe(2436.2);
    expect(v.spread).toBe(0.3);
  });

  it('reports a crossed book as published instead of fixing it', () => {
    const b = withSnapshot();
    b.at(100).depth('bid', 2436.3, 10, 'add');
    const v = run(b.msgs).bookView();
    expect(v.crossed).toBe(true);
    expect(v.bestBid).toBe(2436.3);
  });

  it('keys levels by integer tick (no float drift)', () => {
    const b = withSnapshot();
    b.at(100).depth('ask', 2436.1 + 1e-9, 7, 'set');
    const e = run(b.msgs);
    expect(e.book.size('ask', e.book.tick(2436.1))).toBe(7);
    expect(e.bookView().asks.filter((l) => l.price === 2436.1)).toHaveLength(1);
  });
});

describe('integrity: duplicates, out-of-order, gaps, resync', () => {
  it('drops a duplicate depth message and counts it', () => {
    const b = withSnapshot();
    b.at(100).depth('ask', 2436.1, 55);
    const e = run(b.msgs);
    const before = e.bookView();
    e.process(b.msgs[1]!);
    expect(e.depth.duplicates).toBe(1);
    expect(e.bookView()).toEqual(before);
  });

  it('drops an out-of-order depth message and counts it', () => {
    const b = withSnapshot();
    b.at(100).depth('ask', 2436.1, 55).depth('ask', 2436.1, 66);
    const e = run(b.msgs);
    e.process({ ...b.msgs[1]!, seq: 1 } as OrderFlowMsg);
    e.process({ ...b.msgs[1]!, seq: 0 } as OrderFlowMsg);
    expect(e.depth.duplicates + e.depth.outOfOrder).toBe(2);
    expect(e.depth.outOfOrder).toBeGreaterThanOrEqual(1);
    expect(e.book.size('ask', e.book.tick(2436.1))).toBe(66);
  });

  it('a depth sequence gap marks the book unreliable, buffers updates and resyncs from a snapshot', () => {
    const b = withSnapshot();
    b.at(100).depth('ask', 2436.1, 55); // seq 1
    b.at(200).depth('ask', 2436.2, 11, 'set', 3); // seq 3 — seq 2 missing
    b.at(300).depth('ask', 2436.3, 22); // seq 4
    const e = run(b.msgs);
    expect(e.depth.state).toBe('SEQUENCE_GAP');
    expect(e.depth.gaps).toBe(1);
    expect(e.bookValid).toBe(false);
    expect(e.needsSnapshot).toBe(true);
    expect(e.bookView().valid).toBe(false);
    expect(e.depth.buffered).toBe(2);
    // Buffered updates are NOT applied to the untrusted book.
    expect(e.book.size('ask', e.book.tick(2436.3))).toBe(100);

    // Resync snapshot at seq 3 (already includes seq 2 and 3); only seq 4 must be replayed on top.
    const bk = baseBook();
    const asks = bk.asks.map((l) => (l.price === 2436.2 ? { ...l, size: 11 } : l.price === 2436.1 ? { ...l, size: 55 } : l));
    e.process({ type: 'snapshot', instrumentId: TEST_INSTRUMENT, seq: 3, exchTime: TEST_T0 + 400, recvTime: TEST_T0 + 401, bids: bk.bids, asks });
    expect(e.depth.state).toBe('READY');
    expect(e.bookValid).toBe(true);
    expect(e.depth.buffered).toBe(0);
    expect(e.depth.lastSeq).toBe(4);
    expect(e.book.size('ask', e.book.tick(2436.3))).toBe(22);
    expect(e.book.size('ask', e.book.tick(2436.2))).toBe(11);
    expect(e.depth.snapshots).toBe(2);
  });

  it('columns while the book is unreliable are NO DATA (never drawn from a gapped book)', () => {
    const b = withSnapshot();
    b.at(1500).depth('ask', 2436.1, 55);
    b.at(2500).depth('ask', 2436.2, 11, 'set', 5); // gap
    b.at(3500).heartbeat('depth');
    b.at(4500).heartbeat('depth');
    const cols = run(b.msgs).allColumns();
    expect(cols.find((c) => c.t === TEST_T0 + 1000)!.valid).toBe(true);
    for (const t of [2000, 3000, 4000]) expect(cols.find((c) => c.t === TEST_T0 + t)!.valid).toBe(false);
  });

  it('depth updates before any snapshot wait for one (AWAITING_SNAPSHOT)', () => {
    const b = new StreamBuilder();
    b.at(0).depth('ask', 2436.1, 55);
    const e = run(b.msgs);
    expect(e.depth.state).toBe('AWAITING_SNAPSHOT');
    expect(e.bookValid).toBe(false);
    expect(e.bookView().bids).toHaveLength(0);
  });

  it('a stale (older) snapshot never replaces a newer consistent book', () => {
    const b = withSnapshot();
    b.at(100).depth('ask', 2436.1, 55).depth('ask', 2436.1, 66);
    const e = run(b.msgs);
    const bk = baseBook();
    e.process({ type: 'snapshot', instrumentId: TEST_INSTRUMENT, seq: 1, exchTime: TEST_T0 + 200, recvTime: TEST_T0 + 201, bids: bk.bids, asks: bk.asks });
    expect(e.book.size('ask', e.book.tick(2436.1))).toBe(66);
    expect(e.depth.outOfOrder).toBe(1);
  });

  it('trade duplicates / out-of-order are dropped; a trade gap is counted and makes CVD PARTIAL', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 5, 'BUY').trade(2436.0, 3, 'SELL');
    const e = run(b.msgs);
    e.process(b.msgs[2]!); // duplicate
    e.process(b.msgs[1]!); // out of order
    expect(e.trade.duplicates).toBe(1);
    expect(e.trade.outOfOrder).toBe(1);
    expect(e.sessionTotals().total).toBe(8);
    expect(e.cvdAvailability()).toBe('FULL');
    e.process({ type: 'trade', instrumentId: TEST_INSTRUMENT, seq: 10, exchTime: TEST_T0 + 200, recvTime: TEST_T0 + 203, price: 2436.1, size: 2, aggressor: 'BUY' });
    expect(e.trade.gaps).toBe(1);
    expect(e.cvdAvailability()).toBe('PARTIAL');
    // Missing prints are never invented.
    expect(e.sessionTotals().trades).toBe(3);
  });

  it('a trade gap does not invalidate the depth book (independent streams)', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 5, 'BUY').trade(2436.1, 5, 'BUY', 9);
    const e = run(b.msgs);
    expect(e.trade.gaps).toBe(1);
    expect(e.bookValid).toBe(true);
  });

  it('ignores messages for another instrument', () => {
    const b = withSnapshot();
    const e = run(b.msgs);
    const d = e.digest();
    e.process({ type: 'trade', instrumentId: 'XAUUSD', seq: 1, exchTime: TEST_T0 + 5, recvTime: TEST_T0 + 6, price: 1, size: 1, aggressor: 'BUY' });
    expect(e.digest()).toBe(d);
  });

  it('records latency from exchange vs receive time', () => {
    const e = run(withSnapshot().msgs);
    expect(e.depth.latencyMs).toBe(3);
  });
});

describe('trades, CVD and volume profile', () => {
  it('CVD += buy − sell; UNKNOWN volume never enters CVD', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 10, 'BUY').trade(2436.0, 4, 'SELL').trade(2436.0, 3, 'UNKNOWN');
    const e = run(b.msgs);
    const t = e.sessionTotals();
    expect(t).toMatchObject({ buy: 10, sell: 4, unknown: 3, total: 17, cvd: 6, trades: 3 });
    expect(e.cvdAvailability()).toBe('PARTIAL'); // unknown volume present
  });

  it('CVD is FULL only with aggressor side, no unknown volume and no gaps', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 10, 'BUY').trade(2436.0, 4, 'SELL');
    expect(run(b.msgs).cvdAvailability()).toBe('FULL');
  });

  it('a provider without aggressor side yields only UNKNOWN volume and CVD UNAVAILABLE', () => {
    const caps = { ...FULL_CAPS, aggressorSide: false };
    const b = withSnapshot();
    b.at(100).trade(2436.1, 10, 'BUY').trade(2436.0, 4, 'SELL');
    const e = run(b.msgs, caps);
    expect(e.sessionTotals()).toMatchObject({ buy: 0, sell: 0, unknown: 14, cvd: 0 });
    expect(e.cvdAvailability()).toBe('UNAVAILABLE');
    expect(e.lastTradeInfo()!.aggressor).toBe('UNKNOWN');
  });

  it('CVD is UNAVAILABLE without trades', () => {
    expect(run(withSnapshot().msgs, { ...FULL_CAPS, trades: false }).cvdAvailability()).toBe('UNAVAILABLE');
  });

  it('builds the session volume profile per price, UNKNOWN kept apart', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 10, 'BUY').trade(2436.1, 2, 'UNKNOWN').trade(2436.0, 4, 'SELL').trade(2436.1, 1, 'SELL');
    const p = run(b.msgs).sessionProfile();
    expect(p).toEqual([
      { price: 2436.1, buy: 10, sell: 1, unknown: 2 },
      { price: 2436.0, buy: 0, sell: 4, unknown: 0 },
    ]);
  });

  it('visible-range profile sums only the columns in range', () => {
    const b = withSnapshot();
    b.at(500).trade(2436.1, 10, 'BUY');
    b.at(1500).trade(2436.1, 5, 'SELL');
    b.at(2500).trade(2436.0, 7, 'UNKNOWN');
    const e = run(b.msgs);
    const p = rangeProfile(e.allColumns(), TEST_T0 + 1000, TEST_T0 + 2000, (t) => e.book.price(t));
    expect(p).toEqual([
      { price: 2436.1, buy: 0, sell: 5, unknown: 0 },
      { price: 2436.0, buy: 0, sell: 0, unknown: 7 },
    ]);
  });

  it('session totals reset at the CME session start (17:00 Chicago)', () => {
    expect(new Date(cmeSessionStart(TEST_T0)).toISOString()).toBe('2026-01-05T23:00:00.000Z');
    const b = new StreamBuilder();
    b.t = Date.UTC(2026, 0, 6, 22, 59, 0);
    b.trade(2436.1, 10, 'BUY');
    b.t = Date.UTC(2026, 0, 6, 23, 1, 0);
    b.trade(2436.1, 3, 'SELL');
    const e = run(b.msgs);
    expect(e.sessionTotals()).toMatchObject({ buy: 0, sell: 3, cvd: -3, trades: 1 });
  });
});

describe('heatmap columns', () => {
  it('stores the displayed book per fixed time column (deterministic from exchange time)', () => {
    const b = withSnapshot();
    b.at(1200).depth('ask', 2436.1, 55);
    b.at(2200).heartbeat('depth');
    const cols = run(b.msgs).allColumns();
    expect(cols.map((c) => c.t - TEST_T0)).toEqual([0, 1000, 2000]);
    // The column in which the first snapshot arrived had no book before it: NO DATA (conservative).
    expect(cols.map((c) => c.valid)).toEqual([false, true, true]);
    const c1 = cols[1]!;
    const i = [...c1.askTicks].indexOf(24361);
    expect(c1.askSizes[i]).toBe(55);
    expect(cols[2]!.askSizes[[...cols[2]!.askTicks].indexOf(24362)]).toBe(90);
  });

  it('does not carry the book across a silence longer than maxCarryMs (NO DATA, no inferred history)', () => {
    const b = withSnapshot();
    b.at(20_000).heartbeat('depth');
    const cols = run(b.msgs).allColumns();
    const gap = cols.filter((c) => c.t > TEST_T0 && c.t < TEST_T0 + 20_000);
    expect(gap.length).toBe(19);
    expect(gap.every((c) => !c.valid && c.bidTicks.length === 0 && c.askTicks.length === 0)).toBe(true);
  });

  it('carries the book across a short, observed silence', () => {
    const b = withSnapshot();
    b.at(3000).heartbeat('depth');
    const cols = run(b.msgs).allColumns();
    expect(cols.filter((c) => c.t > TEST_T0 && c.t < TEST_T0 + 3000).every((c) => c.valid)).toBe(true);
  });

  it('rolling history keeps at most maxColumns columns', () => {
    const e = run(generatedSession(3), FULL_CAPS, { maxColumns: 50 });
    expect(e.columns.length).toBe(50);
    expect(e.allColumns().length).toBe(51);
    const ts = e.columns.map((c) => c.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('records trades per column by aggressor', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 10, 'BUY').trade(2436.1, 2, 'UNKNOWN');
    b.at(1100).heartbeat('depth');
    const c = run(b.msgs).allColumns()[0]!;
    expect(c.trades).toEqual([{ tick: 24361, buy: 10, sell: 0, unknown: 2 }]);
    expect(c.cvd).toBe(10);
    expect(c.lastTick).toBe(24361);
  });
});

describe('event engine (documented rules, TEST DATA scenario)', () => {
  const e = run(demoSession());
  const ev = e.events();
  const of = (type: string) => ev.filter((x) => x.type === type);

  it('LARGE TRADE: a single print ≥ largeTradeSize, side as supplied', () => {
    const lt = of('LARGE_TRADE');
    expect(lt.length).toBeGreaterThan(0);
    expect(lt.every((x) => x.size >= DEFAULT_ORDER_FLOW_SETTINGS.largeTradeSize)).toBe(true);
    expect(lt.some((x) => x.price === 2436.1 && x.size === 70 && x.side === 'BUY')).toBe(true);
    // 49-lot and smaller prints never qualify
    const small = withSnapshot();
    small.at(100).trade(2436.1, 49, 'BUY');
    expect(run(small.msgs).events().filter((x) => x.type === 'LARGE_TRADE')).toHaveLength(0);
  });

  it('LIQUIDITY HIT: ≥ hitFraction of a displayed ≥ hitMinDepth level executed', () => {
    const hit = of('LIQUIDITY_HIT').find((x) => x.price === 2436.1);
    expect(hit).toBeDefined();
    expect(hit!.evidence.displayed).toBe(120);
    expect(hit!.evidence.executed).toBeGreaterThanOrEqual(60);
  });

  it('DEPTH SWEEP: classified prints through ≥ 3 distinct levels within the window', () => {
    const sw = of('DEPTH_SWEEP');
    expect(sw.length).toBe(1);
    expect(sw[0]!.side).toBe('BUY');
    expect(Number(sw[0]!.evidence.levels)).toBeGreaterThanOrEqual(3);
    expect(sw[0]!.detail).toMatch(/2436\.1/);
    expect(sw[0]!.detail).toMatch(/2436\.4/);
  });

  it('DEPTH SWEEP is never built from UNKNOWN prints', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 50, 'UNKNOWN');
    b.at(150).trade(2436.2, 50, 'UNKNOWN');
    b.at(200).trade(2436.3, 50, 'UNKNOWN');
    b.at(250).trade(2436.4, 50, 'UNKNOWN');
    b.at(2000).heartbeat('depth');
    expect(run(b.msgs).events().filter((x) => x.type === 'DEPTH_SWEEP')).toHaveLength(0);
  });

  it('DEPTH SWEEP needs the prints within sweepWindowMs', () => {
    const b = withSnapshot();
    b.at(100).trade(2436.1, 5, 'BUY');
    b.at(400).trade(2436.2, 5, 'BUY');
    b.at(700).trade(2436.3, 5, 'BUY');
    b.at(3000).heartbeat('depth');
    expect(run(b.msgs).events().filter((x) => x.type === 'DEPTH_SWEEP')).toHaveLength(0);
  });

  it('STACKING: bid 2435.5 grows by ≥ 150 and ≥ 2× within the window', () => {
    const st = of('STACKING').find((x) => x.price === 2435.5);
    expect(st).toBeDefined();
    expect(st!.side).toBe('bid');
  });

  it('PULLING: ask 2436.5 displayed size falls with no prints there', () => {
    const pl = of('PULLING').find((x) => x.price === 2436.5);
    expect(pl).toBeDefined();
    expect(pl!.side).toBe('ask');
    expect(pl!.detail).toMatch(/300/);
  });

  it('PULLING is not claimed when the decrease is explained by executions', () => {
    const b = withSnapshot();
    b.at(100).depth('ask', 2436.1, 400, 'add');
    b.at(500).trade(2436.1, 350, 'BUY').depth('ask', 2436.1, 50, 'set');
    b.at(5000).heartbeat('depth');
    expect(run(b.msgs).events().filter((x) => x.type === 'PULLING')).toHaveLength(0);
  });

  it('PULLING is disabled (with a stated limitation) without depth reasons and without trades', () => {
    const e2 = run(demoSession(), { ...FULL_CAPS, trades: false, depthReasons: false });
    expect(e2.events().filter((x) => x.type === 'PULLING')).toHaveLength(0);
    expect(e2.limitations().join(' ')).toMatch(/PULLING disabled/);
  });

  it('ABSORPTION CANDIDATE: ≥ 300 aggressive volume into 2436.4, no progress, the level still displayed', () => {
    const ab = of('ABSORPTION_CANDIDATE').find((x) => x.price === 2436.4);
    expect(ab).toBeDefined();
    expect(Number(ab!.evidence.aggressiveVolume)).toBeGreaterThanOrEqual(300);
    expect(Number(ab!.evidence.progressTicks)).toBeLessThanOrEqual(1);
    expect(Number(ab!.evidence.remainingDisplayed)).toBeGreaterThanOrEqual(50);
  });

  it('sweep / absorption are unavailable without exchange aggressor side, and say so', () => {
    const e2 = run(demoSession(), { ...FULL_CAPS, aggressorSide: false });
    expect(e2.events().filter((x) => x.type === 'DEPTH_SWEEP' || x.type === 'ABSORPTION_CANDIDATE')).toHaveLength(0);
    expect(e2.limitations().join(' ')).toMatch(/aggressor side/);
  });

  it('never claims spoofing, iceberg or intent; events carry measured evidence and deterministic ids', () => {
    for (const x of ev) {
      expect(`${x.type} ${x.detail}`).not.toMatch(/spoof|iceberg|institution/i);
      expect(Object.keys(x.evidence).length).toBeGreaterThan(0);
      expect(x.id.startsWith(`${x.type}:`)).toBe(true);
    }
    expect(new Set(ev.map((x) => x.id)).size).toBe(ev.length);
  });

  it('keeps at most maxEvents events', () => {
    const e2 = run(demoSession(), FULL_CAPS, { maxEvents: 2, largeTradeSize: 1 });
    expect(e2.events().length).toBeLessThanOrEqual(2);
  });

  it('no depth-based events while the book is unreliable', () => {
    const b = withSnapshot();
    b.at(100).depth('bid', 2435.5, 100, 'set', 5); // gap → unreliable
    b.at(1000).depth('bid', 2435.5, 400, 'add');
    b.at(2000).depth('bid', 2435.5, 800, 'add');
    b.at(3000).heartbeat('depth');
    expect(run(b.msgs).events().filter((x) => x.type === 'STACKING' || x.type === 'PULLING')).toHaveLength(0);
  });
});

describe('determinism', () => {
  it('the same stream gives the same digest', () => {
    expect(run(demoSession()).digest()).toBe(run(demoSession()).digest());
    expect(run(generatedSession(2, 3)).digest()).toBe(run(generatedSession(2, 3)).digest());
  });

  it('message-by-message equals processAll', () => {
    const msgs = generatedSession(2, 9);
    const a = engine();
    for (const m of msgs) a.process(m);
    expect(a.digest()).toBe(run(msgs).digest());
  });
});
