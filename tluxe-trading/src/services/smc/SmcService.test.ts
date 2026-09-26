import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SMC_TIMEFRAMES } from '../../engines/smc/config';
import { candles } from '../../engines/smc/fixtures/builders';
import * as S from '../../engines/smc/fixtures/scenarios';
import { memoryStorage, ManualPriceProvider } from '../../test/providers';
import type { Candle, Timeframe } from '../../types/market';
import { connectServices, createServices, defaultProviders, type Services } from '../registry';
import { runSmcAudit } from './replayAudit';

/* TEST DATA ONLY — synthetic candles pushed through a manual provider (never production). */

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

const series = (tf: Timeframe, src: () => Candle[] = S.bullishTrend, scale = 1): Candle[] => {
  const s = src();
  const ov: Record<number, Partial<Candle>> = {};
  s.forEach((x, i) => (ov[i] = { open: x.open * scale, high: x.high * scale, low: x.low * scale }));
  const c = candles(s.map((x) => x.close * scale), { tf, ov });
  return c.map((x, i) => ({ ...x, isClosed: i < c.length - 1 }));
};

function setup(instrument = 'XAUUSD') {
  const provider = new ManualPriceProvider('mt5');
  const services = createServices({ ...defaultProviders(), price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': instrument }) });
  teardown = connectServices(services);
  return { provider, services };
}
const feedAll = (p: ManualPriceProvider, id: string, src = S.bullishTrend, scale = 1) =>
  act(() => {
    p.sink.connection(id, 'LIVE');
    for (const tf of SMC_TIMEFRAMES) p.sink.candles(id, tf, series(tf, src, scale), 'replace');
  });
const st = (s: Services) => s.smc.store.getState();

describe('SmcService', () => {
  it('no bridge / no candles → DATA UNAVAILABLE, nothing invented', () => {
    const { services } = setup();
    const x = st(services);
    expect(x.snapshot!.summary.verdict).toBe('DATA UNAVAILABLE');
    expect(x.snapshot!.score.total).toBeNull();
    for (const tf of SMC_TIMEFRAMES) expect(x.snapshot!.byTimeframe[tf]!.dataState).toBe('NO_DATA');
    expect(x.log).toEqual([]);
  });

  it('real-shaped closed candles on all seven timeframes → analysis, LIVE feed', () => {
    const { provider, services } = setup();
    feedAll(provider, 'XAUUSD');
    const x = st(services);
    expect(x.feed).toBe('LIVE');
    expect(x.snapshot!.summary.verdict).toBe('BULLISH ALIGNMENT');
    expect(x.snapshot!.byTimeframe.M15!.state).toBe('BULLISH');
    // Closed candles only: the forming bar is never analysed.
    const m15 = series('M15');
    expect(x.snapshot!.byTimeframe.M15!.barsProcessed).toBe(m15.length - 1);
    expect(x.log.length).toBeGreaterThan(0);
  });

  it('one market subscription: history requested once per timeframe, never duplicated by SMC', () => {
    const { provider, services } = setup();
    for (const tf of SMC_TIMEFRAMES) expect(provider.requestCandles.mock.calls.filter(([id, t]) => id === 'XAUUSD' && t === tf).length).toBeLessThanOrEqual(1);
    connectServices(services); // idempotent
    services.smc.start(); // re-attach to the same instrument is a no-op
    for (const tf of SMC_TIMEFRAMES) expect(provider.requestCandles.mock.calls.filter(([id, t]) => id === 'XAUUSD' && t === tf).length).toBeLessThanOrEqual(1);
  });

  it('HMR dispose + reconnect leaves exactly one listener (one analysis per candle update)', () => {
    const { provider, services } = setup();
    feedAll(provider, 'XAUUSD');
    teardown!();
    teardown = connectServices(services);
    const before = services.smc.runs;
    act(() => provider.sink.candles('XAUUSD', 'M15', series('M15'), 'replace'));
    expect(services.smc.runs - before).toBe(1);
  });

  it('symbol switch clears the previous instrument analysis immediately (XAUUSD → XAGUSD)', () => {
    const { provider, services } = setup();
    feedAll(provider, 'XAUUSD');
    expect(st(services).snapshot!.byTimeframe.H1!.barsProcessed).toBeGreaterThan(0);
    act(() => services.instruments.select('XAGUSD'));
    const x = st(services);
    expect(x.instrumentId).toBe('XAGUSD');
    expect(x.snapshot?.instrumentId ?? 'XAGUSD').toBe('XAGUSD');
    for (const tf of SMC_TIMEFRAMES) expect(x.snapshot?.byTimeframe[tf]?.barsProcessed ?? 0).toBe(0);
    expect(x.log.every((e) => e.instrumentId === 'XAGUSD')).toBe(true);
    feedAll(provider, 'XAGUSD', S.bullishReversal, 0.012);
    const y = st(services);
    expect(y.snapshot!.instrumentId).toBe('XAGUSD');
    expect(y.snapshot!.byTimeframe.M15!.state).toBe('BULLISH');
    expect(y.snapshot!.byTimeframe.M15!.breaks.some((b) => b.kind === 'CHOCH')).toBe(true);
  });

  it('stale feed → DATA STALE (logged once); recovery → DATA RECOVERED; never LIVE while stale', () => {
    const { provider, services } = setup();
    feedAll(provider, 'XAUUSD');
    act(() => provider.sink.connection('XAUUSD', 'DELAYED'));
    let x = st(services);
    expect(x.feed).toBe('STALE');
    expect(x.snapshot!.summary.verdict).toBe('DATA STALE');
    expect(x.log.filter((e) => e.type === 'DATA STALE')).toHaveLength(1);
    act(() => provider.sink.connection('XAUUSD', 'LIVE'));
    x = st(services);
    expect(x.feed).toBe('LIVE');
    expect(x.log.filter((e) => e.type === 'DATA RECOVERED')).toHaveLength(1);
  });

  it('revised closed candle: DATA REVISED logged once, rebuilt deterministically, no duplicate events', () => {
    const { provider, services } = setup();
    feedAll(provider, 'XAUUSD', S.bullishReversal);
    const m15 = series('M15', S.bullishReversal);
    const rev = m15.map((c, i) => (i === 100 ? { ...c, close: c.close + 0.3, high: Math.max(c.high, c.close + 0.3) } : c));
    act(() => provider.sink.candles('XAUUSD', 'M15', rev, 'replace'));
    let x = st(services);
    expect(x.log.filter((e) => e.type === 'DATA REVISED')).toHaveLength(1);
    expect(x.revisions).toBe(1);
    const ids = x.log.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    act(() => provider.sink.candles('XAUUSD', 'M15', rev, 'replace'));
    x = st(services);
    expect(x.log.filter((e) => e.type === 'DATA REVISED')).toHaveLength(1);
    expect(x.revisions).toBe(1);
  });

  it('replay: parity MATCH at every visited step; the audit on the loaded candles passes', async () => {
    const { provider, services } = setup();
    feedAll(provider, 'XAUUSD', S.bullishReversal);
    const r = services.smc.createReplay('M15', 10)!;
    for (const i of [10, 60, 97, 98, 40, 110]) {
      r.seek(i);
      expect(r.store.getState().parity).toEqual({ ok: true, mismatch: null });
      expect(r.store.getState().visible.length).toBe(i + 1);
      const K = r.store.getState().knowledgeTime!;
      expect(r.store.getState().visible.every((c) => c.time + 900 <= K)).toBe(true);
    }
    r.dispose();
    const rep = await runSmcAudit({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: services.smc.settings, candles: services.smc.input('XAUUSD') }, 120);
    expect(rep.passed).toBe(true);
    expect(rep.firstProblem).toBeNull();
  });
});
