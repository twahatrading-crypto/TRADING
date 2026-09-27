import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { ServicesProvider } from '../../app/ServicesProvider';
import { DatabentoSettingsPanel } from '../../components/databento/DatabentoSettings';
import { feedLabelFor } from '../../components/market/feedLabel';
import { chooseVolume, DATABENTO_VOLUME_LABEL } from '../../engines/volumeProfile/volume';
import type { OrderFlowCapabilities, OrderFlowMsg } from '../../engines/orderFlow/types';
import type { FootprintMsg } from '../../engines/volumeFootprint/types';
import { connectServices, createServices, defaultProviders, type Services } from '../../services/registry';
import { memoryStorage } from '../../test/providers';
import type { Candle } from '../../types/market';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';
import { composeOrderFlowProviders, mergeCapabilities } from '../level2/composeOrderFlow';
import type { OrderFlowDepthProvider, OrderFlowSink } from '../orderFlow/types';
import { DATABENTO_TRADE_ONLY_CAPS, DatabentoFootprintProvider, DatabentoMarketProvider, DatabentoOrderFlowProvider } from './adapters';
import { DATABENTO_CONFIG_KEY, DEFAULT_DATABENTO_CONFIG } from './config';
import { DatabentoFeed } from './DatabentoFeed';
import { FakeBridge, standardStatus } from './testing/FakeBridge';

/* TEST DATA ONLY — FakeBridge stands in for the local bridge running on the Databento STANDARD plan
 * (trades + ohlcv-1m; no MBO / MBP-10). */

vi.mock('lightweight-charts', () => ({}));
vi.mock('../../components/chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setFootprint() {}
    setEventMarkers() {}
    autoScalePrice() {}
    onBarClick() {
      return () => {};
    }
    destroy() {}
  },
}));

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

const tick = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));
const T = 1_790_000_000_000;

/** Standard wiring exactly as the registry builds it: Databento = trade source only, Level-2 slot empty. */
function rig(o: { instrument?: string; depth?: OrderFlowDepthProvider | null; before?: (b: FakeBridge) => void } = {}) {
  const bridge = new FakeBridge();
  bridge.plan = 'standard';
  bridge.statuses = { GC: standardStatus('GC'), SI: standardStatus('SI') };
  o.before?.(bridge);
  let now = T;
  const feed = new DatabentoFeed({ ...DEFAULT_DATABENTO_CONFIG, enabled: true, token: 'x'.repeat(40), pollMs: 3_600_000, healthMs: 3_600_000 }, { api: bridge, timers: { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), now: () => now } });
  const market = new DatabentoMarketProvider(feed, () => now);
  const flow = new DatabentoOrderFlowProvider(feed, () => now);
  const fp = new DatabentoFootprintProvider(feed);
  const services = createServices({ ...defaultProviders(), price: [market], orderFlow: composeOrderFlowProviders(o.depth ?? null, flow), footprint: fp, databento: feed }, { storage: memoryStorage({ 'tluxe.instrument.v1': o.instrument ?? 'GC' }) });
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
  return { bridge, feed, services, flow, fp, market, pump, setNow: (t: number) => (now = t) };
}
const of = (s: Services) => s.orderFlow.store.getState();

describe('Databento Standard — provider wiring', () => {
  it('registry default: Databento is the TRADE source only; depth slot empty (no MBO, no MBP-10 ever requested by the browser)', () => {
    const p = defaultProviders(memoryStorage({ [DATABENTO_CONFIG_KEY]: JSON.stringify({ enabled: true, token: 'b'.repeat(40) }) }));
    expect(p.orderFlow?.depth).toBeNull();
    expect(p.orderFlow?.trade?.stream).toBe('trade');
    // Opt-in MBO plan: Databento also becomes the depth source.
    const mbo = defaultProviders(memoryStorage({ [DATABENTO_CONFIG_KEY]: JSON.stringify({ enabled: true, token: 'b'.repeat(40), mboDepth: true }) }));
    expect(mbo.orderFlow?.depth?.stream).toBe('both');
    expect(mbo.orderFlow?.depth).toBe(mbo.orderFlow?.trade);
  });

  it('trade-only caps declare NO depth', () => {
    expect(DATABENTO_TRADE_ONLY_CAPS.depth).toBe('NONE');
    expect(DATABENTO_TRADE_ONLY_CAPS.trades).toBe(true);
    expect(DATABENTO_TRADE_ONLY_CAPS.aggressorSide).toBe(true);
  });
});

describe('Databento Standard — heatmap never fabricates depth', () => {
  it('depth DATA UNAVAILABLE (LEVEL-2 PROVIDER NOT CONNECTED) while trades are LIVE; no book ever built', async () => {
    const r = rig();
    r.bridge.frame({ GC: { trades: [r.bridge.trade('GC', 2400.1, 3, 'BUY', T + 1000)] } });
    await r.pump();
    const s = of(r.services);
    expect(s.depth.status).toBe('DATA_UNAVAILABLE');
    expect(s.depth.detail).toBe('LEVEL-2 PROVIDER NOT CONNECTED');
    expect(s.trade.status).toBe('LIVE');
    expect(s.book).toBeNull();
    expect(r.services.orderFlow.engine()!.trade.state).not.toBe('NO_DATA');
  });

  it('even if a (misconfigured) bridge frame carries snapshot / levels, the trade-only provider never forwards them', async () => {
    const r = rig();
    const sent: OrderFlowMsg[] = [];
    const spy: OrderFlowSink = { message: (m) => sent.push(m), status: () => {}, capabilities: () => {}, contract: () => {} };
    r.flow.connect(spy);
    r.flow.subscribe({ id: 'GC' } as InstrumentDefinition);
    r.bridge.frame({ GC: { snapshot: { epoch: 1, bids: [[2400, 5, 1]], asks: [[2400.1, 5, 1]] }, levels: [['B', 2399.9, 4]], trades: [r.bridge.trade('GC', 2400.1, 1, 'BUY', T + 1)] } });
    await r.pump();
    expect(sent.some((m) => m.type === 'snapshot' || m.type === 'depth')).toBe(false);
    expect(sent.some((m) => m.type === 'heartbeat' && m.stream === 'depth')).toBe(false);
    expect(sent.filter((m) => m.type === 'trade')).toHaveLength(1);
    expect(r.bridge.calls).not.toContain('book');
    expect(of(r.services).book).toBeNull();
  });

  it('heatmap page: LEVEL-2 DATA UNAVAILABLE panel + DEPTH DATA UNAVAILABLE notice with the Standard reason; rest of the app works', async () => {
    const r = rig();
    window.location.hash = '#/engines/liquidity-heatmap';
    render(
      <StrictMode>
        <ServicesProvider services={r.services}>
          <App />
        </ServicesProvider>
      </StrictMode>,
    );
    await r.pump();
    const notice = screen.getByTestId('databento-depth-unavailable').textContent!;
    expect(notice).toMatch(/DEPTH DATA UNAVAILABLE/);
    expect(notice).toMatch(/Databento Standard does not include real-time MBO\/MBP-10/);
    expect(notice).toMatch(/Level-2 provider required: IBKR \/ T4 \/ other supported depth provider/);
    expect(screen.getAllByText(/LEVEL-2 DATA UNAVAILABLE/).length).toBeGreaterThan(0);
    // Unsupported depth is NOT a provider-wide failure.
    expect(screen.getByTestId('databento-badge').textContent).toMatch(/DATABENTO • GLBX\.MDP3 • LIVE/);
    expect(screen.getByTestId('databento-badge').textContent).not.toMatch(/AUTH_ERROR/);
    const caps = screen.getByTestId('databento-capabilities').textContent!;
    expect(caps).toMatch(/Trades: LIVE/);
    expect(caps).toMatch(/OHLCV: LIVE/);
    expect(caps).toMatch(/Depth: UNSUPPORTED/);
    expect(caps).toMatch(/MBO: NOT ENTITLED/);
    expect(caps).toMatch(/MBP-10: NOT ENTITLED/);
  });
});

describe('Databento Standard — capabilities are independent', () => {
  it('unsupported depth never creates a provider-wide AUTH_ERROR: price feed LIVE, header DATABENTO · LIVE', async () => {
    const r = rig();
    r.bridge.frame({ GC: { trades: [r.bridge.trade('GC', 2400.1, 3, 'BUY', T + 1000)] } });
    await r.pump();
    const m = r.services.market.store('GC').getState();
    expect(m.feed?.code).toBe('LIVE');
    expect(feedLabelFor(m.feed!.code, m.provider)).toBe('DATABENTO · LIVE');
    expect(m.feed?.providerSymbol).toBe('GCZ6');
  });

  it('trades NOT ENTITLED → trade stream / footprint DATA UNAVAILABLE, OHLCV candles still load (Volume Profile keeps working)', async () => {
    const m0 = Math.floor(T / 1000 / 86400) * 86400 - 86400 * 2;
    const r = rig({
      before: (b) => {
        for (let k = 0; k < 3 * 24 * 60; k += 1) b.bars.GC.push({ time: m0 + k * 60, open: 2400, high: 2401, low: 2399, close: 2400.5, volume: 12, isClosed: true });
        b.statuses.GC = standardStatus('GC', { trades: 'NOT_ENTITLED', volume: 'LIVE' });
      },
    });
    const fpMsgs: FootprintMsg[] = [];
    const fp2 = new DatabentoFootprintProvider(r.feed);
    fp2.connect({
      message: (m) => void fpMsgs.push(m),
      status: () => {},
      capabilities: () => {},
    });
    fp2.subscribe({ id: 'GC' } as InstrumentDefinition);
    r.bridge.frame({});
    await r.pump();
    await tick();
    await tick();
    expect(of(r.services).trade.status).toBe('DATA_UNAVAILABLE');
    expect(fpMsgs.some((m) => m.type === 'status' && m.status === 'DATA_UNAVAILABLE' && /not entitled/.test(m.detail ?? ''))).toBe(true);
    fp2.disconnect();
    const vp = r.services.volumeProfile.store.getState().snapshot!;
    expect(vp.profiles.PREVIOUS_DAY!.source.label).toBe('DATABENTO / GLBX.MDP3 / CME/COMEX / REAL VOLUME');
    expect(vp.profiles.PREVIOUS_DAY!.poc).not.toBeNull();
  });

  it('OHLCV not observed yet does not block trades (trades LIVE, OHLCV NOT OBSERVED YET)', async () => {
    const r = rig();
    r.bridge.statuses.GC = standardStatus('GC', { ohlcv: 'WAITING' });
    render(
      <ServicesProvider services={r.services}>
        <App />
      </ServicesProvider>,
    );
    r.bridge.frame({ GC: { trades: [r.bridge.trade('GC', 2400.1, 3, 'SELL', T + 1000)] } });
    await r.pump();
    expect(of(r.services).trade.status).toBe('LIVE');
    expect(screen.getByTestId('databento-capabilities').textContent).toMatch(/OHLCV: NOT OBSERVED YET/);
  });

  it('STALE and OFFLINE are reported per capability; bridge offline → OFFLINE badge, trades DISCONNECTED', async () => {
    const r = rig();
    render(
      <ServicesProvider services={r.services}>
        <App />
      </ServicesProvider>,
    );
    r.bridge.statuses.GC = standardStatus('GC', { trades: 'STALE', ohlcv: 'STALE', volume: 'STALE' }, { status: 'STALE', freshness: 'STALE', reasons: ['No Databento message'] });
    r.bridge.frame({});
    await r.pump();
    expect(screen.getByTestId('databento-capabilities').textContent).toMatch(/Trades: STALE/);
    expect(of(r.services).trade.status).toBe('STALE');
    r.bridge.down = true;
    r.setNow(T + 60_000);
    await r.pump();
    expect(screen.getByTestId('databento-badge').textContent).toMatch(/OFFLINE/);
    expect(of(r.services).trade.status).toBe('DISCONNECTED');
  });
});

describe('Databento Standard — footprint (no invented aggressor)', () => {
  it('B → ask volume, A → bid volume, N stays UNKNOWN; delta excludes unknown, CVD PARTIAL', async () => {
    const r = rig();
    const t = [r.bridge.trade('GC', 2400.1, 3, 'BUY', T + 1000), r.bridge.trade('GC', 2400.0, 2, 'SELL', T + 2000), r.bridge.trade('GC', 2400.0, 4, 'UNKNOWN', T + 3000)];
    expect(t.map((x) => x.side)).toEqual(['B', 'A', 'N']);
    r.bridge.frame({ GC: { trades: t } });
    await r.pump();
    const c = r.services.volumeFootprint.engine()!.candles('M1')[0]!;
    expect(c).toMatchObject({ ask: 3, bid: 2, unknown: 4, delta: 1, volume: 9, contract: 'GCZ6' });
    expect(r.services.volumeFootprint.store.getState().snapshot!.cvdAvailability).toBe('PARTIAL');
  });

  it('duplicate, out-of-order and malformed-index trade frames are never double counted', async () => {
    const r = rig();
    const a = r.bridge.trade('GC', 2400.1, 1, 'BUY', T + 1000);
    const b = r.bridge.trade('GC', 2400.2, 1, 'BUY', T + 2000);
    r.bridge.frame({ GC: { trades: [a, b] } });
    r.bridge.frame({ GC: { trades: [a, b] } }); // duplicate delivery
    r.bridge.frame({ GC: { trades: [{ ...a, i: 0 }] } }); // malformed / out-of-order transport index
    await r.pump();
    const c = r.services.volumeFootprint.engine()!.candles('M1')[0]!;
    expect(c.volume).toBe(2);
  });
});

describe('Databento Standard — Volume Profile source labels', () => {
  const bar = (o: Partial<Candle>): Candle => ({ time: 60, open: 1, high: 2, low: 1, close: 2, volume: null, tickVolume: null, realVolume: null, instrumentId: 'GC', timeframe: 'M1', source: 'databento', isClosed: true, ...o });
  it('Databento OHLCV volume → DATABENTO / GLBX.MDP3 / CME/COMEX / REAL VOLUME', () => {
    const v = chooseVolume([bar({ volume: 5, providerSymbol: 'GCZ6' })], { kind: 'future', exchange: 'COMEX' });
    expect(v.source.label).toBe(DATABENTO_VOLUME_LABEL);
    expect(v.source.label).toBe('DATABENTO / GLBX.MDP3 / CME/COMEX / REAL VOLUME');
    expect(v.source.detail).toMatch(/GCZ6/);
  });
  it('MT5 tick volume is never labelled CME / Databento volume', () => {
    const v = chooseVolume([bar({ source: 'mt5', tickVolume: 40, instrumentId: 'XAUUSD' })], { kind: 'spot', exchange: null });
    expect(v.source.mode).toBe('MT5_TICK');
    expect(v.source.label).not.toMatch(/CME|COMEX|DATABENTO|GLBX/i);
    const f = chooseVolume([bar({ source: 'mt5', tickVolume: 40 })], { kind: 'future', exchange: 'COMEX' });
    expect(f.source.label).not.toMatch(/CME|COMEX|DATABENTO|GLBX/i);
  });
});

describe('Databento Standard — GC / SI contracts', () => {
  it('shows the ACTUAL contract resolved by the bridge (never hard-coded); a roll switches it', async () => {
    const r = rig({ instrument: 'SI' });
    render(
      <ServicesProvider services={r.services}>
        <App />
      </ServicesProvider>,
    );
    r.bridge.statuses.SI = standardStatus('SI', {}, { contract: 'SIH7', subscribed: 'SI.v.0' });
    r.bridge.frame({ SI: { contract: 'SIH7', trades: [r.bridge.trade('SI', 31.2, 1, 'BUY', T + 1, 'SIH7')] } });
    await r.pump();
    expect(screen.getByTestId('databento-contract').textContent).toBe('SI • SIH7');
    expect(of(r.services).contract).toBe('SIH7');
    r.bridge.statuses.SI = standardStatus('SI', {}, { contract: 'SIK7' });
    r.bridge.frame({ SI: { contract: 'SIK7', trades: [r.bridge.trade('SI', 31.3, 1, 'SELL', T + 90_000, 'SIK7')] } });
    await r.pump();
    expect(screen.getByTestId('databento-contract').textContent).toBe('SI • SIK7');
  });
});

describe('Databento Standard — Settings', () => {
  it('Plan mode Standard, dataset, ✓ Trades ✓ OHLCV ✓ Volume ✕ MBO ✕ MBP-10, Level-2 provider Not Connected; no API key', async () => {
    const r = rig();
    render(
      <ServicesProvider services={r.services}>
        <DatabentoSettingsPanel />
      </ServicesProvider>,
    );
    await r.pump();
    const t = screen.getByTestId('databento-plan').textContent!;
    expect(t).toMatch(/Plan mode\s*Standard/);
    expect(t).toMatch(/Dataset\s*GLBX\.MDP3/);
    expect(t).toMatch(/✓ Trades/);
    expect(t).toMatch(/✓ OHLCV/);
    expect(t).toMatch(/✓ Volume when supplied/);
    expect(t).toMatch(/✕ MBO/);
    expect(t).toMatch(/✕ MBP-10/);
    expect(t).toMatch(/Level-2 provider\s*Not Connected/);
    expect(document.body.innerHTML).not.toMatch(/DATABENTO_API_KEY\s*=|db-[A-Za-z0-9]{8,}/);
  });
});

describe('Level-2 composition (future IBKR / T4 depth + Databento trades)', () => {
  class FakeDepth implements OrderFlowDepthProvider {
    /* TEST DATA ONLY: stands in for a future IBKR / T4 depth adapter. */
    readonly stream = 'depth' as const;
    readonly info = { id: 'test-l2', name: 'Test Level-2', test: false };
    sink: OrderFlowSink | null = null;
    snapshots = 0;
    connect(s: OrderFlowSink) {
      this.sink = s;
    }
    disconnect() {
      this.sink = null;
    }
    subscribe(def: InstrumentDefinition) {
      this.sink?.capabilities(def.id, { depth: 'MBP', depthLevels: 10, incrementalDepth: true, trades: false, aggressorSide: false, depthReasons: false, sequenced: false, snapshotOnDemand: true });
      this.sink?.status(def.id, 'depth', 'LIVE', null);
      this.sink?.status(def.id, 'trade', 'LIVE', null); // must be ignored: not its stream
    }
    unsubscribe(_id: InstrumentId) {}
    requestSnapshot() {
      this.snapshots += 1;
    }
    push(m: OrderFlowMsg) {
      this.sink?.message(m);
    }
  }

  it('merges capabilities: depth fields from the Level-2 adapter, trade fields from Databento', () => {
    const d: OrderFlowCapabilities = { depth: 'MBP', depthLevels: 10, incrementalDepth: true, trades: false, aggressorSide: false, depthReasons: false, sequenced: true, snapshotOnDemand: true };
    const m = mergeCapabilities(d, DATABENTO_TRADE_ONLY_CAPS);
    expect(m).toMatchObject({ depth: 'MBP', depthLevels: 10, snapshotOnDemand: true, trades: true, aggressorSide: true, sequenced: false });
    expect(mergeCapabilities(null, DATABENTO_TRADE_ONLY_CAPS).depth).toBe('NONE');
  });

  it('depth book from the Level-2 adapter + trades from Databento, without touching the heatmap / footprint code', async () => {
    const depth = new FakeDepth();
    const r = rig({ depth });
    await r.pump();
    depth.push({ type: 'snapshot', instrumentId: 'GC', seq: null, exchTime: T, recvTime: T, bids: [{ price: 2400, size: 5, orders: 1 }], asks: [{ price: 2400.1, size: 7, orders: 1 }] });
    // A depth adapter can never inject prints:
    depth.push({ type: 'trade', instrumentId: 'GC', seq: null, exchTime: T, recvTime: T, price: 2400, size: 999, aggressor: 'BUY', tradeId: 'x' });
    r.bridge.frame({ GC: { trades: [r.bridge.trade('GC', 2400.1, 3, 'BUY', T + 1000)] } });
    await r.pump();
    const s = of(r.services);
    expect(s.book!.bids[0]).toMatchObject({ price: 2400, size: 5 });
    expect(s.depth.provider).toBe('Test Level-2');
    expect(s.trade.provider).toBe('Databento · GLBX.MDP3');
    expect(r.services.volumeFootprint.engine()!.candles('M1')[0]!.volume).toBe(3);
  });
});

describe('Databento Standard — one connection / HMR', () => {
  it('provider switching + HMR teardown never duplicates subscriptions or poll loops', async () => {
    const r = rig();
    await r.pump();
    expect(r.feed.listenerCount()).toBe(3); // market + trade-only order flow + footprint on ONE feed
    connectServices(r.services);
    expect(r.feed.listenerCount()).toBe(3);
    act(() => r.services.instruments.select('SI'));
    expect(r.feed.listenerCount()).toBe(3);
    act(() => r.services.instruments.select('XAUUSD'));
    expect(r.feed.listenerCount()).toBe(0);
    act(() => r.services.instruments.select('GC'));
    expect(r.feed.listenerCount()).toBe(3);
    teardown!();
    teardown = null;
    expect(r.feed.listenerCount()).toBe(0);
    expect(r.feed.state.getState().bridge).toBe('IDLE');
  });
});
