import { describe, expect, it, vi } from 'vitest';
import { getInstrument, INSTRUMENTS } from '../../config/instruments';
import { ManualDepthProvider, ManualPriceProvider } from '../../test/providers';
import type { InstrumentDefinition } from '../../types/instruments';
import { EMPTY_QUOTE, type Candle, type MarketState } from '../../types/market';
import { MarketDataService } from './MarketDataService';
import { getQuoteDisplayMode, mergeQuote, normalizeCandles } from './normalize';

const bar = (time: number): Candle => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

describe('per-instrument state with no providers (Phase 1)', () => {
  const svc = new MarketDataService({ instruments: INSTRUMENTS });
  svc.connect();

  it.each(INSTRUMENTS.map((i) => i.id))('%s is independently UNAVAILABLE with an unknown quote', (id) => {
    svc.activate(id);
    const s = svc.store(id).getState();
    expect(s.instrument.id).toBe(id);
    expect(s.connection).toBe('UNAVAILABLE');
    expect(s.provider).toBeNull();
    expect(s.quote).toEqual(EMPTY_QUOTE);
    expect(s.lastMessageAt).toBeNull();
    expect(s.capabilities).toEqual([]);
    expect(s.depth.connection).toBe('UNAVAILABLE');
    expect(s.depth.provider).toBeNull();
    expect(svc.getCandles(id, 'H1')).toEqual([]);
  });

  it('knows which instruments could have depth at all', () => {
    expect(svc.store('GC').getState().depth.supported).toBe(true);
    expect(svc.store('SI').getState().depth.supported).toBe(true);
    expect(svc.store('XAUUSD').getState().depth.supported).toBe(false);
    expect(svc.store('EURUSD').getState().depth.supported).toBe(false);
  });

  it('keeps one store per instrument', () => {
    expect(svc.store('GC')).not.toBe(svc.store('XAUUSD'));
    expect(() => svc.store('CADUSD')).toThrow();
  });
});

describe('routing and isolation', () => {
  function setup() {
    const futures = new ManualPriceProvider('futures-feed');
    const mt5 = new ManualPriceProvider('mt5');
    const depth = new ManualDepthProvider();
    const svc = new MarketDataService({ instruments: INSTRUMENTS, price: [futures, mt5], depth: [depth], clock: () => 1000 });
    svc.connect();
    return { svc, futures, mt5, depth };
  }

  it('routes COMEX futures to the futures feed and metals/forex to MT5', () => {
    const { svc, futures, mt5 } = setup();
    expect(svc.store('GC').getState().provider?.id).toBe('test-futures-feed');
    expect(svc.store('SI').getState().provider?.id).toBe('test-futures-feed');
    expect(svc.store('XAUUSD').getState().provider?.id).toBe('test-mt5');
    expect(svc.store('USDCAD').getState().provider?.id).toBe('test-mt5');
    expect(svc.store('NASDAQ').getState().provider).toBeNull();
    svc.activate('GC');
    expect(futures.subscribed).toEqual(['GC']);
    expect(mt5.subscribed).toEqual([]);
    svc.activate('XAUUSD');
    expect(futures.unsubscribe).toHaveBeenCalledWith('GC');
    expect(mt5.subscribed).toEqual(['XAUUSD']);
  });

  it('a GC quote never appears on XAUUSD (or vice versa)', () => {
    const { svc, futures, mt5 } = setup();
    futures.sink.connection('GC', 'LIVE');
    futures.sink.quote('GC', { last: 2400.1 });
    expect(svc.store('GC').getState().quote.last).toBe(2400.1);
    expect(svc.store('XAUUSD').getState().quote.last).toBeNull();
    expect(svc.store('XAUUSD').getState().connection).toBe('DISCONNECTED');
    mt5.sink.quote('XAUUSD', { last: 2398.55 });
    expect(svc.store('GC').getState().quote.last).toBe(2400.1);
  });

  it('ignores data a provider sends for instruments not routed to it', () => {
    const { svc, mt5 } = setup();
    mt5.sink.connection('GC', 'LIVE');
    mt5.sink.quote('GC', { last: 1 });
    mt5.sink.candles('SI', 'H1', [bar(100)], 'replace');
    expect(svc.store('GC').getState().connection).toBe('DISCONNECTED');
    expect(svc.store('GC').getState().quote.last).toBeNull();
    expect(svc.getCandles('SI', 'H1')).toEqual([]);
  });

  it('keeps candles per instrument and timeframe', () => {
    const { svc, futures, mt5 } = setup();
    const gc = vi.fn();
    const xau = vi.fn();
    svc.subscribeCandles('GC', 'H1', gc);
    svc.subscribeCandles('XAUUSD', 'H1', xau);
    expect(futures.requestCandles).toHaveBeenCalledWith('GC', 'H1');
    expect(mt5.requestCandles).toHaveBeenCalledWith('XAUUSD', 'H1');
    futures.sink.candles('GC', 'H1', [bar(100)], 'replace');
    expect(gc).toHaveBeenCalledTimes(1);
    expect(xau).not.toHaveBeenCalled();
    expect(svc.getCandles('XAUUSD', 'H1')).toEqual([]);
    expect(svc.getCandles('GC', 'M5')).toEqual([]);
  });
});

describe('price and depth are independent', () => {
  it('price can be CONNECTED while depth is NOT connected', () => {
    const futures = new ManualPriceProvider('futures-feed');
    const svc = new MarketDataService({ instruments: INSTRUMENTS, price: [futures] });
    svc.connect();
    futures.sink.connection('GC', 'LIVE');
    const s = svc.store('GC').getState();
    expect(s.connection).toBe('LIVE');
    expect(s.depth.connection).toBe('UNAVAILABLE');
    expect(s.depth.provider).toBeNull();
  });

  it('a depth feed updates depth state and books only for depth-mapped instruments', () => {
    const depth = new ManualDepthProvider();
    const svc = new MarketDataService({ instruments: INSTRUMENTS, depth: [depth], clock: () => 42 });
    svc.connect();
    svc.activate('GC');
    expect(depth.subscribed).toEqual(['GC']);
    depth.sink.connection('GC', 'LIVE');
    depth.sink.book({ instrumentId: 'GC', bids: [{ price: 1, size: 2, orders: null }], asks: [], kind: 'mbp', timestamp: 1 });
    expect(svc.store('GC').getState().depth).toMatchObject({ connection: 'LIVE', lastMessageAt: 42 });
    expect(svc.store('GC').getState().connection).toBe('UNAVAILABLE'); // no price feed
    expect(svc.getDepth('GC')?.kind).toBe('mbp');
    depth.sink.book({ instrumentId: 'XAUUSD', bids: [], asks: [], kind: 'level2', timestamp: 1 });
    expect(svc.getDepth('XAUUSD')).toBeNull();
  });
});

describe('unsupported capabilities are never manufactured', () => {
  const quoteOnly: InstrumentDefinition = {
    ...getInstrument('DXY')!,
    id: 'QONLY',
    providerMappings: [{ family: 'index-feed', role: 'price', symbol: null, discoveryHints: [], capabilities: ['quote'] }],
    capabilities: ['quote'],
  };

  it('drops candles when the mapping does not declare OHLCV', () => {
    const p = new ManualPriceProvider('index-feed');
    const svc = new MarketDataService({ instruments: [quoteOnly], price: [p] });
    svc.connect();
    const l = vi.fn();
    svc.subscribeCandles('QONLY', 'H1', l);
    p.sink.candles('QONLY', 'H1', [bar(100)], 'replace');
    expect(l).not.toHaveBeenCalled();
    expect(svc.getCandles('QONLY', 'H1')).toEqual([]);
  });

  it('reported capabilities are intersected with the mapping', () => {
    const p = new ManualPriceProvider('mt5');
    const svc = new MarketDataService({ instruments: INSTRUMENTS, price: [p] });
    svc.connect();
    p.sink.capabilities('XAUUSD', ['quote', 'ohlcv', 'level2', 'mbo', 'trades']);
    expect(svc.store('XAUUSD').getState().capabilities.sort()).toEqual(['ohlcv', 'quote']);
  });
});

describe('mergeQuote', () => {
  it('rejects NaN / Infinity / non-numbers as unknown', () => {
    const q = mergeQuote({ ...EMPTY_QUOTE }, { last: NaN, bid: Infinity, ask: '5' as unknown as number, high: 10 });
    expect(q).toMatchObject({ last: null, bid: null, ask: null, high: 10 });
  });

  it('leaves omitted keys untouched', () => {
    expect(mergeQuote({ ...EMPTY_QUOTE, last: 5 }, { bid: 4 }).last).toBe(5);
  });
});

describe('normalizeCandles', () => {
  const c = (time: number, o: number, h: number, l: number, cl: number): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: null });
  it('drops invalid bars, dedupes by time and sorts', () => {
    const out = normalizeCandles([c(300, 1, 2, 0, 1), c(100, 1, 2, 0, 1), c(200, 1, 0.5, 0, 1), c(100, 1, 3, 0, 2), c(400, NaN, 2, 0, 1)]);
    expect(out.map((x) => x.time)).toEqual([100, 300]);
    expect(out[0]!.high).toBe(3);
  });
});

describe('getQuoteDisplayMode', () => {
  const base = new MarketDataService({ instruments: INSTRUMENTS }).store('GC').getState();
  const with_ = (p: Partial<MarketState>): MarketState => ({ ...base, ...p });

  it('is unavailable with no provider and no data', () => {
    expect(getQuoteDisplayMode(base, 10_000, 15_000)).toBe('unavailable');
  });

  it('is unavailable when LIVE is reported but no values have arrived', () => {
    expect(getQuoteDisplayMode(with_({ connection: 'LIVE' }), 10_000, 15_000)).toBe('unavailable');
  });

  it('is live only with LIVE connection, data, and a fresh message', () => {
    const s = with_({ connection: 'LIVE', quote: { ...EMPTY_QUOTE, last: 1 }, lastMessageAt: 9_000 });
    expect(getQuoteDisplayMode(s, 10_000, 15_000)).toBe('live');
    expect(getQuoteDisplayMode(s, 40_000, 15_000)).toBe('stale');
  });

  it('marks last-known values stale after a disconnect', () => {
    expect(getQuoteDisplayMode(with_({ connection: 'DISCONNECTED', quote: { ...EMPTY_QUOTE, last: 1 }, lastMessageAt: 9_000 }), 10_000, 15_000)).toBe('stale');
  });

  it('reports delayed and connecting', () => {
    expect(getQuoteDisplayMode(with_({ connection: 'DELAYED', quote: { ...EMPTY_QUOTE, bid: 1 }, lastMessageAt: 9_000 }), 10_000, 15_000)).toBe('delayed');
    expect(getQuoteDisplayMode(with_({ connection: 'CONNECTING' }), 10_000, 15_000)).toBe('connecting');
  });
});
