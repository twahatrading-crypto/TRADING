import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { feedLabelFor } from '../../components/market/feedLabel';
import { connectServices, createServices, defaultProviders, type Services } from '../../services/registry';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { DatabentoFootprintProvider, DatabentoMarketProvider, DatabentoOrderFlowProvider } from './adapters';
import { DatabentoBridgeClient } from './client';
import { DATABENTO_CONFIG_KEY, DEFAULT_DATABENTO_CONFIG, sanitizeDatabentoConfig } from './config';
import { DatabentoFeed } from './DatabentoFeed';
import type { DbRoot } from './protocol';
import { FakeBridge, status } from './testing/FakeBridge';

/* TEST DATA ONLY — a scripted in-memory bridge (FakeBridge) through the REAL adapters and TLUXE services. */

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

const tick = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));
const T = 1_790_000_000_000; // ms

function rig(o: { instrument?: string; before?: (b: FakeBridge) => void } = {}) {
  const bridge = new FakeBridge();
  o.before?.(bridge);
  let now = T;
  const feed = new DatabentoFeed({ ...DEFAULT_DATABENTO_CONFIG, enabled: true, token: 'x'.repeat(40), pollMs: 3_600_000, healthMs: 3_600_000 }, { api: bridge, timers: { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), now: () => now } });
  const market = new DatabentoMarketProvider(feed, () => now);
  const flow = new DatabentoOrderFlowProvider(feed, () => now);
  const fp = new DatabentoFootprintProvider(feed);
  const mt5 = new ManualPriceProvider('mt5');
  const services = createServices({ ...defaultProviders(), price: [mt5, market], orderFlow: { depth: flow, trade: flow }, footprint: fp, databento: feed }, { storage: memoryStorage({ 'tluxe.instrument.v1': o.instrument ?? 'GC' }) });
  teardown = connectServices(services);
  const pump = async () => {
    await act(async () => {
      await feed.healthOnce();
      await feed.pollOnce();
    });
    await tick();
    act(() => {
      services.orderFlow.publish();
      services.volumeFootprint.flush();
    });
  };
  return { bridge, feed, services, mt5, market, flow, fp, pump, setNow: (t: number) => (now = t) };
}

const withBook = (b: FakeBridge, root: DbRoot = 'GC') => {
  b.books[root] = { epoch: 1, bids: [[2400.0, 5, 1], [2399.9, 3, 2]], asks: [[2400.1, 7, 1]] };
  return b.frame({ [root]: { snapshot: { ...b.books[root]! } } });
};
const of = (s: Services) => s.orderFlow.store.getState();
const fpSnap = (s: Services) => s.volumeFootprint.store.getState().snapshot;

describe('Databento — configuration & security', () => {
  it('not configured → no Databento connection; GC order flow / footprint stay DATA UNAVAILABLE (no fallback)', () => {
    const services = createServices(defaultProviders(memoryStorage()), { storage: memoryStorage({ 'tluxe.instrument.v1': 'GC' }) });
    teardown = connectServices(services);
    expect(services.databento).toBeNull();
    expect(of(services).depth.status).toBe('DATA_UNAVAILABLE');
    expect(services.volumeFootprint.store.getState().reason).toMatch(/No exchange trade provider/);
  });

  it('enabled only from the browser bridge settings; a Databento API key is refused as a bridge token', () => {
    const on = memoryStorage({ [DATABENTO_CONFIG_KEY]: JSON.stringify({ enabled: true, token: 'b'.repeat(40) }) });
    const p = defaultProviders(on);
    expect(p.databento).toBeInstanceOf(DatabentoFeed);
    expect(p.price.some((x) => x.info.id === 'databento')).toBe(true);
    expect(p.orderFlow?.depth?.info.test).toBe(false);
    expect(sanitizeDatabentoConfig({ enabled: true, token: 'db-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }).token).toBe('');
    expect(defaultProviders(memoryStorage({ [DATABENTO_CONFIG_KEY]: JSON.stringify({ enabled: true, token: 'db-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }) })).databento).toBeNull();
  });

  it('the bridge client sends only the bridge token, in the Authorization header (never in a URL)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const c = new DatabentoBridgeClient('http://127.0.0.1:8766', 'tok'.repeat(12), 1000, (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ cursor: 0, reset: false, frames: [] }), { status: 200 });
    }) as unknown as typeof fetch);
    await c.feed(0, ['GC']);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8766/v1/feed?cursor=0&roots=GC');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${'tok'.repeat(12)}`);
    expect(calls[0]!.url).not.toMatch(/tok/);
  });

  it('no Databento API key (or key-like value) anywhere in the frontend source', () => {
    const sources = import.meta.glob(['/src/**/*.{ts,tsx,css}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    for (const [f, s] of Object.entries(sources)) {
      expect(s, f).not.toMatch(/db-[A-Za-z0-9]{20,}/);
      expect(s, f).not.toMatch(/DATABENTO_API_KEY\s*[:=]\s*['"][^'"]+['"]/);
      expect(s, f).not.toMatch(/import\.meta\.env\.[A-Z_]*DATABENTO/);
    }
  });

  it('production never runs on test data: Databento adapters are real, test providers are refused', () => {
    const r = rig();
    expect(r.market.info.test).toBe(false);
    expect(r.flow.info.test).toBe(false);
    expect(r.fp.info.test).toBe(false);
  });
});

describe('Databento — heatmap (MBO book)', () => {
  it('SYNCING BOOK until the bridge reports the complete snapshot; then a VALID live book with the actual contract', async () => {
    const r = rig();
    r.bridge.statuses.GC = status('GC', { status: 'SYNCING', bookState: 'SYNCING', reasons: ['SYNCING BOOK - waiting for the complete MBO snapshot.'] });
    r.bridge.frame({});
    await r.pump();
    expect(of(r.services).depth.status).toBe('RESYNCING');
    expect(of(r.services).depth.detail).toMatch(/SYNCING BOOK/);
    expect(of(r.services).book).toBeNull();
    r.bridge.statuses.GC = status('GC');
    withBook(r.bridge);
    await r.pump();
    const s = of(r.services);
    expect(s.depth.status).toBe('LIVE');
    expect(s.contract).toBe('GCZ6');
    expect(s.book!.bids[0]).toMatchObject({ price: 2400.0, size: 5 });
    expect(s.book!.asks[0]).toMatchObject({ price: 2400.1, size: 7 });
  });

  it('level add / modify / delete from the reconstructed book update the heatmap; stale frames are ignored', async () => {
    const r = rig();
    withBook(r.bridge);
    await r.pump();
    r.bridge.frame({ GC: { levels: [['B', 2399.8, 4], ['B', 2400.0, 9], ['A', 2400.1, 0]] } });
    await r.pump();
    const b = of(r.services).book!;
    expect(b.bids.map((l) => [l.price, l.size])).toEqual([[2400.0, 9], [2399.9, 3], [2399.8, 4]]);
    expect(b.asks).toEqual([]);
  });

  it('bridge offline → DISCONNECTED, the book is cleared (never shown as live), then resync on recovery', async () => {
    const r = rig();
    withBook(r.bridge);
    await r.pump();
    expect(of(r.services).book).not.toBeNull();
    r.bridge.down = true;
    r.setNow(T + 60_000);
    await r.pump();
    expect(of(r.services).depth.status).toBe('DISCONNECTED');
    expect(of(r.services).book).toBeNull();
    expect(r.feed.state.getState().bridge).toBe('OFFLINE');
    r.bridge.down = false;
    await r.pump();
    await tick();
    act(() => r.services.orderFlow.publish());
    expect(r.bridge.calls).toContain('book');
  });

  it('AUTH_ERROR / UNAVAILABLE → DATA UNAVAILABLE; STALE → STALE', async () => {
    const r = rig();
    r.bridge.statuses.GC = status('GC', { status: 'AUTH_ERROR', freshness: 'UNAVAILABLE', reasons: ['Databento rejected the API key (authentication failed).'] });
    r.bridge.frame({});
    await r.pump();
    expect(of(r.services).depth.status).toBe('DATA_UNAVAILABLE');
    expect(of(r.services).depth.detail).toMatch(/authentication/);
    r.bridge.statuses.GC = status('GC', { status: 'STALE', freshness: 'STALE', reasons: ['No Databento message'] });
    r.bridge.frame({});
    await r.pump();
    expect(of(r.services).depth.status).toBe('STALE');
  });
});

describe('Databento — footprint (exchange trades)', () => {
  it('BUY / SELL from the source side; UNKNOWN kept separate; no duplicate volume after a reset + refetch', async () => {
    const r = rig();
    withBook(r.bridge);
    const t1 = r.bridge.trade('GC', 2400.1, 3, 'BUY', T + 1000);
    const t2 = r.bridge.trade('GC', 2400.0, 2, 'SELL', T + 2000);
    const t3 = r.bridge.trade('GC', 2400.0, 4, 'UNKNOWN', T + 3000);
    r.bridge.frame({ GC: { trades: [t1, t2, t3] } });
    await r.pump();
    const c = r.services.volumeFootprint.engine()!.candles('M1')[0]!;
    expect(c).toMatchObject({ ask: 3, bid: 2, unknown: 4, delta: 1, volume: 9, contract: 'GCZ6' });
    expect(fpSnap(r.services)!.cvdAvailability).toBe('PARTIAL');
    // The browser falls behind the bridge ring (reset): trades are re-fetched by transport index — never twice.
    const t4 = r.bridge.trade('GC', 2400.2, 5, 'BUY', T + 4000);
    r.bridge.frames = [];
    r.bridge.cursor += 5000;
    await r.pump();
    await tick();
    act(() => r.services.volumeFootprint.flush());
    const c2 = r.services.volumeFootprint.engine()!.candles('M1')[0]!;
    expect(c2).toMatchObject({ ask: 8, bid: 2, unknown: 4, volume: 14 });
    expect(r.feed.state.getState().resets).toBeGreaterThan(0);
    void t4;
  });

  it('footprint integrity is GOOD with provider gap reporting; a bridge-reported tape gap degrades it', async () => {
    const r = rig();
    const t1 = r.bridge.trade('GC', 2400, 1, 'BUY', T + 1000);
    r.bridge.frame({ GC: { trades: [t1] } });
    await r.pump();
    expect(fpSnap(r.services)!.integrity.state).toBe('GOOD');
    r.bridge.statuses.GC = status('GC', { counts: { tapeGaps: 1, mboDuplicates: 0 } });
    const t2 = r.bridge.trade('GC', 2400, 1, 'BUY', T + 2000);
    r.bridge.frame({ GC: { trades: [t2] } });
    await r.pump();
    expect(fpSnap(r.services)!.integrity.state).toBe('DEGRADED');
    expect(fpSnap(r.services)!.integrity.disconnects).toBe(1);
  });

  it('contract roll: new contract history, never merged (footprint + heatmap)', async () => {
    const r = rig();
    withBook(r.bridge);
    r.bridge.frame({ GC: { trades: [r.bridge.trade('GC', 2400, 1, 'BUY', T + 1000)] } });
    await r.pump();
    r.bridge.statuses.GC = status('GC', { contract: 'GCG7', instrumentId: 42003 });
    r.bridge.frame({ GC: { contract: 'GCG7', trades: [r.bridge.trade('GC', 2410, 2, 'SELL', T + 70_000, 'GCG7')] } });
    await r.pump();
    const s = fpSnap(r.services)!;
    expect(s.contract).toBe('GCG7');
    expect(s.previousContracts).toEqual(['GCZ6']);
    expect(r.services.volumeFootprint.engine()!.candles('M1').every((c) => c.contract === 'GCG7')).toBe(true);
    expect(of(r.services).contract).toBe('GCG7');
  });
});

describe('Databento — SI, isolation, market data, volume profile', () => {
  it('SI subscription works and GC records never reach SI consumers', async () => {
    const r = rig({ instrument: 'SI' });
    r.bridge.books.SI = { epoch: 1, bids: [[31.2, 2, 1]], asks: [[31.205, 3, 1]] };
    r.bridge.frame({ SI: { snapshot: { ...r.bridge.books.SI } }, GC: { trades: [r.bridge.trade('GC', 2400, 9, 'BUY', T + 10)] } });
    await r.pump();
    expect(of(r.services).contract).toBe('SIZ6');
    expect(of(r.services).book!.bids[0]!.price).toBe(31.2);
    expect(r.services.volumeFootprint.engine()!.candles('M1')).toHaveLength(0);
  });

  it('instrument switch clears state; XAUUSD stays on MT5 (never relabelled as COMEX)', async () => {
    const r = rig();
    withBook(r.bridge);
    await r.pump();
    expect(r.feed.listenerCount()).toBe(3);
    act(() => r.services.instruments.select('XAUUSD'));
    expect(r.feed.listenerCount()).toBe(0);
    const m = r.services.market.store('XAUUSD').getState();
    expect(m.provider?.id).toMatch(/mt5/);
    expect(m.provider?.id).not.toBe('databento');
    expect(of(r.services).supported).toBe(false);
  });

  it('GC quotes / candles from Databento: header label DATABENTO · LIVE with the actual contract', async () => {
    const r = rig();
    withBook(r.bridge);
    await r.pump();
    const m = r.services.market.store('GC').getState();
    expect(m.provider?.id).toBe('databento');
    expect(m.feed?.providerSymbol).toBe('GCZ6');
    expect(feedLabelFor(m.feed!.code, m.provider)).toBe('DATABENTO · LIVE');
    expect(feedLabelFor('LIVE', { id: 'mt5' })).toBe('MT5 · LIVE');
  });

  it('Volume Profile uses real Databento volume, labelled Databento / CME Globex / COMEX with the contract', async () => {
    const m0 = Math.floor(T / 1000 / 86400) * 86400 - 86400 * 2;
    const r = rig({
      before: (b) => {
        for (let k = 0; k < 3 * 24 * 60; k += 1) {
          const p = 2400 + Math.sin(k / 50) * 5;
          b.bars.GC.push({ time: m0 + k * 60, open: p, high: p + 0.3, low: p - 0.3, close: p + 0.1, volume: 10 + (k % 7), isClosed: true });
        }
      },
    });
    withBook(r.bridge);
    await r.pump();
    await tick();
    await tick();
    const vp = r.services.volumeProfile.store.getState().snapshot!;
    const p = vp.profiles.PREVIOUS_DAY!;
    expect(p.source.mode).toBe('EXCHANGE');
    expect(p.source.label).toBe('Databento / CME Globex / COMEX');
    expect(p.source.detail).toMatch(/GCZ6/);
    expect(p.poc).not.toBeNull();
    expect(r.services.market.getCandles('GC', 'M5').every((c) => c.source === 'databento' && c.providerSymbol === 'GCZ6')).toBe(true);
  });
});

describe('Databento — one connection, HMR, determinism', () => {
  it('one feed loop shared by all consumers; HMR teardown / reconnect never duplicates listeners or loops', async () => {
    const r = rig();
    await r.pump();
    expect(r.feed.listenerCount()).toBe(3); // market + order flow + footprint, all on ONE feed
    connectServices(r.services); // idempotent
    expect(r.feed.listenerCount()).toBe(3);
    teardown!();
    expect(r.feed.listenerCount()).toBe(0);
    expect(r.feed.state.getState().bridge).toBe('IDLE');
    teardown = connectServices(r.services);
    expect(r.feed.listenerCount()).toBe(3);
  });

  it('same Databento input → same final order book, heatmap state, footprint and volume profile', async () => {
    const run = async () => {
      const r = rig();
      withBook(r.bridge);
      const bars = [];
      const m0 = Math.floor(T / 1000 / 60) * 60 - 600 * 60;
      for (let k = 0; k < 600; k++) bars.push({ time: m0 + k * 60, open: 2400 + (k % 9) * 0.1, high: 2401 + (k % 5) * 0.1, low: 2399, close: 2400.5, volume: 5 + (k % 11), isClosed: true });
      r.bridge.bars.GC = bars;
      for (let f = 0; f < 20; f++) {
        const trades = Array.from({ length: 15 }, (_, k) => r.bridge.trade('GC', 2400 + ((f * 15 + k) % 13) * 0.1, 1 + (k % 4), (['BUY', 'SELL', 'UNKNOWN'] as const)[(f + k) % 3]!, T + (f * 15 + k) * 900));
        r.bridge.frame({ GC: { trades, levels: [['B', 2399.5 + (f % 4) * 0.1, f + 1], ['A', 2400.6 + (f % 3) * 0.1, 20 - f]] } });
      }
      await r.pump();
      await tick();
      act(() => {
        r.services.orderFlow.publish();
        r.services.volumeFootprint.flush();
      });
      const out = JSON.stringify([of(r.services).book, of(r.services).totals, r.services.orderFlow.engine()!.bookView(50), r.services.volumeFootprint.engine()!.fullState(), r.services.volumeProfile.store.getState().snapshot?.profiles]);
      teardown!();
      teardown = null;
      return out;
    };
    const a = await run();
    const b = await run();
    expect(a).toBe(b);
    expect(a).toContain('GCZ6');
  });
});
