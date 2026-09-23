import { describe, expect, it } from 'vitest';
import { getInstrument } from '../../config/instruments';
import { EMPTY_QUOTE } from '../../types/market';
import { invertQuote, resolveProviderSymbol } from './symbolMapping';

const I = (id: string) => getInstrument(id)!;

describe('resolveProviderSymbol', () => {
  it('needs discovery before any provider symbol is assumed', () => {
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5')).toEqual({ status: 'needs-discovery' });
  });

  it('1. explicit override wins over everything', () => {
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { available: ['XAUUSD', 'GOLD.a'], overrides: { XAUUSD: { symbol: 'GOLD.a' } } })).toMatchObject({
      status: 'resolved', providerSymbol: 'GOLD.a', tier: 'override',
    });
  });

  it('2. exact canonical name wins; lower-tier matches are reported as alternatives', () => {
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { available: ['XAUUSD', 'XAUUSD.pro', 'GOLD'] })).toEqual({
      status: 'resolved', providerSymbol: 'XAUUSD', inverted: false, source: 'discovered', tier: 'exact', alternatives: ['GOLD', 'XAUUSD.pro'],
    });
    expect(resolveProviderSymbol(I('EURUSD'), 'mt5', { available: ['#EURUSD'] })).toMatchObject({ providerSymbol: '#EURUSD', tier: 'exact' });
  });

  it('3. safe alias match (GOLD for XAUUSD)', () => {
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { available: ['GOLD', 'SILVER'] })).toMatchObject({ providerSymbol: 'GOLD', tier: 'alias' });
    expect(resolveProviderSymbol(I('XAGUSD'), 'mt5', { available: ['GOLD', 'SILVER'] })).toMatchObject({ providerSymbol: 'SILVER', tier: 'alias' });
  });

  it('4. broker suffix / prefix variants', () => {
    for (const sym of ['XAUUSD.a', 'XAUUSDm', 'XAUUSD_i', 'XAUUSD-ECN', 'XAUUSDpro', 'm.XAUUSD', 'GOLD.a', 'GOLDm']) {
      expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { available: ['EURUSD', sym, 'US30'] })).toMatchObject({ status: 'resolved', providerSymbol: sym, tier: 'variant' });
    }
  });

  it('never treats an uppercase tail as a decoration', () => {
    expect(resolveProviderSymbol(I('EURUSD'), 'mt5', { available: ['EURUSDJPY', 'EURUSDX'] })).toEqual({ status: 'not-found' });
  });

  it('5. ambiguity inside a tier stops and reports every candidate', () => {
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { available: ['XAUUSD.a', 'XAUUSD.pro', 'EURUSD'] })).toEqual({
      status: 'ambiguous', candidates: ['XAUUSD.a', 'XAUUSD.pro'], tier: 'variant',
    });
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { available: ['GOLD.a', 'GOLDm'] })).toMatchObject({ status: 'ambiguous' });
  });

  it('reports not-found when the broker does not offer it', () => {
    expect(resolveProviderSymbol(I('BTCUSD'), 'mt5', { available: ['EURUSD', 'XAUUSD'] })).toEqual({ status: 'not-found' });
    // Long unrelated suffixes are not treated as the same instrument.
    expect(resolveProviderSymbol(I('EURUSD'), 'mt5', { available: ['EURUSDFUTURE2026'] })).toEqual({ status: 'not-found' });
  });

  it('honours explicit overrides, validated against the provider list', () => {
    const overrides = { XAUUSD: { symbol: 'Gold.spot' } };
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { overrides })).toMatchObject({ status: 'resolved', providerSymbol: 'Gold.spot', source: 'override' });
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { overrides, available: ['Gold.spot'] })).toMatchObject({ providerSymbol: 'Gold.spot' });
    expect(resolveProviderSymbol(I('XAUUSD'), 'mt5', { overrides, available: ['XAUUSD'] })).toEqual({ status: 'not-found' });
  });

  it('maps a reciprocal CADUSD feed onto canonical USDCAD as inverted', () => {
    expect(resolveProviderSymbol(I('USDCAD'), 'mt5', { available: ['CADUSD'] })).toMatchObject({
      status: 'resolved', providerSymbol: 'CADUSD', inverted: true, source: 'discovered',
    });
    // The direct pair wins when present.
    expect(resolveProviderSymbol(I('USDCAD'), 'mt5', { available: ['CADUSD', 'USDCAD'] })).toMatchObject({ providerSymbol: 'USDCAD', inverted: false });
  });

  it('keeps futures and spot on separate provider families', () => {
    expect(resolveProviderSymbol(I('GC'), 'mt5', { available: ['XAUUSD', 'GC'] })).toEqual({ status: 'not-mapped' });
    expect(resolveProviderSymbol(I('XAUUSD'), 'futures-feed', { available: ['GC', 'XAUUSD'] })).toEqual({ status: 'not-mapped' });
    expect(resolveProviderSymbol(I('SI'), 'depth-feed', { role: 'depth', available: ['SIZ6', 'GCZ6'] })).toMatchObject({ providerSymbol: 'SIZ6' });
    // Contract-month codes are only accepted for futures/depth feeds, never on MT5 spot/CFD mappings.
    expect(resolveProviderSymbol(I('EURUSD'), 'mt5', { available: ['EURUSDZ6'] })).toEqual({ status: 'not-found' });
    expect(resolveProviderSymbol(I('XAGUSD'), 'depth-feed', { role: 'depth', available: ['XAGUSD'] })).toEqual({ status: 'not-mapped' });
  });

  it('never resolves the NASDAQ category directly', () => {
    for (const f of ['mt5', 'index-feed', 'futures-feed'] as const) {
      expect(resolveProviderSymbol(I('NASDAQ'), f, { available: ['NDX', 'NQ', 'US100', 'NASDAQ'] })).toEqual({ status: 'not-mapped' });
    }
  });
});

describe('invertQuote', () => {
  it('converts CADUSD into USDCAD orientation', () => {
    const q = invertQuote({ ...EMPTY_QUOTE, last: 0.8, bid: 0.79, ask: 0.8, high: 0.81, low: 0.78, change: 0.01, volume: 5 });
    expect(q.last).toBeCloseTo(1.25);
    expect(q.bid).toBeCloseTo(1 / 0.8);
    expect(q.ask).toBeCloseTo(1 / 0.79);
    expect(q.high).toBeCloseTo(1 / 0.78);
    expect(q.low).toBeCloseTo(1 / 0.81);
    expect(q.change).toBeCloseTo(1.25 - 1 / 0.79);
    expect(q.volume).toBe(5);
  });

  it('keeps unknowns unknown', () => {
    expect(invertQuote({ ...EMPTY_QUOTE })).toEqual(EMPTY_QUOTE);
    expect(invertQuote({ ...EMPTY_QUOTE, last: 2 }).change).toBeNull();
  });
});
