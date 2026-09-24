/**
 * Liquidity service + replay: isolation, cutoff, determinism. TEST-ONLY candles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIQUIDITY_SETTINGS, LIQUIDITY_TF_SECONDS } from '../../engines/liquidity/config';
import { walk } from '../../engines/liquidity/fixtures/builders';
import * as F from '../../engines/liquidity/fixtures/scenarios';
import { analyzeLiquidityAt, knownBy, liquidityBarClose, type LiquidityDataset } from '../../engines/liquidity/knowledge';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import type { Candle, Timeframe } from '../../types/market';
import { connectServices, createServices, defaultProviders } from '../registry';
import { LiquidityReplaySession } from './LiquidityReplay';

const S = { ...DEFAULT_LIQUIDITY_SETTINGS };
const TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const json = (v: unknown) => JSON.stringify(v);

function aggregate(base: readonly Candle[], tf: Timeframe): Candle[] {
  const sec = LIQUIDITY_TF_SECONDS[tf];
  const out: Candle[] = [];
  for (const c of base) {
    const t = Math.floor(c.time / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ ...c, time: t });
  }
  return out;
}

const m5 = walk(3000, { seed: 31, start: 2650, vol: 1.6, tf: 'M5' });
const ds: LiquidityDataset = {
  instrumentId: 'XAUUSD',
  tickSize: 0.01,
  settings: S,
  candles: { M1: walk(15000, { seed: 32, start: 2650, vol: 0.7, tf: 'M1' }), M5: m5, M15: aggregate(m5, 'M15'), M30: aggregate(m5, 'M30'), H1: aggregate(m5, 'H1'), H4: aggregate(m5, 'H4'), D1: aggregate(m5, 'D1') },
};

afterEach(() => vi.useRealTimers());

describe('liquidity replay — knowledge cutoff', () => {
  it('state at every visited position === brand-new engines on bars known at K (forward, backward, jumps)', () => {
    const r = new LiquidityReplaySession(ds, 'H1', { startIndex: 70 });
    for (const m of [1, 1, 5, -3, 20, -30, 60, 1, -1, 45]) {
      if (Math.abs(m) === 1) r.step(m);
      else r.seek(r.store.getState().cursor + m);
      const s = r.store.getState();
      expect(json(s.multi)).toBe(json(analyzeLiquidityAt(ds, s.knowledgeTime!, s.price)));
    }
  });

  it('future candles cannot change what was known at K (missing or corrupted future → identical)', () => {
    const cursor = 150;
    const k = liquidityBarClose(ds.candles.H1![cursor]!, 'H1');
    const truncated = { ...ds, candles: Object.fromEntries(TFS.map((tf) => [tf, knownBy(ds.candles[tf]!, tf, k)])) };
    const corrupt = {
      ...ds,
      candles: Object.fromEntries(TFS.map((tf) => [tf, ds.candles[tf]!.map((c) => (c.time + LIQUIDITY_TF_SECONDS[tf] > k ? { ...c, high: c.high + 300, low: c.low - 300 } : c))])),
    };
    const a = new LiquidityReplaySession(ds, 'H1', { startIndex: cursor }).store.getState();
    expect(json(new LiquidityReplaySession(truncated, 'H1', { startIndex: cursor }).store.getState().multi)).toBe(json(a.multi));
    expect(json(new LiquidityReplaySession(corrupt, 'H1', { startIndex: cursor }).store.getState().multi)).toBe(json(a.multi));
  });

  it('MTF: a higher-timeframe bar still forming at K is invisible', () => {
    const m15 = ds.candles.M15!;
    const idx = m15.findIndex((c, i) => i > 300 && (c.time + 900) % (4 * 3600) === 3600);
    const s = new LiquidityReplaySession(ds, 'M15', { startIndex: idx }).store.getState();
    const k = s.knowledgeTime!;
    const straddling = ds.candles.H4!.find((c) => c.time < k && c.time + 4 * 3600 > k)!;
    expect(s.byTimeframe.H4!.lastClosedTime).toBe(straddling.time - 4 * 3600);
    expect(s.byTimeframe.M1!.lastClosedTime).toBe(k - 60);
  });

  it('sweep markers and pools never appear before they were knowable', () => {
    const flip = F.repeatedSweep();
    const d: LiquidityDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...S, minHistoryBars: 20 }, candles: { H1: flip } };
    const r = new LiquidityReplaySession(d, 'H1', { startIndex: flip.length - 1 });
    const pool = r.store.getState().byTimeframe.H1!.pools.find((p) => p.sweeps.length === 2)!;
    const idx = (t: number) => flip.findIndex((c) => c.time === t);
    const poolAt = (i: number) => (r.seek(i), r.store.getState().byTimeframe.H1!.pools.find((p) => p.id === pool.id));
    expect(poolAt(idx(pool.confirmedAt) - 1)).toBeUndefined();
    expect(poolAt(idx(pool.confirmedAt))).toBeDefined();
    for (const e of pool.sweeps) {
      expect(poolAt(idx(e.time) - 1)!.sweeps.some((x) => x.id === e.id)).toBe(false);
      expect(poolAt(idx(e.time))!.sweeps.some((x) => x.id === e.id)).toBe(true);
    }
  });

  it('20: identical replay results on repeated runs', () => {
    const walkRun = () => {
      const r = new LiquidityReplaySession(ds, 'M15', { startIndex: 200 });
      const out: string[] = [];
      for (let k = 0; k < 25; k++) {
        r.step(1);
        out.push(json(r.store.getState().multi));
      }
      return out;
    };
    expect(walkRun()).toEqual(walkRun());
  });

  it('switching the replay timeframe never moves the replay clock', () => {
    const r = new LiquidityReplaySession(ds, 'M5', { startIndex: 1200 });
    const k = r.store.getState().knowledgeTime;
    for (const tf of ['H1', 'D1', 'M1', 'M5'] as Timeframe[]) {
      r.setTimeframe(tf);
      expect(r.store.getState().knowledgeTime).toBe(k);
    }
  });

  it('play / pause / speed / reset', () => {
    vi.useFakeTimers();
    const r = new LiquidityReplaySession(ds, 'H4', { startIndex: 30 });
    r.setSpeed(5);
    r.play();
    vi.advanceTimersByTime(1000);
    expect(r.store.getState().cursor).toBe(35);
    r.pause();
    r.toStart();
    expect(r.store.getState().cursor).toBe(0);
    r.dispose();
  });
});

describe('liquidity service — live pipeline isolation', () => {
  function live(active = 'XAUUSD') {
    const provider = new ManualPriceProvider('mt5');
    const services = createServices({ ...defaultProviders(), price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': active }) });
    connectServices(services);
    return { provider, services };
  }
  const closedFlags = (c: Candle[]) => c.map((x, i) => ({ ...x, isClosed: i < c.length - 1 }));

  it('analyses real candles per timeframe from their own candles; no extra provider requests', () => {
    const { provider, services } = live();
    // Both S&R and Liquidity subscribe, yet history is requested once per timeframe.
    const perTf = provider.requestCandles.mock.calls.filter((c) => c[0] === 'XAUUSD');
    expect(perTf.map((c) => c[1]).sort()).toEqual([...TFS].sort());
    provider.sink.connection('XAUUSD', 'LIVE');
    provider.sink.candles('XAUUSD', 'H1', closedFlags(F.cleanBSL()), 'replace');
    const st = services.liquidity.store('XAUUSD').getState();
    expect(st.byTimeframe.H1!.state).toBe('READY');
    expect(st.byTimeframe.H1!.pools.every((p) => p.timeframe === 'H1' && p.instrumentId === 'XAUUSD')).toBe(true);
    expect(st.byTimeframe.M15).toBeUndefined(); // nothing manufactured for other timeframes
  });

  it('forming bar: structure comes only from closed bars; the forming close only moves price', () => {
    const { provider, services } = live();
    const c = closedFlags(F.cleanBSL());
    provider.sink.candles('XAUUSD', 'H1', c, 'replace');
    const before = services.liquidity.store('XAUUSD').getState().byTimeframe.H1!;
    provider.sink.candles('XAUUSD', 'H1', [{ ...c.at(-1)!, high: 999, close: 140, isClosed: false }], 'upsert');
    const after = services.liquidity.store('XAUUSD').getState().byTimeframe.H1!;
    expect(json(after.pools.map((p) => [p.id, p.state, p.sweeps, p.tests]))).toBe(json(before.pools.map((p) => [p.id, p.state, p.sweeps, p.tests])));
    expect(after.currentPrice).toBe(140);
    expect(after.barsProcessed).toBe(before.barsProcessed);
  });

  it('instrument switching: XAUUSD liquidity never leaks into another instrument', () => {
    const { provider, services } = live();
    provider.sink.candles('XAUUSD', 'H1', closedFlags(F.cleanBSL()), 'replace');
    services.instruments.select('EURUSD');
    expect(services.liquidity.store('EURUSD').getState().multi?.pools ?? []).toEqual([]);
    provider.sink.candles('XAUUSD', 'H4', closedFlags(F.cleanBSL()), 'replace'); // late XAUUSD data
    expect(services.liquidity.store('EURUSD').getState().multi?.pools ?? []).toEqual([]);
  });

  it('S&R is independent: its store is identical with or without Liquidity running', () => {
    const a = live();
    a.provider.sink.candles('XAUUSD', 'H1', closedFlags(F.cleanBSL()), 'replace');
    const withLiquidity = json(a.services.sr.store('XAUUSD').getState().byTimeframe.H1);
    const b = live();
    b.services.liquidity.start()(); // stop the liquidity service
    b.provider.sink.candles('XAUUSD', 'H1', closedFlags(F.cleanBSL()), 'replace');
    expect(json(b.services.sr.store('XAUUSD').getState().byTimeframe.H1)).toBe(withLiquidity);
  });

  it('replay from the service uses a frozen closed-only copy and never touches the live store', () => {
    const { provider, services } = live();
    const c = closedFlags(F.repeatedSweep());
    provider.sink.candles('XAUUSD', 'H1', c, 'replace');
    const liveBefore = services.liquidity.store('XAUUSD').getState();
    const r = services.liquidity.createReplay('H1', 60)!;
    r.step(1);
    r.seek(10);
    r.dispose();
    expect(services.liquidity.store('XAUUSD').getState()).toBe(liveBefore);
    expect(r.dataset.candles.H1!.length).toBe(c.length - 1);
    expect(Object.isFrozen(r.dataset.candles.H1![0])).toBe(true);
  });
});
