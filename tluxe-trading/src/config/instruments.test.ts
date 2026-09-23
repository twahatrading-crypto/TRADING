import { describe, expect, it } from 'vitest';
import { DEPTH_CAPABILITIES } from '../types/instruments';
import { getInstrument, groupInstruments, INSTRUMENTS, isInstrumentId, searchInstruments } from './instruments';

const get = (id: string) => {
  const d = getInstrument(id);
  if (!d) throw new Error(id);
  return d;
};

describe('instrument registry', () => {
  it('contains exactly the Phase 1 instruments with unique ids', () => {
    const ids = INSTRUMENTS.map((i) => i.id);
    expect(ids).toEqual(['GC', 'SI', 'XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'AUDUSD', 'USDCAD', 'BTCUSD', 'ETHUSD', 'SOLUSD', 'DXY', 'NASDAQ']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the specified display names', () => {
    expect(get('GC').displayName).toBe('GC — COMEX Gold Futures');
    expect(get('SI').displayName).toBe('SI — COMEX Silver Futures');
    expect(get('XAUUSD').displayName).toBe('XAUUSD — Gold / US Dollar');
    expect(get('XAGUSD').displayName).toBe('XAGUSD — Silver / US Dollar');
    expect(get('BTCUSD').displayName).toBe('BTCUSD — Bitcoin');
    expect(get('DXY').displayName).toBe('DXY — U.S. Dollar Index');
  });

  it('uses conventional USDCAD, never CADUSD', () => {
    expect(isInstrumentId('USDCAD')).toBe(true);
    expect(isInstrumentId('CADUSD')).toBe(false);
    expect(get('USDCAD').fx).toEqual({ base: 'USD', quote: 'CAD' });
  });

  it('never hard-codes a provider symbol — every mapping must be discovered or configured', () => {
    for (const i of INSTRUMENTS) for (const m of i.providerMappings) expect(m.symbol).toBeNull();
  });

  it('derives instrument capabilities from its mappings', () => {
    for (const i of INSTRUMENTS) {
      const union = new Set(i.providerMappings.flatMap((m) => m.capabilities));
      expect(new Set(i.capabilities)).toEqual(union);
    }
  });
});

describe('GC vs XAUUSD and SI vs XAGUSD stay distinct', () => {
  it.each([
    ['GC', 'XAUUSD'],
    ['SI', 'XAGUSD'],
  ])('%s (COMEX futures) is not %s (MT5 spot/CFD)', (fut, spot) => {
    const f = get(fut);
    const s = get(spot);
    expect(f.id).not.toBe(s.id);
    expect(f.assetClass).toBe('futures');
    expect(s.assetClass).toBe('metals');
    expect(f.exchange).toBe('COMEX');
    expect(s.exchange).toBeNull();
    expect(f.providerMappings.map((m) => m.family).sort()).toEqual(['depth-feed', 'futures-feed']);
    expect(s.providerMappings.map((m) => m.family)).toEqual(['mt5']);
    // MT5 price data never implies exchange depth.
    expect(s.capabilities.some((c) => DEPTH_CAPABILITIES.includes(c))).toBe(false);
    expect(f.capabilities).toEqual(expect.arrayContaining(['level2', 'mbo', 'mbp']));
    expect(f.tradingHours).not.toEqual(s.tradingHours);
  });

  it('only COMEX futures carry exchange "COMEX"', () => {
    expect(INSTRUMENTS.filter((i) => i.exchange === 'COMEX').map((i) => i.id)).toEqual(['GC', 'SI']);
  });
});

describe('crypto and indices are provider-dependent', () => {
  it('crypto assumes no single exchange', () => {
    for (const id of ['BTCUSD', 'ETHUSD', 'SOLUSD']) {
      expect(get(id).exchange).toBeNull();
      expect(get(id).tradingHours).toBe('24/7');
    }
  });

  it('NASDAQ is a non-tradable category with variants and no mappings', () => {
    const n = get('NASDAQ');
    expect(n.kind).toBe('category');
    expect(n.tradable).toBe(false);
    expect(n.providerMappings).toEqual([]);
    expect(n.variants?.map((v) => v.kind)).toEqual(['index', 'future', 'spot-otc']);
  });
});

describe('grouping and search', () => {
  it('groups by asset class in selector order', () => {
    const g = groupInstruments();
    expect(g.map((x) => x.assetClass)).toEqual(['futures', 'metals', 'forex', 'crypto', 'indices']);
    expect(Object.fromEntries(g.map((x) => [x.assetClass, x.instruments.map((i) => i.id)]))).toEqual({
      futures: ['GC', 'SI'],
      metals: ['XAUUSD', 'XAGUSD'],
      forex: ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDCAD'],
      crypto: ['BTCUSD', 'ETHUSD', 'SOLUSD'],
      indices: ['DXY', 'NASDAQ'],
    });
  });

  it.each([
    ['gold', ['GC', 'XAUUSD']],
    ['silver', ['SI', 'XAGUSD']],
    ['bitcoin', ['BTCUSD']],
    ['usd/cad', ['USDCAD']],
    ['eur usd', ['EURUSD']],
    ['nq', ['NASDAQ']],
    ['zzz', []],
  ])('"%s" → %j', (q, ids) => {
    expect(searchInstruments(q).map((i) => i.id)).toEqual(ids);
  });

  it('omits empty groups after filtering', () => {
    expect(groupInstruments(searchInstruments('gold')).map((g) => g.assetClass)).toEqual(['futures', 'metals']);
  });
});
