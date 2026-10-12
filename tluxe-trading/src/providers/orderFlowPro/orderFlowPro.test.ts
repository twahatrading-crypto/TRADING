import { afterEach, describe, expect, it, vi } from 'vitest';
import { offlineStatus } from '../../engines/orderFlowPro/engine';
import { demoStatus } from '../../engines/orderFlowPro/testing/demoFixture';
import type { OfpRoot, SourceStatus } from '../../engines/orderFlowPro/types';
import backendSrc from './BackendSource.ts?raw';
import controllerSrc from './controller.ts?raw';
import { feedLabel } from '../../components/orderFlowPro/ofpFormat';
import { BackendSource, parseStatus, retryDelay } from './BackendSource';
import { DEFAULT_OFP_LINK, isLoopbackUrl, sanitizeOfpLink, type OfpLinkConfig } from './config';
import { OfpController } from './controller';
import type { OfpSource, SourceSink } from './source';
import { DemoSource } from './testing/DemoSource';

afterEach(() => vi.restoreAllMocks());

describe('backend link config', () => {
  it('accepts loopback backends only', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8770')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8770')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8770')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.5:8770')).toBe(false);
    expect(isLoopbackUrl('https://trading-production-e1d5.up.railway.app')).toBe(false);
    expect(isLoopbackUrl('http://user:pw@127.0.0.1:8770')).toBe(false);
    expect(sanitizeOfpLink({ backendUrl: 'http://10.0.0.2:8770', enabled: true }).backendUrl).toBe(DEFAULT_OFP_LINK.backendUrl);
  });
  it('is OFF by default (no background requests until the user enables it)', () => {
    expect(DEFAULT_OFP_LINK.enabled).toBe(false);
    expect(sanitizeOfpLink(null).enabled).toBe(false);
  });
});

describe('read-only guarantee (browser side)', () => {
  it('the backend client has no order / account / position endpoint and uses GET except contract selection', () => {
    // every endpoint the client can reach is one of the four read / select endpoints
    const endpoints = [...backendSrc.matchAll(/\/api\/[a-z/]+/g)].map((m) => m[0]);
    expect(new Set(endpoints)).toEqual(new Set(['/api/ofp/status', '/api/ofp/frames', '/api/ofp/history', '/api/ofp/select']));
    expect(backendSrc).not.toMatch(/placeOrder|cancelOrder|reqAccount|reqPositions|\/orders?\b/);
    const posts = backendSrc.match(/method: '(\w+)'/g) ?? [];
    expect(posts).toEqual(["method: 'POST'"]);
    expect(backendSrc).toMatch(/'\/api\/ofp\/select'/);
    expect(controllerSrc).not.toMatch(/placeOrder|account|position/i);
  });
});

describe('parseStatus', () => {
  const ok = { ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME' };
  it('accepts a well-formed backend status for the right root', () => {
    expect(parseStatus('GC', ok)).not.toBeNull();
    expect(parseStatus('SI', ok)).toBeNull();
  });
  it('never accepts DEMO from the backend and rejects unknown feed states', () => {
    expect(parseStatus('GC', demoStatus('GC', 1))).toBeNull();
    expect(parseStatus('GC', { ...ok, feed: 'SUPER_LIVE' })).toBeNull();
    expect(parseStatus('GC', { ...ok, feed: 'COMPETING_SESSION' })).not.toBeNull();
    expect(parseStatus('GC', { ...ok, feed: 'MODE_MISMATCH' })).not.toBeNull();
    expect(parseStatus('GC', null)).toBeNull();
  });
});

const sink = () => {
  const s = { statuses: [] as SourceStatus[], frames: 0, times: [] as number[] };
  const k: SourceSink = { status: (x) => s.statuses.push(x), frames: (f) => (s.frames += f.length), time: (t) => s.times.push(t) };
  return { s, k };
};

describe('BackendSource', () => {
  it('sends no request while the link is off', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    const src = new BackendSource(() => ({ ...DEFAULT_OFP_LINK }));
    const { s, k } = sink();
    const stop = src.subscribe('GC', k);
    await Promise.resolve();
    stop();
    expect(f).not.toHaveBeenCalled();
    expect(s.statuses[0]!.feed).toBe('BACKEND_OFFLINE');
  });

  it('passes the backend state through verbatim (DELAYED stays DELAYED) with the bearer token', async () => {
    const cfg: OfpLinkConfig = { ...DEFAULT_OFP_LINK, enabled: true, token: 't'.repeat(40) };
    const status = { ...offlineStatus('GC', 'DELAYED', ['delayed']), marketDataType: 'DELAYED' };
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(String(url).includes('/status') ? status : { frames: [{ root: 'GC', seq: 1, events: [] }], nextSeq: 1, serverTime: 5 }), { status: 200 }),
    );
    const src = new BackendSource(() => cfg);
    const { s, k } = sink();
    const stop = src.subscribe('GC', k);
    await vi.waitFor(() => expect(s.times).toContain(5));
    stop();
    expect(s.statuses[0]!.feed).toBe('DELAYED');
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${'t'.repeat(40)}`);
    expect(String(f.mock.calls[0]![0])).toMatch(/^http:\/\/127\.0\.0\.1:8770\/api\/ofp\/status\?root=GC$/);
  });

  it('an unreachable backend -> BACKEND_OFFLINE (never stale data shown as live)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const src = new BackendSource(() => ({ ...DEFAULT_OFP_LINK, enabled: true, token: 'x'.repeat(40) }));
    const { s, k } = sink();
    const stop = src.subscribe('SI', k);
    await vi.waitFor(() => expect(s.statuses.length).toBeGreaterThan(0));
    stop();
    expect(s.statuses[0]).toMatchObject({ root: 'SI', feed: 'BACKEND_OFFLINE' });
  });
});

describe('Phase 2B - browser reconnection (B5) and feed labels', () => {
  const cfg: OfpLinkConfig = { ...DEFAULT_OFP_LINK, enabled: true, token: 'k'.repeat(40) };
  const okStatus = { ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME' };

  it('retry delay grows exponentially and is capped', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(1000, 30000, n))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('reconnects automatically with back-off while the backend is down, then resumes', async () => {
    vi.useFakeTimers();
    let up = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!up) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(String(url).includes('/status') ? okStatus : { frames: [], nextSeq: 0, serverTime: 9, sessionId: 's1' }), { status: 200 });
    });
    const { s, k } = sink();
    const stop = new BackendSource(() => cfg).subscribe('GC', k);
    for (const ms of [0, 1000, 2000, 4000]) await vi.advanceTimersByTimeAsync(ms);
    const offline = s.statuses.filter((x) => x.feed === 'BACKEND_OFFLINE');
    expect(offline.map((x) => x.diagnostics[1])).toEqual([
      'Reconnecting automatically in 1 s (attempt 1).',
      'Reconnecting automatically in 2 s (attempt 2).',
      'Reconnecting automatically in 4 s (attempt 3).',
      'Reconnecting automatically in 8 s (attempt 4).',
    ]);
    up = true;
    await vi.advanceTimersByTimeAsync(8000);
    expect(s.statuses.at(-1)!.feed).toBe('LIVE');
    stop();
    vi.useRealTimers();
  });

  it('a backend restart (new session id) resets the engine and re-requests from a fresh snapshot', async () => {
    vi.useFakeTimers();
    // Settle pending promise chains (status fetch -> frames fetch -> json) at the CURRENT fake time.
    // Advances 0 ms per step: no timer is ever fast-forwarded and no timeout is extended.
    const settle = async () => {
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    };
    // Fake backend: session A then (after a restart) session B. Prices tag the session: A = 4000.x, B = 5000.x.
    let session = 'A';
    const lastSeq: Record<string, number> = { A: 0, B: 0 }; // highest sequence each backend session has served
    const log: Array<{ session: string; after: number }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/status')) return new Response(JSON.stringify({ ...okStatus, sessionId: session }), { status: 200 });
      const after = Number(u.searchParams.get('after'));
      log.push({ session, after });
      const px = session === 'A' ? 4000 : 5000;
      const trade = (seq: number) => ({ kind: 'trade', t: seq * 1000, price: px + seq / 10, size: 1, aggressor: 'BUY', method: 'QUOTE_RULE', bid: px, ask: px });
      // Real backend semantics: cursor 0 or a cursor beyond this session's sequence -> resync from the book snapshot.
      const resync = after === 0 || after > lastSeq[session]!;
      lastSeq[session] = resync ? 2 : after + 1;
      const body = resync
        ? { frames: [{ root: 'GC', seq: 1, events: [{ kind: 'book', t: 1, bids: [[px, 5]], asks: [[px + 0.1, 5]] }, trade(2)] }], nextSeq: 2, resync: true }
        : { frames: [{ root: 'GC', seq: after + 1, events: [trade(after + 1)] }], nextSeq: after + 1, resync: false };
      return new Response(JSON.stringify({ ...body, serverTime: 5, sessionId: session }), { status: 200 });
    });
    // Timeline of what the engine receives, in order.
    const timeline: Array<{ type: 'reset'; reason: string } | { type: 'frames'; prices: number[]; kinds: string[] }> = [];
    const k: SourceSink = {
      status: () => {},
      time: () => {},
      frames: (fs) => timeline.push({ type: 'frames', kinds: fs.flatMap((f) => f.events.map((e) => e.kind)), prices: fs.flatMap((f) => f.events.flatMap((e) => (e.kind === 'trade' ? [e.price] : []))) }),
      reset: (reason) => timeline.push({ type: 'reset', reason }),
    };
    const stop = new BackendSource(() => cfg).subscribe('GC', k);
    await settle();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await settle();
    }
    // Session A streamed normally: 0 -> 2 -> 3 -> 4 ...
    expect(log.map((x) => x.after)).toEqual([0, 2, 3, 4]);
    expect(vi.getTimerCount()).toBe(1); // exactly one poll loop

    session = 'B'; // backend process restarted: new session id, its sequence starts again from 1
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    // The poll that saw session B dropped its response, reset and scheduled ONE immediate re-request
    // (setTimeout 0). Like Node / browsers, the fake clock clamps a 0 ms timer to 1 ms, so it fires after 1 ms.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    // 1. the changed session id was detected -> exactly one reset
    const resets = timeline.filter((x) => x.type === 'reset');
    expect(resets).toEqual([{ type: 'reset', reason: 'Order Flow Pro backend restarted - stream restored from a fresh snapshot' }]);
    // 2. the old cursor (5) was used once against B (that response was dropped) and then discarded: next request is 0
    const bReqs = log.filter((x) => x.session === 'B').map((x) => x.after);
    expect(bReqs.slice(0, 2)).toEqual([5, 0]);
    // 3. after the reset the first data the engine receives is B's fresh snapshot (book first)
    const afterReset = timeline.slice(timeline.findIndex((x) => x.type === 'reset') + 1).filter((x) => x.type === 'frames');
    expect(afterReset[0]!.kinds[0]).toBe('book');
    // 5. no session-A data after the reset (A prices are 4000.x, B prices 5000.x); the dropped response was never applied
    expect(afterReset.flatMap((x) => x.prices).every((p) => p >= 5000)).toBe(true);

    // 4. the new stream resumes incrementally from B's own cursor
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await settle();
    }
    expect(log.filter((x) => x.session === 'B').map((x) => x.after)).toEqual([5, 0, 2, 3]);
    // 6. still exactly one poll loop (no duplicate timers created by the reset path)
    expect(vi.getTimerCount()).toBe(1);
    expect(timeline.filter((x) => x.type === 'reset')).toHaveLength(1);

    stop();
    expect(vi.getTimerCount()).toBe(0); // unsubscribing leaves no loop behind
    vi.useRealTimers();
  });

  it('a stream that fell behind the backend buffer (resync flag, same session) resets before applying', async () => {
    vi.useFakeTimers();
    const settle = async () => {
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    };
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/status')) return new Response(JSON.stringify({ ...okStatus, sessionId: 'S' }), { status: 200 });
      n++;
      const body = n === 2 ? { frames: [{ root: 'GC', seq: 7000, events: [{ kind: 'book', t: 9, bids: [], asks: [] }] }], nextSeq: 7000, resync: true } : { frames: [], nextSeq: n === 1 ? 10 : 7000, resync: false };
      return new Response(JSON.stringify({ ...body, serverTime: 1, sessionId: 'S' }), { status: 200 });
    });
    const order: string[] = [];
    const stop = new BackendSource(() => cfg).subscribe('GC', { status: () => {}, time: () => {}, frames: () => order.push('frames'), reset: () => order.push('reset') });
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(order).toEqual(['reset', 'frames']);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    vi.useRealTimers();
  });

  it('controller reset clears the engine and records the re-sync', () => {
    let resetFn: ((r: string) => void) | undefined;
    const src: OfpSource = {
      info: { id: 't', name: 't', demo: false },
      subscribe: (_root, sk) => {
        sk.frames([{ root: 'GC', seq: 1, events: [{ kind: 'trade', t: 60_000, price: 4000, size: 1, aggressor: 'BUY', method: 'QUOTE_RULE', bid: 3999.9, ask: 4000 }] }]);
        resetFn = sk.reset;
        return () => {};
      },
      history: async () => [],
    };
    const c = new OfpController(src);
    c.acquire('GC');
    expect(c.engines.GC.view('1m', 'ETH').bars).toHaveLength(1);
    resetFn!('Order Flow Pro backend restarted - stream restored from a fresh snapshot');
    const v = c.engines.GC.view('1m', 'ETH');
    expect(v.bars).toHaveLength(0);
    expect(v.alerts[0]!.text).toMatch(/backend restarted/);
  });

  it('new backend states are accepted and labelled; a quiet LIVE feed says so', () => {
    for (const feed of ['IDENTITY_UNCONFIRMED', 'ACCOUNT_UNVERIFIED'] as const) expect(parseStatus('GC', { ...okStatus, feed })).not.toBeNull();
    expect(feedLabel(offlineStatus('GC', 'IDENTITY_UNCONFIRMED', [])).text).toBe('IBKR IDENTITY NOT CONFIRMED');
    expect(feedLabel(offlineStatus('GC', 'ACCOUNT_UNVERIFIED', [])).text).toBe('ACCOUNT NOT VERIFIED');
    const health = {
      connection: 'OK',
      accountVerified: true,
      heartbeatAgeMs: 2000,
      ibkrLink: 'OK',
      streams: { mkt: 'ACTIVE', depth: 'ACTIVE', trades: 'ACTIVE', hist: 'ACTIVE' },
      activity: 'QUIET',
      quietForMs: 45_000,
      schedule: 'IN_SCHEDULE',
      depthPacing: { backoffS: 5, pending: null, suspended: null, retriesInWindow: 0 },
    } as const;
    const quiet = feedLabel({ ...(okStatus as SourceStatus), health });
    expect(quiet.text).toBe('LIVE · QUIET');
    expect(quiet.detail).toMatch(/not a gap/);
  });
});

describe('OfpController', () => {
  const counting = () => {
    const calls = { sub: 0, stop: 0 };
    const src: OfpSource = {
      info: { id: 't', name: 't', demo: false },
      subscribe: () => {
        calls.sub++;
        return () => calls.stop++;
      },
      history: async () => [],
    };
    return { calls, src };
  };

  it('refuses a DEMO source unless explicitly allowed', () => {
    const demo = new DemoSource({ t0: 0, historySeconds: 1 });
    expect(() => new OfpController(demo)).toThrow(/DEMO/);
    expect(() => new OfpController(demo, true)).not.toThrow();
  });

  it('ref-counts subscriptions per root (no duplicate poll chains)', () => {
    const { calls, src } = counting();
    const c = new OfpController(src);
    const a = c.acquire('GC');
    const b = c.acquire('GC');
    expect(calls.sub).toBe(1);
    a();
    a(); // double release is harmless
    expect(calls.stop).toBe(0);
    b();
    expect(calls.stop).toBe(1);
    expect(c.activeSubscriptions()).toEqual([]);
  });

  it('GC -> SI switch: one engine per root, state never shared', () => {
    const c = new OfpController(new DemoSource({ t0: Date.UTC(2026, 9, 9, 13), historySeconds: 600 }), true);
    const relGc = c.acquire('GC');
    relGc();
    const relSi = c.acquire('SI');
    expect(c.activeSubscriptions()).toEqual(['SI' as OfpRoot]);
    const gc = c.engines.GC.view('1m', 'ETH');
    const si = c.engines.SI.view('1m', 'ETH');
    expect(gc.status.contract!.localSymbol).toBe('DEMO-GCZ6');
    expect(si.status.contract!.localSymbol).toBe('DEMO-SIZ6');
    expect(si.last! < 100).toBe(true);
    expect(gc.last! > 1000).toBe(true);
    relSi();
  });

  it('replay runs in a separate engine and never mutates live state', async () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 9, 9, 13);
    const c = new OfpController(new DemoSource({ t0, historySeconds: 1200 }), true);
    const rel = c.acquire('GC');
    const liveVersion = c.engines.GC.version;
    await c.startReplay('GC', t0 + 600_000, t0 + 1_200_000, 60);
    expect(c.replay!.engine).not.toBe(c.engines.GC);
    vi.advanceTimersByTime(2000);
    expect(c.replay!.cursor).toBeGreaterThan(t0 + 600_000);
    expect(c.engines.GC.version).toBe(liveVersion);
    c.stopReplay();
    expect(c.replay).toBeNull();
    rel();
    vi.useRealTimers();
  });
});
