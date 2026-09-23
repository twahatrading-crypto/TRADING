import { describe, expect, it, vi } from 'vitest';
import { GC_INSTRUMENT } from '../../config/instrument';
import { EMPTY_QUOTE, type Candle, type MarketState } from '../../types/market';
import type { MarketDataProvider, MarketDataSink } from './MarketDataProvider';
import { MarketDataService } from './MarketDataService';
import { NullMarketDataProvider } from './NullMarketDataProvider';
import { getQuoteDisplayMode, mergeQuote, normalizeCandles } from './normalize';

/** Test double that lets a test drive the sink directly. */
class ManualProvider implements MarketDataProvider {
  readonly info = { id: 'manual', name: 'Manual Test Feed', declaredDelaySec: null };
  sink: MarketDataSink | null = null;
  requestCandles = vi.fn();
  connect(_s: string, sink: MarketDataSink) {
    this.sink = sink;
  }
  disconnect() {}
}

describe('NullMarketDataProvider (no provider configured)', () => {
  it('reports UNAVAILABLE with no provider and an entirely unknown quote', () => {
    const svc = new MarketDataService(new NullMarketDataProvider(), GC_INSTRUMENT);
    svc.connect();
    const s = svc.store.getState();
    expect(s.connection).toBe('UNAVAILABLE');
    expect(s.provider).toBeNull();
    expect(s.quote).toEqual(EMPTY_QUOTE);
    expect(Object.values(s.quote).every((v) => v === null)).toBe(true);
    expect(s.instrument.contract).toBeNull();
    expect(s.lastMessageAt).toBeNull();
  });

  it('never produces candles', () => {
    const svc = new MarketDataService(new NullMarketDataProvider(), GC_INSTRUMENT);
    svc.connect();
    const listener = vi.fn();
    svc.subscribeCandles('H1', listener);
    expect(svc.getCandles('H1')).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not claim to be connected before or after connect()', () => {
    const svc = new MarketDataService(new NullMarketDataProvider(), GC_INSTRUMENT);
    expect(svc.store.getState().connection).toBe('UNAVAILABLE');
    svc.connect();
    expect(['LIVE', 'DELAYED']).not.toContain(svc.store.getState().connection);
  });
});

describe('MarketDataService with a provider', () => {
  it('starts DISCONNECTED and only goes LIVE when the provider says so', () => {
    const p = new ManualProvider();
    const svc = new MarketDataService(p, GC_INSTRUMENT, () => 1000);
    expect(svc.store.getState().connection).toBe('DISCONNECTED');
    svc.connect();
    p.sink!.connection('CONNECTING');
    expect(svc.store.getState().connection).toBe('CONNECTING');
    p.sink!.connection('LIVE');
    expect(svc.store.getState().connection).toBe('LIVE');
  });

  it('keeps fields the provider did not send as null (never 0)', () => {
    const p = new ManualProvider();
    const svc = new MarketDataService(p, GC_INSTRUMENT, () => 1000);
    svc.connect();
    p.sink!.quote({ last: 2400.5, bid: 2400.4 });
    const q = svc.store.getState().quote;
    expect(q.last).toBe(2400.5);
    expect(q.ask).toBeNull();
    expect(q.volume).toBeNull();
    expect(q.change).toBeNull();
  });

  it('pushes normalized candles to subscribers and requests history once', () => {
    const p = new ManualProvider();
    const svc = new MarketDataService(p, GC_INSTRUMENT);
    svc.connect();
    const l = vi.fn();
    svc.subscribeCandles('M5', l);
    svc.subscribeCandles('M5', vi.fn());
    expect(p.requestCandles).toHaveBeenCalledTimes(1);
    p.sink!.candles('M5', [{ time: 200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }], 'replace');
    expect(l).toHaveBeenCalledWith([{ time: 200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }], 'replace');
  });
});

describe('mergeQuote', () => {
  it('rejects NaN / Infinity / non-numbers as unknown', () => {
    const q = mergeQuote({ ...EMPTY_QUOTE }, { last: NaN, bid: Infinity, ask: '5' as unknown as number, high: 10 });
    expect(q).toMatchObject({ last: null, bid: null, ask: null, high: 10 });
  });

  it('leaves omitted keys untouched', () => {
    const q = mergeQuote({ ...EMPTY_QUOTE, last: 5 }, { bid: 4 });
    expect(q.last).toBe(5);
  });
});

describe('normalizeCandles', () => {
  const c = (time: number, o: number, h: number, l: number, cl: number): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: null });
  it('drops invalid bars, dedupes by time and sorts', () => {
    const out = normalizeCandles([
      c(300, 1, 2, 0, 1),
      c(100, 1, 2, 0, 1),
      c(200, 1, 0.5, 0, 1), // high below open → invalid
      c(100, 1, 3, 0, 2), // duplicate time, last wins
      c(400, NaN, 2, 0, 1),
    ]);
    expect(out.map((x) => x.time)).toEqual([100, 300]);
    expect(out[0]!.high).toBe(3);
  });
});

describe('getQuoteDisplayMode', () => {
  const base: MarketState = {
    instrument: GC_INSTRUMENT,
    provider: null,
    connection: 'UNAVAILABLE',
    quote: { ...EMPTY_QUOTE },
    lastMessageAt: null,
    error: null,
  };

  it('is unavailable with no provider and no data', () => {
    expect(getQuoteDisplayMode(base, 10_000, 15_000)).toBe('unavailable');
  });

  it('is unavailable when LIVE is reported but no values have arrived', () => {
    expect(getQuoteDisplayMode({ ...base, connection: 'LIVE' }, 10_000, 15_000)).toBe('unavailable');
  });

  it('is live only with LIVE connection, data, and a fresh message', () => {
    const s = { ...base, connection: 'LIVE' as const, quote: { ...EMPTY_QUOTE, last: 1 }, lastMessageAt: 9_000 };
    expect(getQuoteDisplayMode(s, 10_000, 15_000)).toBe('live');
    expect(getQuoteDisplayMode(s, 40_000, 15_000)).toBe('stale');
  });

  it('marks last-known values stale after a disconnect', () => {
    const s = { ...base, connection: 'DISCONNECTED' as const, quote: { ...EMPTY_QUOTE, last: 1 }, lastMessageAt: 9_000 };
    expect(getQuoteDisplayMode(s, 10_000, 15_000)).toBe('stale');
  });

  it('reports delayed and connecting', () => {
    const d = { ...base, connection: 'DELAYED' as const, quote: { ...EMPTY_QUOTE, bid: 1 }, lastMessageAt: 9_000 };
    expect(getQuoteDisplayMode(d, 10_000, 15_000)).toBe('delayed');
    expect(getQuoteDisplayMode({ ...base, connection: 'CONNECTING' }, 10_000, 15_000)).toBe('connecting');
  });
});
