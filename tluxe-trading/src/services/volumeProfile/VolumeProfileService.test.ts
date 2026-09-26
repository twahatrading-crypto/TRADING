import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_VP_SETTINGS } from '../../engines/volumeProfile/config';
import { analyzeVolumeProfile } from '../../engines/volumeProfile/engine';
import { dataset } from '../../engines/volumeProfile/fixtures/builders';
import { memoryStorage, ManualPriceProvider } from '../../test/providers';
import type { Candle, Timeframe } from '../../types/market';
import { connectServices, createServices, defaultProviders, type Services } from '../registry';

/* TEST DATA ONLY — synthetic candles + synthetic tick volume pushed through a manual provider. */

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

const TFS: Timeframe[] = ['D1', 'H4', 'H1', 'M30', 'M15', 'M5'];
type DS = Record<Exclude<Timeframe, 'M1'>, Candle[]>;
const closed = (c: readonly Candle[]) => c.map((x) => ({ ...x, isClosed: true }));

function setup(instrument = 'XAUUSD') {
  const provider = new ManualPriceProvider('mt5');
  const services = createServices({ ...defaultProviders(), price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': instrument }) });
  teardown = connectServices(services);
  return { provider, services };
}
const feed = (p: ManualPriceProvider, id: string, ds: DS) =>
  act(() => {
    p.sink.connection(id, 'LIVE');
    for (const tf of TFS) p.sink.candles(id, tf, closed(ds[tf as keyof DS]), 'replace');
  });
const st = (s: Services) => s.volumeProfile.store.getState();

describe('VolumeProfileService', () => {
  it('no candles → VOLUME DATA UNAVAILABLE, no profile, no score, nothing invented', () => {
    const { services } = setup();
    const x = st(services);
    expect(x.snapshot!.knowledgeTime).toBeNull();
    expect(x.snapshot!.source.mode).toBe('NONE');
    expect(x.snapshot!.source.label).toBe('VOLUME DATA UNAVAILABLE');
    expect(Object.keys(x.snapshot!.profiles)).toHaveLength(0);
    expect(x.score?.total ?? null).toBeNull();
    expect(x.log).toEqual([]);
  });

  it('MT5 candles → profiles labelled "MT5 Tick Volume" (never exchange volume)', () => {
    const { provider, services } = setup();
    feed(provider, 'XAUUSD', dataset(6, 11));
    const x = st(services);
    expect(x.feed).toBe('LIVE');
    const s = x.snapshot!;
    expect(s.source.mode).toBe('MT5_TICK');
    expect(s.source.label).toBe('MT5 Tick Volume');
    for (const p of Object.values(s.profiles)) expect(p!.source.label).not.toMatch(/COMEX|Exchange/);
    expect(s.profiles.PREVIOUS_DAY!.poc).not.toBeNull();
    expect(s.mtf.map((r) => r.timeframe)).toEqual(['D1', 'H4', 'H1', 'M30', 'M15', 'M5']);
    expect(x.score!.total).not.toBeNull();
    expect(x.score!.note).toMatch(/not a probability/);
  });

  it('one market subscription: history requested at most once per timeframe; start() is idempotent', () => {
    const { provider, services } = setup();
    const count = (tf: Timeframe) => provider.requestCandles.mock.calls.filter(([id, t]) => id === 'XAUUSD' && t === tf).length;
    for (const tf of TFS) expect(count(tf)).toBeLessThanOrEqual(1);
    connectServices(services);
    const stop = services.volumeProfile.start();
    for (const tf of TFS) expect(count(tf)).toBeLessThanOrEqual(1);
    stop();
  });

  it('HMR dispose + reconnect leaves exactly one listener (one rebuild per candle update)', () => {
    const { provider, services } = setup();
    const ds = dataset(4, 3);
    feed(provider, 'XAUUSD', ds);
    teardown!();
    teardown = connectServices(services);
    const before = services.volumeProfile.runs;
    act(() => provider.sink.candles('XAUUSD', 'M15', closed(ds.M15), 'replace'));
    expect(services.volumeProfile.runs - before).toBe(1);
  });

  it('symbol switch clears the previous instrument (XAUUSD → XAGUSD) and XAGUSD builds independently', () => {
    const { provider, services } = setup();
    feed(provider, 'XAUUSD', dataset(5, 5));
    expect(st(services).snapshot!.profiles.DAILY).toBeDefined();
    act(() => services.instruments.select('XAGUSD'));
    let x = st(services);
    expect(x.instrumentId).toBe('XAGUSD');
    expect(x.snapshot?.knowledgeTime ?? null).toBeNull();
    expect(x.log).toEqual([]);
    feed(provider, 'XAGUSD', dataset(5, 9, { start: 31, vol: 0.02 }));
    x = st(services);
    expect(x.snapshot!.instrumentId).toBe('XAGUSD');
    const pd = x.snapshot!.profiles.PREVIOUS_DAY!;
    expect(pd.poc).toBeGreaterThan(29);
    expect(pd.poc).toBeLessThan(33);
    expect(x.log.every((e) => e.instrumentId === 'XAGUSD')).toBe(true);
  });

  it('GC without an exchange-volume provider → GC VOLUME DATA UNAVAILABLE (MT5 tick volume never substituted)', () => {
    const { services } = setup('GC');
    const x = st(services);
    expect(x.instrumentId).toBe('GC');
    expect(x.snapshot!.unavailable).toBe('GC VOLUME DATA UNAVAILABLE');
    expect(x.score?.total ?? null).toBeNull();
  });

  it('revised closed candle: DATA REVISED logged once, rebuilt equal to a clean recomputation', () => {
    const { provider, services } = setup();
    const ds = dataset(5, 21);
    feed(provider, 'XAUUSD', ds);
    const i = ds.M5.length - 200;
    const rev = ds.M5.map((c, k) => (k === i ? { ...c, tickVolume: (c.tickVolume ?? 0) + 5000 } : c));
    act(() => provider.sink.candles('XAUUSD', 'M5', closed(rev), 'replace'));
    const x = st(services);
    expect(x.log.filter((e) => e.type === 'DATA REVISED')).toHaveLength(1);
    expect(x.revisions).toBe(1);
    const clean = analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: { kind: 'spot-otc', exchange: null }, settings: DEFAULT_VP_SETTINGS, candles: { ...ds, M5: rev } });
    expect(x.snapshot!.profiles.DAILY!.poc).toBe(clean.profiles.DAILY!.poc);
    expect(x.snapshot!.profiles.PREVIOUS_DAY!.rows).toEqual(clean.profiles.PREVIOUS_DAY!.rows);
    act(() => provider.sink.candles('XAUUSD', 'M5', closed(rev), 'replace'));
    expect(st(services).log.filter((e) => e.type === 'DATA REVISED')).toHaveLength(1);
  });

  it('replay: every step matches a clean recomputation (parity) and never shows later candles', () => {
    const { provider, services } = setup();
    feed(provider, 'XAUUSD', dataset(4, 8));
    const r = services.volumeProfile.createReplay('M15', 60)!;
    for (let k = 0; k < 12; k++) {
      r.step(7);
      const s = r.store.getState();
      expect(s.parity?.ok).toBe(true);
      expect(s.visible.every((c) => c.time + 900 <= s.knowledgeTime!)).toBe(true);
      expect(s.snapshot!.knowledgeTime).toBeLessThanOrEqual(s.knowledgeTime!);
    }
    r.dispose();
  });

  it('confluence only names other engines as read-only sources (never a signal)', () => {
    const { provider, services } = setup();
    feed(provider, 'XAUUSD', dataset(6, 13));
    for (const c of st(services).confluence) expect(['Liquidity engine (via SMC)', 'Order Block engine (via SMC)', 'SMC engine', 'S&R engine']).toContain(c.engine);
    for (const c of st(services).confluence) expect(`${c.detail} ${c.with}`).not.toMatch(/\b(BUY|SELL|ENTRY|STOP LOSS|TAKE PROFIT)\b/);
  });
});
