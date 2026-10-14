import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfpEvent, OfpFrame, SourceStatus } from '../../engines/orderFlowPro/types';
import activationRaw from './activation.ts?raw';
import { OfpController } from './controller';
import gatewayMapRaw from './gatewayMap.ts?raw';
import { GatewaySource, type GatewayLimits, type Visibility } from './GatewaySource';
import gatewaySourceRaw from './GatewaySource.ts?raw';
import type { SourceSink } from './source';
import { replayText } from '../../components/orderFlowPro/ofpSourceText';

/* Fake TLUXE gateway implementing the VERIFIED server semantics (bridge tape `since`, ibkr_relay `book` / `updates`,
 * Databento health, candles, recorded-depth heatmap). Deterministic, never LIVE outside these tests. */

const T0 = Date.UTC(2026, 9, 12, 14, 0, 0); // Monday 10:00 New York - inside the Globex session

interface FakeTrade { i: number; tsEventNs: number; tsRecvNs: number; price: number; size: number; side: 'A' | 'B' | 'N'; aggressor: string; sequence: number; contract: string }

class FakeGateway {
  contract = 'GCZ6';
  depthContract = 'GCZ6';
  depthExchange = 'COMEX';
  trades: FakeTrade[] = [];
  nextI = 1;
  floor = 1;
  /** Re-serve this many already-delivered trades (simulates a replay overlap). */
  overlap = 0;
  book = { state: 'LIVE', valid: true, epoch: 1, seq: 100, bids: new Map<number, number>([[4200.0, 5], [4199.9, 3]]), asks: new Map<number, number>([[4200.1, 4], [4200.2, 6]]), lastUpdateMs: T0 - 500 };
  ring: Array<[number, string, number, number, number]> = [];
  health = { status: 'LIVE', freshness: 'LIVE', reasons: [] as string[] };
  fail: null | 'network' | 'schema' | number = null;
  failPaths: RegExp | null = null;
  retryAfter: string | null = null;
  hold = false;
  /** Simulated network latency per response (ms) - production requests take time, letting polls interleave. */
  latencyMs = 0;
  requests: Array<{ path: string; method: string }> = [];
  signals: AbortSignal[] = [];
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number; isClosed: boolean }> = [];
  heat: { columns: unknown[]; firstRecordedMs: number | null; contract: string | null } = { columns: [], firstRecordedMs: T0 - 3600_000, contract: 'GCZ6' };

  addTrade(price: number, size: number, side: 'A' | 'B' | 'N', tMs: number) {
    const i = this.nextI++;
    this.trades.push({ i, tsEventNs: tMs * 1e6, tsRecvNs: (tMs + 3) * 1e6, price, size, side, aggressor: side === 'B' ? 'BUY' : side === 'A' ? 'SELL' : 'UNKNOWN', sequence: 1000 + i, contract: this.contract });
  }
  depthChange(side: 'bid' | 'ask', price: number, size: number, ms: number) {
    this.book.seq++;
    (side === 'bid' ? this.book.bids : this.book.asks).set(price, size);
    if (size === 0) (side === 'bid' ? this.book.bids : this.book.asks).delete(price);
    this.ring.push([this.book.seq, side, price, size, ms]);
    this.book.lastUpdateMs = ms;
  }
  /** Decoded response bytes served (JSON text), for bandwidth accounting. */
  bytes = 0;
  private json(status: number, body: unknown) {
    this.bytes += JSON.stringify(body).length;
    return { status, headers: { get: (k: string) => (k === 'Retry-After' ? this.retryAfter : null) }, json: async () => body } as unknown as Response;
  }
  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'https://gateway.test');
    this.requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET' });
    if (init?.signal) this.signals.push(init.signal);
    const q = url.searchParams;
    const respond = (): Response => {
      if (this.fail !== null && (!this.failPaths || this.failPaths.test(url.pathname))) {
        if (this.fail === 'network') throw new TypeError('Failed to fetch');
        if (this.fail === 'schema') return this.json(200, { unexpected: true });
        return this.json(this.fail, { error: { code: 'X' } });
      }
      const p = url.pathname;
      if (p === '/api/databento/v1/trades/GC') {
        const after = Number(q.get('after'));
        const limit = Number(q.get('limit'));
        const kept = this.trades.filter((t) => t.i >= this.floor);
        const last = this.nextI - 1;
        const first = kept[0]?.i ?? last + 1;
        const complete = !kept.length ? after >= last : after + 1 >= first || after >= last;
        return this.json(200, { root: 'GC', contract: this.contract, instrumentId: 41271, trades: kept.filter((t) => t.i > after - this.overlap).slice(0, limit), complete, lastIndex: last, cursor: 1 });
      }
      if (p === '/api/ibkr/book') {
        const b = this.book;
        return this.json(200, { root: 'GC', state: b.state, detail: null, valid: b.valid, epoch: b.epoch, depthSeq: b.seq, contract: { localSymbol: this.depthContract, symbol: 'GC', exchange: this.depthExchange, currency: 'USD' }, source: 'Interactive Brokers', depthType: 'PRICE_LEVEL', mbo: false, rows: { bids: Array(10).fill({}), asks: Array(10).fill({}) }, lastDepthMs: b.lastUpdateMs, lastUpdateMs: b.lastUpdateMs, serverMs: Date.now(), bids: [...b.bids].sort((x, y) => y[0] - x[0]), asks: [...b.asks].sort((x, y) => x[0] - y[0]) });
      }
      if (p === '/api/ibkr/updates') {
        const b = this.book;
        const epoch = Number(q.get('epoch'));
        const after = Number(q.get('after'));
        const base = { root: 'GC', state: b.state, detail: null, valid: b.valid, epoch: b.epoch, depthSeq: b.seq, serverMs: Date.now(), lastUpdateMs: b.lastUpdateMs };
        if (!b.valid || epoch !== b.epoch || after > b.seq) return this.json(200, { ...base, resync: true, changes: [] });
        const oldest = this.ring[0]?.[0] ?? b.seq + 1;
        if (after < b.seq && after + 1 < oldest) return this.json(200, { ...base, resync: true, changes: [] });
        return this.json(200, { ...base, resync: false, changes: this.ring.filter((c) => c[0] > after) });
      }
      if (p === '/api/databento/v1/health') {
        const last = this.trades[this.trades.length - 1];
        return this.json(200, { provider: 'Databento', timeMs: Date.now(), sessions: { tape: { state: 'CONNECTED' } }, instruments: { GC: { root: 'GC', contract: this.contract, status: this.health.status, freshness: this.health.freshness, reasons: this.health.reasons, lastEventNs: last ? last.tsEventNs : null } } });
      }
      if (p === '/api/databento/v1/candles/GC') {
        return this.json(200, { root: 'GC', contract: this.contract, instrumentId: 41271, timeframe: q.get('timeframe'), bars: q.get('timeframe') === 'M1' ? this.candles : [], source: 'databento' });
      }
      if (p === '/api/ibkr/heatmap') {
        return this.json(200, { root: 'GC', contract: this.heat.contract, provider: 'Interactive Brokers', depthType: 'PRICE_LEVEL', mbo: false, firstRecordedMs: this.heat.firstRecordedMs, bucketMs: Number(q.get('bucket')), from: Number(q.get('from')), to: Number(q.get('to')), columns: this.heat.columns });
      }
      return this.json(404, { error: { code: 'NOT_FOUND' } });
    };
    return new Promise((resolve, reject) => {
      const go = () => {
        try {
          resolve(respond());
        } catch (e) {
          reject(e);
        }
      };
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      if (this.hold) return;
      if (this.latencyMs > 0) setTimeout(go, this.latencyMs);
      else go();
    });
  };
}

function fakeVisibility() {
  let hidden = false;
  const ls = new Set<() => void>();
  const v: Visibility & { set(h: boolean): void; listeners: number } = {
    hidden: () => hidden,
    onChange: (cb) => {
      ls.add(cb);
      return () => ls.delete(cb);
    },
    set(h: boolean) {
      hidden = h;
      ls.forEach((cb) => cb());
    },
    get listeners() {
      return ls.size;
    },
  };
  return v;
}

function recorder() {
  const frames: OfpFrame[] = [];
  const statuses: SourceStatus[] = [];
  const resets: string[] = [];
  const sink: SourceSink = { frames: (f) => void frames.push(...f), status: (s) => void statuses.push(s), time: () => {}, reset: (r) => void resets.push(r) };
  const events = () => frames.flatMap((f) => f.events);
  const of = <K extends OfpEvent['kind']>(k: K) => events().filter((e): e is Extract<OfpEvent, { kind: K }> => e.kind === k);
  const last = () => statuses[statuses.length - 1]!;
  return { sink, frames, statuses, resets, events, of, last };
}

function setup(limits: Partial<GatewayLimits> = {}) {
  const gw = new FakeGateway();
  const vis = fakeVisibility();
  const src = new GatewaySource({ fetch: gw.fetch as typeof fetch, visibility: vis, random: () => 0.5, base: '' }, limits);
  return { gw, vis, src };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GatewaySource - live mapping', () => {
  it('trades carry exchange time + exchange aggressor; depth snapshot + updates; contract matched; LIVE', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.1, 2, 'B', T0 - 4000);
    gw.addTrade(4200.0, 1, 'A', T0 - 3000);
    gw.addTrade(4200.0, 3, 'N', T0 - 2000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    expect(r.statuses[0]!.feed).toBe('CONNECTING');
    await tick(1500);
    const trades = r.of('trade');
    expect(trades.map((t) => [t.price, t.size, t.aggressor, t.method, t.inferred])).toEqual([
      [4200.1, 2, 'BUY', 'EXCHANGE', false],
      [4200.0, 1, 'SELL', 'EXCHANGE', false],
      [4200.0, 3, 'UNKNOWN', 'EXCHANGE', false],
    ]);
    expect(trades[0]!.t).toBe(T0 - 4000);
    expect(trades[0]!.tRecv).toBe(T0 - 3997);
    expect(trades[2]!.basis).toBe('EXCHANGE_SIDE_NOT_REPORTED');
    expect(r.of('book')).toHaveLength(1);
    expect(r.of('quote')[0]).toMatchObject({ bid: 4200.0, ask: 4200.1 });
    gw.depthChange('bid', 4200.0, 9, T0 + 1200);
    await tick(1200);
    expect(r.of('depth').at(-1)).toMatchObject({ side: 'BID', price: 4200.0, size: 9, t: T0 + 1200 });
    const st = r.last();
    expect(st.feed).toBe('LIVE');
    expect(st.marketDataType).toBe('REALTIME');
    expect(st.contract).toMatchObject({ localSymbol: 'GCZ6', exchange: 'COMEX', verified: true, expiry: '202612' });
    expect(st.provenance!.trades.timeBasis).toBe('EXCHANGE_EVENT');
    expect(st.provenance!.depth.timeBasis).toBe('VPS_DEPTH_UPDATE');
    expect(st.provenance!.aggressor).toBe('EXCHANGE');
    expect(st.classification).toMatchObject({ method: 'EXCHANGE', inferred: false, volume: { BUY: 2, SELL: 1, UNKNOWN: 3 } });
    expect(st.capabilities).toMatchObject({ trades: 'AVAILABLE', aggressor: 'AVAILABLE', depth: 'AVAILABLE' });
    stop();
  });

  it('only GET requests to the five read-only gateway endpoints', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.1, 1, 'B', T0 - 1000);
    const stop = src.subscribe('GC', recorder().sink);
    await tick(10_000);
    stop();
    await src.history('GC', T0 - 600_000, T0);
    expect(gw.requests.length).toBeGreaterThan(5);
    for (const r of gw.requests) {
      expect(r.method).toBe('GET');
      expect(r.path).toMatch(/^\/api\/(databento\/v1\/(trades|candles)\/GC\?|databento\/v1\/health$|ibkr\/(book|updates|heatmap)\?)/);
    }
  });

  it('engine: exchange UNKNOWN prints are never re-classified, even with a quote present', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.1, 4, 'N', T0 - 1000); // at the ask - a quote rule would call it BUY
    const ctl = new OfpController(src);
    const release = ctl.acquire('GC');
    await tick(1500);
    const v = ctl.engines.GC.view('1m', 'ETH');
    expect(v.tape[0]).toMatchObject({ aggressor: 'UNKNOWN', method: 'EXCHANGE' });
    expect(v.stats.unknown).toBe(4);
    expect(v.stats.buy).toBe(0);
    expect(v.bookValid).toBe(true);
    release();
    ctl.dispose();
  });
});

describe('GatewaySource - continuity and contracts', () => {
  it('duplicates (overlapping pages) are dropped by transport index', async () => {
    const { gw, src } = setup();
    for (let k = 0; k < 5; k++) gw.addTrade(4200.0, 1, 'B', T0 - 5000 + k * 100);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    const n = r.of('trade').length;
    // the gateway re-serves already-delivered trades (a replayed overlap): nothing is applied twice
    gw.overlap = 3;
    gw.addTrade(4200.1, 9, 'A', T0 + 500);
    await tick(3000);
    expect(r.of('trade').length).toBe(n + 1);
    expect(r.of('trade').at(-1)).toMatchObject({ size: 9, aggressor: 'SELL' });
    expect(r.last().provenance!.quality.tradesDuplicate).toBeGreaterThanOrEqual(3);
    stop();
  });

  it('trades that left the gateway ring before being read -> explicit gap, never filled', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 5000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    for (let k = 0; k < 10; k++) gw.addTrade(4200.1, 1, 'B', T0 + 1000 + k);
    gw.floor = gw.nextI - 3; // 7 of the new trades already left the ring
    await tick(1100);
    const gaps = r.of('gap');
    expect(gaps.some((g) => /trade window moved on/.test(g.reason))).toBe(true);
    expect(r.of('trade').length).toBe(1 + 3);
    stop();
  });

  it('gateway restart (index went backwards) -> full reset, then real data only', async () => {
    const { gw, src } = setup();
    for (let k = 0; k < 4; k++) gw.addTrade(4200.0, 1, 'B', T0 - 5000 + k);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    gw.trades = [];
    gw.nextI = 1;
    gw.floor = 1;
    gw.addTrade(4200.2, 7, 'A', T0 + 500);
    await tick(3000);
    expect(r.resets.some((x) => /restarted/.test(x))).toBe(true);
    expect(r.of('trade').at(-1)).toMatchObject({ price: 4200.2, size: 7, aggressor: 'SELL' });
    stop();
  });

  it('contract roll GCZ6 -> GCG7: reset, contracts never combined', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 3000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    gw.contract = 'GCG7';
    gw.depthContract = 'GCG7';
    gw.trades = [];
    gw.addTrade(4230.0, 2, 'B', T0 + 2000);
    await tick(4000);
    expect(r.resets.some((x) => /GCZ6 → GCG7/.test(x))).toBe(true);
    const after = r.frames.slice(r.frames.findIndex((f) => f.seq === 1 && r.frames.indexOf(f) > 0));
    expect(after.flatMap((f) => f.events).filter((e) => e.kind === 'trade').every((e) => (e as { id?: string }).id?.startsWith('GCG7:'))).toBe(true);
    expect(r.last().contract!.localSymbol).toBe('GCG7');
    stop();
  });

  it('IBKR depth for another contract is withheld; trades stay LIVE', async () => {
    const { gw, src } = setup();
    gw.depthContract = 'GCG7';
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    expect(r.of('book')).toHaveLength(0);
    expect(r.of('depth')).toHaveLength(0);
    const st = r.last();
    expect(st.feed).toBe('LIVE');
    expect(st.provenance!.depth.state).toBe('CONTRACT_MISMATCH');
    expect(st.capabilities.depth).toBe('UNAVAILABLE');
    expect(st.contract!.verified).toBe(false);
    stop();
  });

  it('a non-COMEX depth exchange is withheld too', async () => {
    const { gw, src } = setup();
    gw.depthExchange = 'SMART';
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    expect(r.of('book')).toHaveLength(0);
    expect(r.last().provenance!.depth.state).toBe('CONTRACT_MISMATCH');
    stop();
  });
});

describe('GatewaySource - depth integrity', () => {
  it('a skipped depth sequence -> gap + fresh snapshot', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    gw.depthChange('ask', 4200.1, 2, T0 + 1600);
    gw.ring.push([gw.book.seq + 2, 'ask', 4200.3, 1, T0 + 1700]); // seq + 1 never arrives
    gw.book.seq += 2;
    await tick(1500);
    expect(r.of('gap').some((g) => /sequence gap/.test(g.reason))).toBe(true);
    expect(r.of('book').length).toBeGreaterThanOrEqual(2);
    expect(r.last().provenance!.quality.depthSeqGaps).toBe(1);
    stop();
  });

  it('gateway resync (new epoch) -> gap + fresh snapshot', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    gw.book.epoch = 2;
    await tick(2000);
    expect(r.of('gap').some((g) => /re-synchronised/.test(g.reason))).toBe(true);
    expect(r.last().provenance!.quality.depthResyncs).toBe(1);
    expect(r.of('book').length).toBe(2);
    stop();
  });

  it('IBKR depth STALE / invalid -> book withdrawn with a gap, status STALE', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    gw.book.state = 'STALE';
    gw.book.valid = false;
    await tick(2000);
    expect(r.of('gap').some((g) => /IBKR depth STALE/.test(g.reason))).toBe(true);
    expect(r.last().provenance!.depth.state).toBe('STALE');
    expect(r.last().feed).toBe('LIVE'); // trades unaffected, depth reported separately
    stop();
  });
});

describe('GatewaySource - freshness states', () => {
  it('Databento STALE -> feed STALE (never LIVE)', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    gw.health = { status: 'STALE', freshness: 'STALE', reasons: ['No Databento message'] };
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(6000);
    expect(r.last().feed).toBe('STALE');
    expect(r.last().marketDataType).toBeNull();
    stop();
  });

  it('Databento LIVE but no print for > 60 s -> LIVE · QUIET (not a gap)', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 90_000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(6000);
    expect(r.last().feed).toBe('LIVE');
    expect(r.last().provenance!.trades.state).toBe('QUIET');
    expect(r.of('gap')).toHaveLength(0);
    stop();
  });

  it('Databento UNAVAILABLE -> UNAVAILABLE', async () => {
    const { gw, src } = setup();
    gw.health = { status: 'AUTH_ERROR', freshness: 'UNAVAILABLE', reasons: ['key rejected'] };
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(6000);
    expect(r.last().feed).toBe('UNAVAILABLE');
    stop();
  });

  it('network failure -> DISCONNECTED with bounded back-off (no request storm)', async () => {
    const { gw, src } = setup();
    gw.fail = 'network';
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(60_000);
    expect(r.last().feed).toBe('DISCONNECTED');
    // healthy polling would be ~60 trades + ~12 health requests per minute; back-off keeps it far lower
    const tradesReq = gw.requests.filter((x) => x.path.includes('/trades/')).length;
    expect(tradesReq).toBeLessThanOrEqual(8);
    expect(r.last().provenance!.quality.requestErrors).toBeGreaterThan(0);
    // recovery: real data resumes, never back-filled with anything invented
    gw.fail = null;
    gw.addTrade(4200.0, 1, 'B', Date.now() - 500);
    await tick(35_000);
    expect(r.last().feed).toBe('LIVE');
    stop();
  });

  it('429 honours Retry-After', async () => {
    const { gw, src } = setup();
    gw.fail = 429;
    gw.failPaths = /trades/;
    gw.retryAfter = '20';
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(500);
    const n = gw.requests.filter((x) => x.path.includes('/trades/')).length;
    await tick(15_000);
    expect(gw.requests.filter((x) => x.path.includes('/trades/')).length).toBe(n);
    expect(r.last().provenance!.quality.rateLimited).toBeGreaterThan(0);
    stop();
  });

  it('unexpected response schema is an error, never data', async () => {
    const { gw, src } = setup();
    gw.fail = 'schema';
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(20_000);
    expect(r.of('trade')).toHaveLength(0);
    expect(r.of('book')).toHaveLength(0);
    expect(r.last().feed).toBe('DISCONNECTED');
    stop();
  });

  it('future-dated and badly out-of-order prints are rejected', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    gw.addTrade(4200.0, 1, 'B', T0 + 60_000); // 1 min in the future
    gw.addTrade(4200.0, 1, 'B', T0 - 10_000); // 9 s older than the newest accepted
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    expect(r.of('trade')).toHaveLength(1);
    const q = r.last().provenance!.quality;
    expect(q.tradesRejected).toBe(2);
    expect(q.tradesOutOfOrder).toBe(1);
    stop();
  });

  it('no data -> no events (nothing synthetic), never LIVE without a live source', async () => {
    const { gw, src } = setup();
    gw.book.valid = false;
    gw.book.state = 'RECONNECTING';
    gw.health = { status: 'RECONNECTING', freshness: 'OFFLINE', reasons: [] };
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(10_000);
    expect(r.events().filter((e) => e.kind !== 'gap')).toHaveLength(0);
    expect(r.statuses.some((s) => s.feed === 'LIVE')).toBe(false);
    stop();
  });
});

describe('GatewaySource - resource safety', () => {
  it('hidden page: no requests while hidden, depth re-synchronised with a gap on return', async () => {
    const { gw, src, vis } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    vis.set(true);
    const n = gw.requests.length;
    await tick(120_000);
    expect(gw.requests.length).toBe(n);
    gw.addTrade(4200.1, 2, 'B', T0 + 100_000);
    vis.set(false);
    await tick(2000);
    expect(r.of('gap').some((g) => /hidden/.test(g.reason))).toBe(true);
    expect(r.of('trade').at(-1)).toMatchObject({ price: 4200.1, size: 2 });
    stop();
  });

  it('unsubscribe aborts in-flight requests and stops polling', async () => {
    const { gw, src, vis } = setup();
    gw.hold = true;
    const stop = src.subscribe('GC', recorder().sink);
    await tick(50);
    expect(gw.signals.length).toBeGreaterThan(0);
    stop();
    expect(gw.signals.every((s) => s.aborted)).toBe(true);
    const n = gw.requests.length;
    await tick(60_000);
    expect(gw.requests.length).toBe(n);
    expect(vis.listeners).toBe(0);
  });

  it('one subscription per root across re-renders (controller ref-count)', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const ctl = new OfpController(src);
    const a = ctl.acquire('GC');
    const b = ctl.acquire('GC');
    const c = ctl.acquire('GC');
    await tick(10_000);
    const healthReq = gw.requests.filter((x) => x.path === '/api/databento/v1/health').length;
    expect(healthReq).toBeLessThanOrEqual(3); // one chain: ~every 5 s
    a();
    b();
    c();
    ctl.dispose();
  });

  it('steady-state request rate stays within budget (<= 4 req/s, far below the gateway 40 req/s limit)', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const stop = src.subscribe('GC', recorder().sink);
    await tick(10_000); // start-up (back-fill probes, bars)
    const n0 = gw.requests.length;
    for (let s = 0; s < 60; s++) {
      gw.addTrade(4200.0, 1, s % 2 ? 'A' : 'B', Date.now());
      gw.depthChange('bid', 4200.0, 5 + (s % 3), Date.now());
      await tick(1000);
    }
    const perSec = (gw.requests.length - n0) / 60;
    expect(perSec).toBeLessThanOrEqual(4);
    stop();
  });

  it('back-fill is bounded: older trades beyond the bound are an explicit gap', async () => {
    const { gw, src } = setup({ tradesPage: 10, backfillMaxPages: 2 });
    for (let k = 0; k < 60; k++) gw.addTrade(4200.0, 1, 'B', T0 - 3600_000 + k * 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    expect(r.of('trade').length).toBeLessThanOrEqual(20);
    expect(r.of('gap').some((g) => /Back-fill limited/.test(g.reason))).toBe(true);
    stop();
  });
});

describe('GatewaySource - no print lost at bar boundaries (regression: live cross-check vs Databento OHLCV)', () => {
  it('back-fill split across pages inside one minute, with depth polls in between: minute volume complete', async () => {
    const { gw, src } = setup({ tradesPage: 2, backfillMaxPages: 50 });
    gw.latencyMs = 120; // 13 pages x 120 ms: several depth polls (every 500 ms) land between pages // depth polls (500 ms) interleave with the paged back-fill, as in production
    const minute = Math.floor((T0 - 600_000) / 60_000) * 60_000;
    for (let k = 0; k < 23; k++) gw.addTrade(4200.0, 1 + (k % 3), k % 2 ? 'A' : 'B', minute + 1000 + k * 2000);
    gw.addTrade(4200.1, 1, 'B', T0 - 1000);
    const ctl = new OfpController(src);
    const release = ctl.acquire('GC');
    for (let s = 0; s < 10; s++) {
      gw.depthChange('bid', 4200.0, 3 + s, Date.now());
      await tick(1000);
    }
    const v = ctl.engines.GC.view('1m', 'ETH');
    const bar = v.bars.find((b) => b.t === minute)!;
    const expected = gw.trades.filter((t) => t.tsEventNs / 1e6 >= minute && t.tsEventNs / 1e6 < minute + 60_000).reduce((a, t) => a + t.size, 0);
    expect(bar.volume).toBe(expected);
    expect(v.stats.lateExcluded).toBe(0);
    release();
    ctl.dispose();
  });

  it('a print that reaches the gateway ~1.5 s after its minute ended still lands in that minute', async () => {
    const { gw, src } = setup();
    gw.latencyMs = 40;
    gw.addTrade(4200.0, 1, 'B', T0 - 5000);
    const ctl = new OfpController(src);
    const release = ctl.acquire('GC');
    await tick(3000);
    const nextMinute = Math.ceil(Date.now() / 60_000) * 60_000;
    await tick(nextMinute - 20_000 - Date.now()); // 40 s into the minute
    gw.addTrade(4200.0, 2, 'B', Date.now() - 500); // the minute's bar exists before the late print
    await tick(nextMinute - Date.now() + 1500); // depth polls run past the minute boundary
    gw.addTrade(4200.2, 6, 'A', nextMinute - 100); // printed 100 ms before the boundary, visible only now
    await tick(5000); // idle trades polls stretch up to 4 s; the minute must still not be finalized before the print
    const v = ctl.engines.GC.view('1m', 'ETH');
    const bar = v.bars.find((b) => b.t === nextMinute - 60_000)!;
    expect(bar.sell).toBeGreaterThanOrEqual(6);
    expect(v.stats.lateExcluded).toBe(0);
    release();
    ctl.dispose();
  });

  it('bars are loaded promptly after the trade back-fill (not after the 60 s idle check)', async () => {
    const { gw, src } = setup();
    gw.candles = [{ time: (Math.floor((T0 - 7200_000) / 60_000) * 60_000) / 1000, open: 4199, high: 4200, low: 4198, close: 4199.5, volume: 10, isClosed: true }];
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    expect(r.last().provenance!.bars.state).toBe('LIVE');
    stop();
  });
});

describe('GatewaySource - latency semantics', () => {
  it('latency = delivery lag of the newest print (not its age); back-fill does not count; quiet market does not grow it', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 3600_000); // old back-filled print
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(1500);
    expect(r.last().latencyMs).toBeNull();
    gw.addTrade(4200.1, 1, 'B', Date.now() - 200); // tRecv = t + 3 ms
    await tick(1000);
    const lag = r.last().latencyMs!;
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThan(1500);
    await tick(30_000); // quiet: no new print
    expect(r.last().latencyMs).toBe(lag);
    stop();
  });
});

describe('GatewaySource - bars and replay', () => {
  it('Databento bars only for slots before the first trade (BARS_ONLY, never a footprint)', async () => {
    const { gw, src } = setup();
    const firstT = T0 - 120_000;
    gw.candles = [
      { time: (firstT - 180_000) / 1000, open: 4199, high: 4200, low: 4198.5, close: 4199.5, volume: 30, isClosed: true },
      { time: (firstT - 120_000) / 1000, open: 4199.5, high: 4200, low: 4199, close: 4199.8, volume: 20, isClosed: true },
      { time: firstT / 1000, open: 4199.8, high: 4200.1, low: 4199.7, close: 4200, volume: 25, isClosed: true }, // overlaps trades
      { time: T0 / 1000, open: 4200, high: 4200, low: 4200, close: 4200, volume: 1, isClosed: false }, // forming
    ];
    gw.addTrade(4200.0, 1, 'B', firstT + 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    const bars = r.of('bar').filter((b) => b.tf === '1m');
    expect(bars.map((b) => b.t)).toEqual([firstT - 180_000, firstT - 120_000]);
    stop();
  });

  it('replay: real trades in range + recorded depth; uncovered depth is a gap; span bounded', async () => {
    const { gw, src } = setup();
    for (let k = 0; k < 30; k++) gw.addTrade(4200.0 + (k % 3) * 0.1, 1, k % 2 ? 'A' : 'B', T0 - 1800_000 + k * 60_000);
    gw.heat.columns = [
      [T0 - 600_000, 1.0, [[4200.0, 3.5]], [[4200.1, 2.25]]],
      [T0 - 595_000, 0.4, [[4200.0, 3.0]], [[4200.1, 2.0]]],
    ];
    const frames = await src.history('GC', T0 - 600_000, T0);
    const ev = frames.flatMap((f) => f.events);
    const tr = ev.filter((e) => e.kind === 'trade');
    expect(tr.length).toBe(10);
    expect(tr.every((t) => t.t >= T0 - 600_000 && t.t <= T0)).toBe(true);
    expect(ev.filter((e) => e.kind === 'book')).toHaveLength(1); // the 40 % covered bucket is not shown as a book
    expect(ev.filter((e) => e.kind === 'gap').some((g) => /incomplete/.test(g.reason))).toBe(true);
    await expect(src.history('GC', T0 - 5 * 3600_000, T0)).rejects.toThrow(/limited to 2 h/);
  });

  it('replay withholds recorded depth of another contract', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 60_000);
    gw.heat.contract = 'GCG7';
    gw.heat.columns = [[T0 - 60_000, 1.0, [[4200.0, 3]], [[4200.1, 2]]]];
    const ev = (await src.history('GC', T0 - 120_000, T0)).flatMap((f) => f.events);
    expect(ev.filter((e) => e.kind === 'book')).toHaveLength(0);
    expect(ev.some((e) => e.kind === 'gap' && /never mixed/.test(e.reason))).toBe(true);
  });
});

describe('static safety', () => {
  // Code only: comments may document what is refused (e.g. "MT5 spot names such as XAUUSD are rejected").
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const srcText = [gatewaySourceRaw, gatewayMapRaw, activationRaw].map(stripComments).join('\n');
  it('no write methods, no order / account / position vocabulary, no credentials', () => {
    expect(srcText).not.toMatch(/method:\s*'(POST|PUT|DELETE|PATCH)'/);
    expect(srcText).not.toMatch(/placeOrder|cancelOrder|order_send|submitOrder|\/orders?\b|reqPositions|reqAccount|executeTrade/i);
    expect(srcText).not.toMatch(/Authorization|Bearer|api[_-]?key|password|secret/i);
  });
  it('no synthetic generators and no MT5 / spot symbols', () => {
    expect(srcText).not.toMatch(/Math\.random\(\)|DemoSource|demoFixture/);
    expect(srcText).not.toMatch(/XAUUSD|XAGUSD|\/api\/mt5/);
  });
});


/* ============================================================================ Phase 3 */

const HOUR = 3600_000;

describe('Phase 3 - start-up window + on-demand earlier history', () => {
  /** 30 earlier-session prints (12:00-12:59) + 20 in the start-up window (13:00-13:59). T0 = 14:00. */
  function sessionData(gw: FakeGateway) {
    for (let k = 0; k < 30; k++) gw.addTrade(4199.0 + (k % 4) * 0.1, 1 + (k % 3), k % 2 ? 'A' : 'B', T0 - 2 * HOUR + k * 110_000);
    for (let k = 0; k < 20; k++) gw.addTrade(4200.0 + (k % 3) * 0.1, 2, k % 3 ? 'B' : 'A', T0 - HOUR + k * 170_000);
  }

  it('start-up loads only the hour-aligned window; session statistics flagged PARTIAL', async () => {
    const { gw, src } = setup();
    sessionData(gw);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    const trades = r.of('trade');
    expect(trades.length).toBe(20);
    expect(trades.every((t) => t.t >= T0 - HOUR && !t.history)).toBe(true);
    const h = r.last().provenance!.history!;
    expect(h.complete).toBe(false);
    expect(h.loadedFrom).toBe(T0 - HOUR);
    // pages (limit > 1) never start below the window: earlier prints are not downloaded at start-up
    const pages = gw.requests.filter((x) => /trades\/GC\?after=\d+&limit=(?!1$)\d+/.test(x.path));
    expect(pages.every((x) => Number(/after=(\d+)/.exec(x.path)![1]) >= 30)).toBe(true);
    stop();
  });

  it('on demand: earlier prints load once, merge exactly, never re-downloaded', async () => {
    const { gw, src } = setup();
    sessionData(gw);
    const ctl = new OfpController(src);
    const release = ctl.acquire('GC');
    await tick(3000);
    const all = gw.trades.reduce((a, t) => a + t.size, 0);
    await ctl.source.loadEarlierHistory!('GC');
    await tick(1500);
    const v = ctl.engines.GC.view('1h', 'ETH');
    expect(v.stats.volume).toBe(all);
    expect(v.stats.trades).toBe(50);
    expect(v.tape[0]!.t).toBe(gw.trades[gw.trades.length - 1]!.tsEventNs / 1e6); // newest stays newest
    const h = ctl.engines.GC.status.provenance!.history!;
    expect(h.complete).toBe(true);
    expect(h.historyLoaded).toBe(30);
    const n = gw.requests.length;
    await ctl.source.loadEarlierHistory!('GC'); // complete: no-op
    expect(gw.requests.length).toBe(n);
    release();
    ctl.dispose();
  });

  it('cancel then resume: every earlier print applied exactly once', async () => {
    const { gw, src } = setup({ tradesPage: 5 });
    sessionData(gw);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    gw.latencyMs = 100;
    const p1 = src.loadEarlierHistory('GC');
    await tick(850); // tip + probes + a few pages
    src.cancelEarlierHistory('GC');
    await p1;
    await tick(200);
    const mid = r.of('trade').filter((t) => t.history).length;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(30);
    expect(r.last().provenance!.history!.historyThrough).not.toBeNull();
    const p2 = src.loadEarlierHistory('GC');
    await tick(10_000);
    await p2;
    const hist = r.of('trade').filter((t) => t.history);
    expect(hist.length).toBe(30);
    expect(new Set(hist.map((t) => t.id)).size).toBe(30);
    expect(r.last().provenance!.history!.complete).toBe(true);
    stop();
  });

  it('earlier prints that left the gateway ring: unavailable range + gap, never filled', async () => {
    const { gw, src } = setup();
    sessionData(gw);
    gw.floor = 11; // prints 1-10 are gone
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    await src.loadEarlierHistory('GC');
    await tick(500);
    const h = r.last().provenance!.history!;
    expect(h.complete).toBe(false);
    expect(h.unavailable).not.toBeNull();
    expect(r.of('trade').filter((t) => t.history)).toHaveLength(20);
    expect(r.of('gap').some((g) => /left the gateway trade window/.test(g.reason))).toBe(true);
    stop();
  });

  it('contract roll during the history load: the load is discarded (nothing of the old contract is merged)', async () => {
    const { gw, src } = setup({ tradesPage: 5 });
    sessionData(gw);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    gw.latencyMs = 100;
    const p = src.loadEarlierHistory('GC');
    await tick(1000);
    gw.contract = 'GCG7';
    gw.depthContract = 'GCG7';
    gw.trades = [];
    gw.addTrade(4230.0, 1, 'B', Date.now());
    await tick(6000);
    await p;
    const afterReset = r.frames.slice(r.frames.map((f) => f.seq === 1).lastIndexOf(true));
    expect(afterReset.flatMap((f) => f.events).some((e) => e.kind === 'trade' && (e as { history?: boolean }).history)).toBe(false);
    expect(r.resets.some((x) => /GCZ6 → GCG7/.test(x))).toBe(true);
    stop();
  });

  it('a hidden page cancels the history load (resumable later)', async () => {
    const { gw, src, vis } = setup({ tradesPage: 5 });
    sessionData(gw);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    gw.latencyMs = 100;
    const p = src.loadEarlierHistory('GC');
    await tick(300);
    vis.set(true);
    await p;
    expect(r.last().provenance!.history!.loading).toBe(false);
    const n = gw.requests.length;
    await tick(30_000);
    expect(gw.requests.length).toBe(n);
    stop();
  });
});

describe('Phase 3 - gateway load', () => {
  it('idle market: polls back off (<= 1 req/s), and return to 1 s on the next print', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const stop = src.subscribe('GC', recorder().sink);
    await tick(20_000);
    const n0 = gw.requests.length;
    await tick(60_000); // nothing changes
    const idleRate = (gw.requests.length - n0) / 60;
    expect(idleRate).toBeLessThanOrEqual(1);
    gw.addTrade(4200.1, 1, 'B', Date.now());
    await tick(5000);
    const n1 = gw.requests.length;
    for (let k = 0; k < 10; k++) {
      gw.addTrade(4200.0, 1, 'B', Date.now());
      gw.depthChange('bid', 4200.0, 5 + k, Date.now());
      await tick(1000);
    }
    const busyRate = (gw.requests.length - n1) / 10;
    expect(busyRate).toBeGreaterThan(idleRate);
    expect(busyRate).toBeLessThanOrEqual(2.5);
    stop();
  });

  for (const viewers of [1, 2, 5, 10]) {
    it(`${viewers} simultaneous viewer(s): steady-state <= 2.3 req/s per viewer, linear (local simulation only)`, async () => {
      const gw = new FakeGateway();
      for (let k = 0; k < 200; k++) gw.addTrade(4200.0, 1, k % 2 ? 'A' : 'B', T0 - 1800_000 + k * 9000);
      const stops = Array.from({ length: viewers }, () => new GatewaySource({ fetch: gw.fetch as typeof fetch, visibility: null, random: () => 0.5 }).subscribe('GC', recorder().sink));
      await tick(10_000);
      const n0 = gw.requests.length;
      const b0 = gw.bytes;
      for (let s = 0; s < 120; s++) {
        gw.addTrade(4200.0 + (s % 3) * 0.1, 1, s % 2 ? 'A' : 'B', Date.now());
        gw.depthChange(s % 2 ? 'bid' : 'ask', s % 2 ? 4200.0 : 4200.1, 3 + (s % 5), Date.now());
        await tick(1000);
      }
      const perViewer = (gw.requests.length - n0) / 120 / viewers;
      const bytesPerViewer = (gw.bytes - b0) / 120 / viewers;
      expect(perViewer).toBeLessThanOrEqual(2.3);
      expect(bytesPerViewer).toBeLessThan(3000); // decoded bytes / s / viewer in steady state
      stops.forEach((s) => s());
    });
  }
});

describe('Phase 3 - replay honesty and isolation', () => {
  it('replay provenance: exact prints vs recorded depth aggregates; no exact snapshots claimed', async () => {
    const { gw, src } = setup();
    for (let k = 0; k < 12; k++) gw.addTrade(4200.0, 1, 'B', T0 - 600_000 + k * 40_000);
    gw.heat.columns = [
      [T0 - 600_000, 1.0, [[4200.0, 3.5]], [[4200.1, 2.25]]],
      [T0 - 595_000, 0.5, [[4200.0, 3.0]], [[4200.1, 2.0]]],
    ];
    const { provenance: p } = await src.historyDetailed('GC', T0 - 600_000, T0);
    expect(p.trades).toMatchObject({ kind: 'EXACT_PRINTS', count: 12, complete: true });
    expect(p.depth.kind).toBe('RECORDED_TIME_WEIGHTED_AGGREGATE');
    expect(p.depth.coveredBuckets).toBe(1);
    expect(p.exactDepthSnapshots).toBe('NOT_AVAILABLE');
    expect(p.gaps.length).toBeGreaterThan(0);
    const text = replayText(p);
    expect(text).toMatch(/12 exact historical prints/);
    expect(text).toMatch(/RECORDED AVERAGES.*NOT an exact order-book replay/);
    expect(text).toMatch(/exact historical book snapshots: not available/);
  });

  it('replay runs in its own engine: the live engine state is untouched', async () => {
    const { gw, src } = setup();
    for (let k = 0; k < 40; k++) gw.addTrade(4200.0 + (k % 5) * 0.1, 1 + (k % 2), k % 2 ? 'A' : 'B', T0 - 1200_000 + k * 30_000);
    gw.heat.columns = [[T0 - 900_000, 1.0, [[4200.0, 9]], [[4200.1, 9]]]];
    const ctl = new OfpController(src);
    const release = ctl.acquire('GC');
    await tick(3000);
    const live = ctl.engines.GC;
    // heatColumns grows with time from the LIVE depth recorder itself - excluded; everything data-derived is compared.
    const snap = () => {
      const v = live.view('1m', 'ETH');
      const stats = { ...v.stats, heatColumns: 0 };
      return JSON.stringify({ stats, bars: v.bars.map((b) => [b.t, b.volume, b.delta, b.buy, b.sell]), tape: v.tape.map((t) => t.id), book: v.book, gaps: v.gaps.length });
    };
    const before = snap();
    await ctl.startReplay('GC', T0 - 1200_000, T0 - 600_000, 60);
    expect(ctl.replay!.engine).not.toBe(live);
    expect(ctl.replay!.provenance!.trades.kind).toBe('EXACT_PRINTS');
    await tick(20_000);
    ctl.stopReplay();
    const after = snap();
    expect(after).toBe(before);
    release();
    ctl.dispose();
  });
});


describe('Phase 3 - browser clock skew (the gateway clock is used, never the PC clock)', () => {
  for (const skew of [10_000, -10_000]) {
    it(`PC clock ${skew > 0 ? 'FAST' : 'SLOW'} by 10 s: prints accepted, no minute finalized early, late print lands`, async () => {
      const gw = new FakeGateway();
      const src = new GatewaySource({ fetch: gw.fetch as typeof fetch, visibility: null, random: () => 0.5, now: () => Date.now() + skew });
      gw.addTrade(4200.0, 1, 'B', T0 - 5000);
      const ctl = new OfpController(src);
      const release = ctl.acquire('GC');
      await tick(4000);
      const nextMinute = Math.ceil(Date.now() / 60_000) * 60_000;
      await tick(nextMinute - 20_000 - Date.now());
      gw.addTrade(4200.0, 2, 'B', Date.now() - 500);
      await tick(nextMinute - Date.now() + 1500);
      gw.addTrade(4200.2, 6, 'A', nextMinute - 100); // late by ~1.5 s
      await tick(6000);
      const v = ctl.engines.GC.view('1m', 'ETH');
      expect(ctl.engines.GC.status.provenance!.quality.tradesRejected).toBe(0);
      const bar = v.bars.find((b) => b.t === nextMinute - 60_000)!;
      expect(bar.sell).toBeGreaterThanOrEqual(6);
      expect(v.stats.lateExcluded).toBe(0);
      release();
      ctl.dispose();
    });
  }
});


describe('Phase 3 - browser clock skew at the FIRST poll (before any depth response)', () => {
  it('PC clock 10 s FAST: the first poll does not finalize the current minute early', async () => {
    const gw = new FakeGateway();
    await tick(55_000); // 14:00:55 - subscribe 5 s before the minute ends
    gw.addTrade(4200.0, 1, 'B', Date.now() - 2000);
    const src = new GatewaySource({ fetch: gw.fetch as typeof fetch, visibility: null, random: () => 0.5, now: () => Date.now() + 10_000 });
    const ctl = new OfpController(src);
    const release = ctl.acquire('GC');
    await tick(1000);
    gw.addTrade(4200.2, 6, 'A', Date.now() - 300); // printed before 14:01:00, visible only now
    await tick(8000);
    const v = ctl.engines.GC.view('1m', 'ETH');
    const bar = v.bars.find((b) => b.t === T0)!;
    expect(bar.sell).toBe(6);
    expect(v.stats.lateExcluded).toBe(0);
    release();
    ctl.dispose();
  });

  it('PC clock 10 s SLOW: current prints at the first poll are not rejected as future-dated', async () => {
    const gw = new FakeGateway();
    gw.addTrade(4200.0, 3, 'B', T0 - 1000);
    const src = new GatewaySource({ fetch: gw.fetch as typeof fetch, visibility: null, random: () => 0.5, now: () => Date.now() - 10_000 });
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    expect(r.of('trade')).toHaveLength(1);
    expect(r.last().provenance!.quality.tradesRejected).toBe(0);
    stop();
  });
});


describe('Phase 3 - start-up state honesty under slow responses (regression: browser smoke test)', () => {
  it('slow start-up window: CONNECTING (never LIVE / QUIET) until prints are loaded; no DISCONNECTED while requests succeed; history offered only after', async () => {
    const { gw, src } = setup();
    for (let k = 0; k < 50; k++) gw.addTrade(4200.0, 1, k % 2 ? 'A' : 'B', T0 - 2 * HOUR + k * 140_000);
    gw.latencyMs = 4000; // every request slow: the whole start-up load takes far longer than the 25 s freshness window
    const r = recorder();
    // statuses published BEFORE the first print reached the sink (recorded at publish time, not sampled later)
    const beforeData: SourceStatus[] = [];
    const sink: SourceSink = { ...r.sink, status: (st) => (r.of('trade').length === 0 && beforeData.push(st), r.sink.status(st)) };
    const stop = src.subscribe('GC', sink);
    for (let s2 = 0; s2 < 90 && r.of('trade').length === 0; s2++) await tick(1000);
    expect(r.of('trade').length).toBeGreaterThan(0);
    expect(beforeData.some((st) => st.feed === 'LIVE')).toBe(false);
    expect(beforeData.some((st) => st.feed === 'DISCONNECTED')).toBe(false);
    expect(beforeData.every((st) => !st.provenance?.history)).toBe(true);
    await tick(15_000);
    expect(r.last().feed).toBe('LIVE');
    expect(r.last().provenance!.history).toBeDefined();
    stop();
  });
});

describe('depth freshness: a book that depth polls stop confirming is withdrawn (never shown / recorded as current)', () => {
  const DEPTH = /\/api\/ibkr\/(book|updates)/;

  it('depth request failures (HTTP 503) -> gap from the last confirmation within depthConfirmMaxMs; trades stay LIVE', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    expect(r.last().provenance!.depth.state).toBe('LIVE');
    const failFrom = Date.now();
    gw.fail = 503;
    gw.failPaths = DEPTH;
    await tick(8000);
    const g = r.of('gap').find((x) => /No IBKR depth confirmation/.test(x.reason));
    expect(g).toBeDefined();
    expect(g!.reason).toMatch(/HTTP 503.*book withdrawn; last confirmed \d\d:\d\d:\d\d UTC/);
    expect(g!.from).toBeLessThanOrEqual(failFrom + 1000); // starts at the last confirmed poll, not "now"
    const st = r.last();
    expect(st.provenance!.depth.state).toBe('DISCONNECTED'); // well before the 25 s stream timeout
    expect(st.provenance!.depth.detail).toMatch(/No IBKR depth confirmation/);
    expect(st.feed).toBe('LIVE');
    stop();
  });

  it('network failure of depth -> withdrawn as well', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    gw.fail = 'network';
    gw.failPaths = DEPTH;
    await tick(8000);
    expect(r.of('gap').some((x) => /No IBKR depth confirmation.*Failed to fetch/.test(x.reason))).toBe(true);
    stop();
  });

  it('recovery: a fresh snapshot is fetched and the book is current again (nothing carried over)', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    gw.fail = 503;
    gw.failPaths = DEPTH;
    await tick(8000);
    const books = () => gw.requests.filter((x) => /\/api\/ibkr\/book/.test(x.path)).length;
    const nBooks = books();
    const nSnap = r.of('book').length;
    gw.fail = null;
    gw.failPaths = null;
    await tick(40_000); // back-off after the failures is bounded
    expect(books()).toBeGreaterThan(nBooks);
    expect(r.of('book').length).toBeGreaterThan(nSnap);
    expect(r.last().provenance!.depth.state).toBe('LIVE');
    expect(r.last().provenance!.depth.detail ?? '').not.toMatch(/withdrawn/);
    stop();
  });

  it('a quiet book (successful polls, no changes, idle back-off) is never withdrawn', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(90_000);
    expect(r.of('gap').filter((x) => /No IBKR depth confirmation/.test(x.reason))).toEqual([]);
    expect(['LIVE', 'QUIET']).toContain(r.last().provenance!.depth.state);
    stop();
  });

  it('one transient failure shorter than the bound does not withdraw the book', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    gw.fail = 503;
    gw.failPaths = DEPTH;
    await tick(1100);
    gw.fail = null;
    gw.failPaths = null;
    await tick(15_000);
    expect(r.of('gap').filter((x) => /No IBKR depth confirmation/.test(x.reason))).toEqual([]);
    expect(r.last().provenance!.depth.state).toBe('LIVE');
    stop();
  });

  it('engine: the withdrawn book is no longer current and the outage is not recorded as valid book time', async () => {
    const { gw, src } = setup();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const ctl = new OfpController(src);
    const release = ctl.acquire('GC');
    await tick(5000);
    const eng = ctl.engines.GC;
    expect(eng.view('1m', 'ETH').bookValid).toBe(true);
    const before = eng.view('1m', 'ETH').recorder.coverage(Date.now(), 3600_000).validMs;
    gw.fail = 503;
    gw.failPaths = DEPTH;
    await tick(30_000);
    const v = eng.view('1m', 'ETH');
    expect(v.bookValid).toBe(false);
    expect(v.book).toEqual({ bids: [], asks: [] });
    expect(v.strong).toEqual([]);
    const added = v.recorder.coverage(Date.now(), 3600_000).validMs - before;
    // at most the confirmation bound (+ one poll) of the 30 s outage may have been integrated before the withdrawal
    expect(added).toBeLessThanOrEqual(src.limits.depthConfirmMaxMs + 2000);
    release();
    ctl.dispose();
  });
});

describe('depth freshness across a contract roll (no previous-contract watchdog state survives)', () => {
  const DEPTH = /\/api\/ibkr\/(book|updates)/;
  /** Environment that tracks the depth confirmation timers (identified by their arming call site). */
  function tracked() {
    const gw = new FakeGateway();
    const watch = new Set<ReturnType<typeof setTimeout>>();
    const env = {
      fetch: gw.fetch as typeof fetch,
      visibility: fakeVisibility(),
      random: () => 0.5,
      base: '',
      setTimeout: (fn: () => void, ms: number) => {
        const isWatch = /armDepthWatch/.test(new Error().stack ?? '');
        const h: ReturnType<typeof setTimeout> = setTimeout(() => {
          watch.delete(h);
          fn();
        }, ms);
        if (isWatch) watch.add(h);
        return h;
      },
      clearTimeout: (h: ReturnType<typeof setTimeout>) => {
        watch.delete(h);
        clearTimeout(h);
      },
    };
    return { gw, watch, src: new GatewaySource(env, {}) };
  }
  const roll = (gw: FakeGateway) => {
    gw.contract = 'GCG7';
    gw.depthContract = 'GCG7';
    gw.trades = [];
    gw.addTrade(4230.0, 2, 'B', Date.now());
  };

  it('the old contract confirmation timer is cleared by the reset; the new contract arms its own; teardown clears it', async () => {
    const { gw, watch, src } = tracked();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    let atReset = -1;
    const stop = src.subscribe('GC', { ...r.sink, reset: (x) => (r.sink.reset!(x), queueMicrotask(() => (atReset = watch.size))) });
    await tick(3000);
    expect(watch.size).toBe(1); // armed for the valid GCZ6 book
    roll(gw);
    await tick(4000);
    expect(r.resets.some((x) => /GCZ6 → GCG7/.test(x))).toBe(true);
    expect(atReset).toBe(0); // nothing of GCZ6 left pending at the reset
    expect(r.last().contract!.localSymbol).toBe('GCG7');
    expect(r.last().provenance!.depth).toMatchObject({ state: 'LIVE', contract: 'GCG7' });
    expect(watch.size).toBe(1); // GCG7's own deadline
    stop();
    expect(watch.size).toBe(0);
  });

  it('withdrawal then roll: the new contract never shows the old reason / confirmation time; correct status; recovers', async () => {
    const { gw, src } = tracked();
    gw.addTrade(4200.0, 1, 'B', T0 - 1000);
    const r = recorder();
    const stop = src.subscribe('GC', r.sink);
    await tick(3000);
    gw.fail = 503;
    gw.failPaths = DEPTH;
    await tick(8000);
    expect(r.last().provenance!.depth.detail).toMatch(/No IBKR depth confirmation.*last confirmed/);
    const resetAt = r.statuses.length;
    roll(gw); // depth still failing for the new contract
    await tick(4000);
    expect(r.resets.some((x) => /GCZ6 → GCG7/.test(x))).toBe(true);
    const g7 = r.statuses.slice(resetAt).filter((x) => x.contract?.localSymbol === 'GCG7');
    expect(g7.length).toBeGreaterThan(0);
    for (const x of g7) {
      expect(x.provenance!.depth.detail ?? '').not.toMatch(/No IBKR depth confirmation|last confirmed/);
      expect(x.provenance!.depth.contract).not.toBe('GCZ6');
      expect(['DISCONNECTED', 'UNAVAILABLE']).toContain(x.provenance!.depth.state);
    }
    expect(r.last().provenance!.depth.detail).toMatch(/gateway depth request failing \(HTTP 503\)/);
    gw.fail = null;
    gw.failPaths = null;
    await tick(40_000);
    expect(r.last().provenance!.depth).toMatchObject({ state: 'LIVE', contract: 'GCG7' });
    stop();
  });
});
