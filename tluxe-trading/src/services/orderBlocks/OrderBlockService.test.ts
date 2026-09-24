import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OB_SETTINGS, OB_TF_SECONDS } from '../../engines/orderBlocks/config';
import { walk } from '../../engines/orderBlocks/fixtures/builders';
import * as F from '../../engines/orderBlocks/fixtures/scenarios';
import { analyzeOBAt, obBarClose, obKnownBy, type OBDataset } from '../../engines/orderBlocks/knowledge';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import type { Candle, Timeframe } from '../../types/market';
import { connectServices, createServices, defaultProviders } from '../registry';
import { OrderBlockReplaySession } from './OrderBlockReplay';

const S = { ...DEFAULT_OB_SETTINGS };
const TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const json = (v: unknown) => JSON.stringify(v);
function aggregate(base: readonly Candle[], tf: Timeframe): Candle[] {
  const sec = OB_TF_SECONDS[tf];
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
const m5 = walk(3000, { seed: 44, start: 2650, vol: 1.6, tf: 'M5' });
const ds: OBDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, settings: S, candles: { M1: walk(15000, { seed: 45, start: 2650, vol: 0.7, tf: 'M1' }), M5: m5, M15: aggregate(m5, 'M15'), M30: aggregate(m5, 'M30'), H1: aggregate(m5, 'H1'), H4: aggregate(m5, 'H4'), D1: aggregate(m5, 'D1') } };

afterEach(() => vi.useRealTimers());

describe('order block replay — parity with clean recomputation', () => {
  it('every visited step (forward, backward, jumps) reports parity OK and equals the clean recomputation', () => {
    const r = new OrderBlockReplaySession(ds, 'H1', { startIndex: 70, verify: true });
    for (const m of [1, 1, 4, -2, 25, -40, 60, 1, -1, 30]) {
      if (Math.abs(m) === 1) r.step(m);
      else r.seek(r.store.getState().cursor + m);
      const s = r.store.getState();
      expect(s.parity).toEqual({ ok: true, mismatches: [] });
      expect(json(s.multi)).toBe(json(analyzeOBAt(ds, s.knowledgeTime!, s.price)));
    }
  });

  it('future candles cannot change what was known at K; a still-forming H4 bar is invisible', () => {
    const cursor = 160;
    const k = obBarClose(ds.candles.H1![cursor]!, 'H1');
    const truncated = { ...ds, candles: Object.fromEntries(TFS.map((tf) => [tf, obKnownBy(ds.candles[tf]!, tf, k)])) };
    const a = new OrderBlockReplaySession(ds, 'H1', { startIndex: cursor }).store.getState();
    expect(json(new OrderBlockReplaySession(truncated, 'H1', { startIndex: cursor }).store.getState().multi)).toBe(json(a.multi));
    const m15 = ds.candles.M15!;
    const idx = m15.findIndex((c, i) => i > 300 && (c.time + 900) % (4 * 3600) === 3600);
    const s = new OrderBlockReplaySession(ds, 'M15', { startIndex: idx }).store.getState();
    const straddling = ds.candles.H4!.find((c) => c.time < s.knowledgeTime! && c.time + 4 * 3600 > s.knowledgeTime!)!;
    expect(s.byTimeframe.H4!.lastClosedTime).toBe(straddling.time - 4 * 3600);
  });

  it('blocks never appear before their confirmation bar closes', () => {
    const c = F.fullMitigation();
    const d: OBDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...S, minHistoryBars: 20 }, candles: { H1: c } };
    const r = new OrderBlockReplaySession(d, 'H1', { startIndex: c.length - 1 });
    const block = r.store.getState().byTimeframe.H1!.blocks.find((b) => b.low === 86)!;
    const at = (i: number) => (r.seek(i), r.store.getState().byTimeframe.H1!.blocks.find((b) => b.id === block.id));
    expect(at(block.confirmedIndex - 1)).toBeUndefined();
    expect(at(block.confirmedIndex)).toBeDefined();
    expect(at(block.confirmedIndex)!.low).toBe(86);
  });

  it('identical replay results on repeated runs; play / pause / reset / speed', () => {
    const go = () => {
      const r = new OrderBlockReplaySession(ds, 'M15', { startIndex: 200 });
      return Array.from({ length: 20 }, () => (r.step(1), json(r.store.getState().multi)));
    };
    expect(go()).toEqual(go());
    vi.useFakeTimers();
    const r = new OrderBlockReplaySession(ds, 'H4', { startIndex: 30 });
    r.setSpeed(10);
    r.play();
    vi.advanceTimersByTime(500);
    expect(r.store.getState().cursor).toBe(35);
    r.pause();
    r.reset();
    expect(r.store.getState().cursor).toBe(0);
    r.dispose();
  });
});

describe('order block service — live isolation', () => {
  function live(active = 'XAUUSD') {
    const provider = new ManualPriceProvider('mt5');
    const services = createServices({ ...defaultProviders(), price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': active }) });
    connectServices(services);
    return { provider, services };
  }
  const flags = (c: Candle[]) => c.map((x, i) => ({ ...x, isClosed: i < c.length - 1 }));

  it('real candles per timeframe; no extra provider requests; nothing manufactured for other timeframes', () => {
    const { provider, services } = live();
    expect(provider.requestCandles.mock.calls.filter((c) => c[0] === 'XAUUSD').map((c) => c[1]).sort()).toEqual([...TFS].sort());
    provider.sink.candles('XAUUSD', 'H1', flags(F.cleanBullish()), 'replace');
    const st = services.orderBlocks.store('XAUUSD').getState();
    expect(st.byTimeframe.H1!.blocks.every((b) => b.timeframe === 'H1' && b.instrumentId === 'XAUUSD')).toBe(true);
    expect(st.byTimeframe.M15).toBeUndefined();
  });

  it('XAUUSD blocks never appear while XAGUSD is selected', () => {
    const { provider, services } = live();
    provider.sink.candles('XAUUSD', 'H1', flags(F.cleanBullish()), 'replace');
    services.instruments.select('XAGUSD');
    provider.sink.candles('XAUUSD', 'H4', flags(F.cleanBullish()), 'replace');
    expect(services.orderBlocks.store('XAGUSD').getState().multi?.blocks ?? []).toEqual([]);
  });

  it('S&R and Liquidity outputs are identical with or without the Order Block service', () => {
    const a = live();
    a.provider.sink.candles('XAUUSD', 'H1', flags(F.cleanBullish()), 'replace');
    const b = live();
    b.services.orderBlocks.start()();
    b.provider.sink.candles('XAUUSD', 'H1', flags(F.cleanBullish()), 'replace');
    expect(json(b.services.sr.store('XAUUSD').getState().byTimeframe.H1)).toBe(json(a.services.sr.store('XAUUSD').getState().byTimeframe.H1));
    expect(json(b.services.liquidity.store('XAUUSD').getState().byTimeframe.H1)).toBe(json(a.services.liquidity.store('XAUUSD').getState().byTimeframe.H1));
  });

  it('replay uses a frozen closed-only copy and never touches the live store', () => {
    const { provider, services } = live();
    const c = flags(F.fullMitigation());
    provider.sink.candles('XAUUSD', 'H1', c, 'replace');
    const before = services.orderBlocks.store('XAUUSD').getState();
    const r = services.orderBlocks.createReplay('H1', 60)!;
    r.step(1);
    r.dispose();
    expect(services.orderBlocks.store('XAUUSD').getState()).toBe(before);
    expect(r.dataset.candles.H1!.length).toBe(c.length - 1);
  });
});
