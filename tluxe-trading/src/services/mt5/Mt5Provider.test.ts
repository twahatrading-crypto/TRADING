import { afterEach, describe, expect, it, vi } from 'vitest';
import { SRTimeframeEngine } from '../../engines/sr/engine';
import { TIMEFRAME_SECONDS } from '../../engines/sr/settings';
import { memoryStorage } from '../../test/providers';
import type { Timeframe } from '../../types/market';
import { connectServices, createServices, defaultProviders } from '../registry';
import { BridgeOfflineError, BridgeResponseError } from './client';
import { sanitizeMt5Config, type Mt5Config } from './config';
import { Mt5Provider } from './Mt5Provider';
import type { BridgeBar, BridgeHealth, BridgeQuote, BridgeRates, BridgeSymbol } from './protocol';

/*
 * Test double of the bridge HTTP API. It lives ONLY in this test file; the
 * production app has no fake/simulated MT5 source.
 */
class FakeBridge {
  nowMs: number;
  offline = false;
  terminal: BridgeHealth['terminal']['state'] = 'CONNECTED';
  startedAtMs = 1;
  tzUnresolved = false;
  symbolsList: string[];
  readonly calls: { name: string; tf: Timeframe; count: number }[] = [];
  /** Optional hook to delay a rates response (switch-while-loading tests). */
  gate: Promise<void> | null = null;
  /** Bars available per timeframe (history depth offered by the "broker"). */
  depth = 400;

  constructor(nowMs: number, symbols: string[]) {
    this.nowMs = nowMs;
    this.symbolsList = symbols;
  }

  private guard() {
    if (this.offline) throw new BridgeOfflineError();
  }

  health = async (): Promise<BridgeHealth> => {
    this.guard();
    return {
      bridge: { version: '1.0.0', startedAtMs: this.startedAtMs, heartbeatAtMs: this.nowMs },
      terminal: { state: this.terminal, build: 4000, name: 'MetaTrader 5' },
      account: this.terminal === 'CONNECTED' ? { server: 'Broker-Demo', company: 'Broker', loginMasked: '****123', tradeMode: 'demo', currency: 'USD' } : null,
      time: { basis: 'iana', timezone: 'Europe/Athens', offsetSec: 10800, detectedAtMs: null },
      error: this.terminal === 'NOT_RUNNING' ? { code: 'MT5_NOT_RUNNING', message: 'MetaTrader 5 terminal is not running.' } : null,
    };
  };

  symbols = async (): Promise<{ count: number; symbols: BridgeSymbol[] }> => {
    this.guard();
    const symbols = this.symbolsList.map((name) => ({
      name,
      description: name,
      path: name.startsWith('GC') ? 'Futures\\COMEX\\' + name : 'Forex\\' + name,
      digits: name.startsWith('XAU') || name === 'GOLD' ? 2 : 5,
      point: name.startsWith('XAU') ? 0.01 : 0.00001,
      tickSize: name.startsWith('XAU') ? 0.01 : 0.00001,
      contractSize: name.startsWith('XAU') ? 100 : 100000,
      currencyBase: name.slice(0, 3),
      currencyProfit: 'USD',
      tradeMode: 4,
      visible: true,
      spreadFloat: true,
    }));
    return { count: symbols.length, symbols };
  };

  private price(name: string, t: number) {
    const base = name.startsWith('XAU') || name === 'GOLD' ? 2650 : name.startsWith('CAD') ? 0.74 : 1.1;
    return base * (1 + 0.002 * Math.sin(t / 7200));
  }

  quote = async (name: string): Promise<BridgeQuote> => {
    this.guard();
    this.known(name);
    const p = this.price(name, this.nowMs / 1000);
    return {
      symbol: name,
      bid: p,
      ask: p * 1.0001,
      last: null,
      spreadPoints: 12,
      sourceTimeMs: this.nowMs + 3 * 3600_000,
      timeUtcMs: this.tzUnresolved ? null : this.nowMs - 500,
      timeBasis: 'iana',
      digits: 2,
    };
  };

  private known(name: string) {
    if (!this.symbolsList.includes(name)) throw new BridgeResponseError('SYMBOL_NOT_FOUND', `${name} not found`, 404);
  }

  /** Deterministic bars; the newest bar is the forming one. */
  bars(name: string, tf: Timeframe, count: number): BridgeBar[] {
    const sec = TIMEFRAME_SECONDS[tf];
    const nowSec = Math.floor(this.nowMs / 1000);
    const formingOpen = Math.floor(nowSec / sec) * sec;
    const n = Math.min(count, this.depth);
    const out: BridgeBar[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const t = formingOpen - i * sec;
      const forming = i === 0;
      const end = forming ? nowSec : t + sec;
      const o = this.price(name, t);
      const cl = this.price(name, end);
      out.push({ t, st: t + 10800, o, h: Math.max(o, cl) * 1.0005, l: Math.min(o, cl) * 0.9995, c: cl, tv: 100 + i, rv: null, sp: 10, closed: !forming });
    }
    return out;
  }

  rates = async (name: string, tf: Timeframe, count: number): Promise<BridgeRates> => {
    this.guard();
    this.known(name);
    this.calls.push({ name, tf, count });
    if (this.gate) await this.gate;
    const bars = this.bars(name, tf, count);
    return {
      symbol: name,
      timeframe: tf,
      timeBasis: { basis: 'iana', timezone: 'Europe/Athens', offsetSec: 10800, detectedAtMs: null },
      requested: count,
      returned: bars.length,
      historyLimited: bars.length < count,
      realVolumeAvailable: false,
      bars,
    };
  };
}

// Wed 2026-09-23 12:00:30 UTC — FX/metals open.
const T0 = Date.UTC(2026, 8, 23, 12, 0, 30);
const SYMBOLS = ['XAUUSD', 'GOLD', 'SILVER', 'EURUSD.m', 'GBPUSD.m', 'GBPUSD.pro', 'CADUSD', 'GCZ6', 'BTCUSD'];

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(opts: { symbols?: string[]; cfg?: Partial<Mt5Config>; active?: string } = {}) {
  const bridge = new FakeBridge(T0, opts.symbols ?? SYMBOLS);
  const cfg = sanitizeMt5Config({ enabled: true, token: 'x'.repeat(32), historyBars: 300, resyncBars: 50, ...opts.cfg });
  const mt5 = new Mt5Provider(cfg, { client: bridge, now: () => bridge.nowMs, autoStart: false });
  const storage = memoryStorage({ 'tluxe.instrument.v1': opts.active ?? 'XAUUSD' });
  const services = createServices({ ...defaultProviders(), price: [mt5] }, { storage });
  const stop = connectServices(services);
  const state = (id: string) => services.market.store(id).getState();
  return { bridge, mt5, services, stop, state };
}

afterEach(() => vi.restoreAllMocks());

describe('Mt5Provider — symbol discovery', () => {
  it('resolves exact, alias, suffix and inverted symbols; stops on ambiguity; reports missing', async () => {
    const { mt5 } = setup();
    await mt5.pollHealth();
    const r = Object.fromEntries(mt5.state.getState().resolutions.map((x) => [x.instrumentId, x]));
    expect(r.XAUUSD).toMatchObject({ status: 'resolved', providerSymbol: 'XAUUSD', tier: 'exact' });
    expect(r.XAUUSD!.candidates).toContain('GOLD');
    expect(r.XAGUSD).toMatchObject({ status: 'resolved', providerSymbol: 'SILVER', tier: 'alias' });
    expect(r.EURUSD).toMatchObject({ status: 'resolved', providerSymbol: 'EURUSD.m', tier: 'variant' });
    expect(r.GBPUSD).toMatchObject({ status: 'ambiguous', providerSymbol: null });
    expect(r.GBPUSD!.candidates.sort()).toEqual(['GBPUSD.m', 'GBPUSD.pro']);
    expect(r.AUDUSD!.status).toBe('not-found');
    expect(r.USDCAD).toMatchObject({ status: 'resolved', providerSymbol: 'CADUSD', inverted: true });
  });

  it('never maps COMEX GC/SI onto MT5 spot symbols; futures-like symbols are only reported', async () => {
    const { mt5 } = setup();
    await mt5.pollHealth();
    const st = mt5.state.getState();
    expect(st.resolutions.find((x) => x.instrumentId === 'GC')).toMatchObject({ status: 'not-mapped', providerSymbol: null });
    expect(st.resolutions.find((x) => x.instrumentId === 'SI')).toMatchObject({ status: 'not-mapped', providerSymbol: null });
    expect(st.futuresCandidates.map((c) => c.name)).toEqual(['GCZ6']);
  });

  it('an explicit override wins over automatic discovery', async () => {
    const { mt5, state } = setup({ cfg: { overrides: { XAUUSD: { symbol: 'GOLD' } } } });
    await mt5.pollHealth();
    expect(state('XAUUSD').feed?.providerSymbol).toBe('GOLD');
  });

  it('ambiguous and missing symbols surface as AMBIGUOUS SYMBOL / SYMBOL NOT FOUND with no data', async () => {
    const amb = setup({ active: 'GBPUSD' });
    await amb.mt5.pollHealth();
    expect(amb.state('GBPUSD').feed?.code).toBe('AMBIGUOUS_SYMBOL');
    expect(amb.state('GBPUSD').connection).toBe('UNAVAILABLE');
    expect(amb.bridge.calls).toEqual([]);

    const miss = setup({ active: 'AUDUSD' });
    await miss.mt5.pollHealth();
    expect(miss.state('AUDUSD').feed?.code).toBe('SYMBOL_NOT_FOUND');
    expect(miss.state('AUDUSD').quote.last).toBeNull();
  });
});

describe('Mt5Provider — history, live updates and closed bars', () => {
  it('loads history for every timeframe S&R requests, with UTC times and closed/forming flags', async () => {
    const { mt5, services, state, bridge } = setup();
    await mt5.pollHealth();
    const tfs = [...new Set(bridge.calls.map((c) => c.tf))].sort();
    expect(tfs).toEqual(['D1', 'H1', 'H4', 'M1', 'M15', 'M30', 'M5']);
    const h1 = services.market.getCandles('XAUUSD', 'H1');
    expect(h1).toHaveLength(300);
    expect(h1.slice(0, -1).every((c) => c.isClosed === true)).toBe(true);
    expect(h1[h1.length - 1]!.isClosed).toBe(false);
    expect(h1.every((c) => c.time % 3600 === 0 && c.volume === null && c.tickVolume! > 0 && c.source === 'mt5')).toBe(true);
    const f = state('XAUUSD').feed!;
    expect(f.historyBars.H1).toBe(299);
    expect(f.meta).toMatchObject({ digits: 2, point: 0.01, contractSize: 100 });
    expect(state('XAUUSD').instrument.priceDecimals).toBe(2);
    expect(f.realVolumeAvailable).toBe(false);
  });

  it('reports history limited when the broker has fewer bars than requested', async () => {
    const { mt5, state, bridge } = setup();
    bridge.depth = 120;
    await mt5.pollHealth();
    expect(state('XAUUSD').feed!.historyLimited.H1).toBe(true);
    expect(state('XAUUSD').feed!.historyBars.H1).toBe(119);
  });

  it('INSUFFICIENT HISTORY when too few closed bars exist', async () => {
    const { mt5, state, bridge } = setup({ cfg: { minHistoryBars: 500 } });
    bridge.depth = 100;
    await mt5.pollHealth();
    await mt5.pollQuote();
    expect(state('XAUUSD').feed!.code).toBe('INSUFFICIENT_HISTORY');
  });

  it('quote updates make the feed LIVE with bid/ask and spread; volume stays unknown', async () => {
    const { mt5, state } = setup();
    await mt5.pollHealth();
    expect(state('XAUUSD').feed!.code).toBe('MT5_CONNECTED'); // no tick yet
    await mt5.pollQuote();
    const s = state('XAUUSD');
    expect(s.feed!.code).toBe('LIVE');
    expect(s.connection).toBe('LIVE');
    expect(s.quote.bid).toBeGreaterThan(2600);
    expect(s.quote.ask).toBeGreaterThan(s.quote.bid!);
    expect(s.quote.last).toBe(s.quote.bid);
    expect(s.quote.volume).toBeNull();
    expect(s.quote.spreadPoints).toBe(12);
    expect(s.quote.change).not.toBeNull(); // vs. previous closed D1 close
  });

  it('updates the forming bar and rolls over to a new bar without duplicates', async () => {
    const { mt5, services, bridge } = setup();
    await mt5.pollHealth();
    const before = services.market.getCandles('XAUUSD', 'M1');
    const forming = before[before.length - 1]!;
    bridge.nowMs += 20_000; // same minute
    await mt5.pollCandles();
    const mid = services.market.getCandles('XAUUSD', 'M1');
    expect(mid).toHaveLength(before.length);
    expect(mid[mid.length - 1]!.time).toBe(forming.time);
    expect(mid[mid.length - 1]!.isClosed).toBe(false);

    bridge.nowMs += 60_000; // next minute
    await mt5.pollCandles();
    const after = services.market.getCandles('XAUUSD', 'M1');
    expect(after).toHaveLength(before.length + 1);
    expect(new Set(after.map((c) => c.time)).size).toBe(after.length);
    expect(after[after.length - 2]).toMatchObject({ time: forming.time, isClosed: true });
    expect(after[after.length - 1]!.isClosed).toBe(false);
  });

  it('S&R receives only closed bars from MT5 (the forming bar is only a current price)', async () => {
    const spy = vi.spyOn(SRTimeframeEngine.prototype, 'update');
    const { mt5, services } = setup();
    await mt5.pollHealth();
    expect(spy).toHaveBeenCalled();
    for (const [candles, opts] of spy.mock.calls) {
      expect(candles.every((c) => c.isClosed === true)).toBe(true);
      expect(opts).toMatchObject({ lastBarClosed: true });
    }
    const h1 = services.market.getCandles('XAUUSD', 'H1');
    const lastCall = spy.mock.calls.findLast(([candles]) => candles.length === h1.length - 1);
    expect(lastCall?.[1]?.currentPrice).toBe(h1[h1.length - 1]!.close);
    expect(services.sr.store('XAUUSD').getState().byTimeframe.H1).toBeDefined();
  });
});

describe('Mt5Provider — connection states and recovery', () => {
  it('shows MT5 BRIDGE OFFLINE when the bridge is unreachable and never LIVE', async () => {
    const { mt5, state, bridge } = setup();
    bridge.offline = true;
    await mt5.pollHealth();
    expect(state('XAUUSD').feed!.code).toBe('MT5_BRIDGE_OFFLINE');
    expect(state('XAUUSD').connection).toBe('DISCONNECTED');
    expect(mt5.state.getState().error?.code).toBe('MT5_BRIDGE_OFFLINE');
  });

  it('goes OFFLINE after heartbeats stop, even with an earlier fresh quote', async () => {
    const { mt5, state, bridge } = setup();
    await mt5.pollHealth();
    await mt5.pollQuote();
    expect(state('XAUUSD').feed!.code).toBe('LIVE');
    bridge.offline = true;
    bridge.nowMs += 30_000;
    await mt5.pollHealth();
    await mt5.pollQuote();
    expect(state('XAUUSD').feed!.code).toBe('MT5_BRIDGE_OFFLINE');
    expect(state('XAUUSD').connection).not.toBe('LIVE');
  });

  it('shows MT5 NOT RUNNING when the terminal is closed', async () => {
    const { mt5, state, bridge } = setup();
    bridge.terminal = 'NOT_RUNNING';
    await mt5.pollHealth();
    expect(state('XAUUSD').feed!.code).toBe('MT5_NOT_RUNNING');
    expect(bridge.calls).toEqual([]);
  });

  it('goes STALE when ticks stop while the market is open', async () => {
    const { mt5, state, bridge } = setup();
    await mt5.pollHealth();
    await mt5.pollQuote();
    bridge.nowMs += 5 * 60_000;
    await mt5.pollHealth();
    expect(state('XAUUSD').feed!.code).toBe('STALE');
    expect(state('XAUUSD').connection).toBe('DISCONNECTED');
  });

  it('refuses to label quote times as UTC when the server timezone is unresolved', async () => {
    const { mt5, state, bridge } = setup();
    bridge.tzUnresolved = true;
    await mt5.pollHealth();
    await mt5.pollQuote();
    expect(state('XAUUSD').feed!.code).toBe('ERROR');
    expect(state('XAUUSD').feed!.message).toContain('TIMEZONE_UNRESOLVED');
  });

  it('after a bridge restart it reconnects, rediscovers and resyncs recent history', async () => {
    const { mt5, state, bridge, services } = setup();
    await mt5.pollHealth();
    const n = services.market.getCandles('XAUUSD', 'H1').length;
    bridge.offline = true;
    bridge.nowMs += 2 * 3600_000;
    await mt5.pollHealth();
    expect(state('XAUUSD').feed!.code).toBe('MT5_BRIDGE_OFFLINE');
    bridge.offline = false;
    bridge.startedAtMs = 2;
    bridge.calls.length = 0;
    await mt5.pollHealth();
    await mt5.pollQuote();
    expect(mt5.state.getState().reconnects).toBe(1);
    expect(bridge.calls.filter((c) => c.tf === 'H1').map((c) => c.count)).toEqual([50]);
    const h1 = services.market.getCandles('XAUUSD', 'H1');
    expect(h1.length).toBe(n + 2); // gap filled, no duplicates
    expect(new Set(h1.map((c) => c.time)).size).toBe(h1.length);
    expect(state('XAUUSD').feed!.code).toBe('LIVE');
  });
});

describe('Mt5Provider — instrument isolation', () => {
  it('switching instruments loads the new symbol and never mixes candles', async () => {
    const { mt5, services, state, bridge } = setup();
    await mt5.pollHealth();
    const xau = services.market.getCandles('XAUUSD', 'H1');
    services.instruments.select('EURUSD');
    await flush();
    expect(bridge.calls.some((c) => c.name === 'EURUSD.m')).toBe(true);
    const eur = services.market.getCandles('EURUSD', 'H1');
    expect(eur.length).toBeGreaterThan(0);
    expect(eur.every((c) => c.providerSymbol === 'EURUSD.m' && c.instrumentId === 'EURUSD' && c.close < 2)).toBe(true);
    expect(services.market.getCandles('XAUUSD', 'H1')).toEqual(xau);
    expect(state('XAUUSD').connection).toBe('DISCONNECTED'); // no longer streamed → never shown LIVE
    await mt5.pollQuote();
    expect(state('EURUSD').quote.bid).toBeLessThan(2);
    expect(state('XAUUSD').quote.bid).toBeNull(); // EURUSD ticks never land on XAUUSD
  });

  it('drops a history response that arrives after the user switched instrument', async () => {
    const { mt5, services, bridge } = setup();
    let release!: () => void;
    bridge.gate = new Promise<void>((r) => (release = r));
    const pending = mt5.pollHealth();
    await flush();
    services.instruments.select('EURUSD');
    bridge.gate = null;
    release();
    await pending;
    await flush();
    expect(services.market.getCandles('XAUUSD', 'H1')).toEqual([]);
    expect(services.market.getCandles('EURUSD', 'H1').length).toBeGreaterThan(0);
  });

  it('GC stays on its futures route: selecting it never queries MT5', async () => {
    const { mt5, services, state, bridge } = setup({ active: 'GC' });
    await mt5.pollHealth();
    await mt5.pollQuote();
    await mt5.pollCandles();
    expect(bridge.calls).toEqual([]);
    expect(state('GC').provider).toBeNull();
    expect(state('GC').feed).toBeNull();
    expect(services.market.getCandles('GC', 'H1')).toEqual([]);
  });

  it('switching timeframe on the chart only requests that symbol', async () => {
    const { mt5, services, bridge } = setup();
    await mt5.pollHealth();
    bridge.calls.length = 0;
    const off = services.market.subscribeCandles('XAUUSD', 'M5', () => {});
    off();
    expect(bridge.calls.every((c) => c.name === 'XAUUSD')).toBe(true);
  });
});
