import { describe, expect, it } from 'vitest';
import { INSTRUMENTS } from './instruments';

/**
 * The authoritative instrument -> provider registry (config/instruments.ts providerMappings). Each canonical
 * instrument has exactly ONE price-provider family, so the router can never substitute one provider for another:
 * GC is never priced from MT5, XAUUSD is never priced from Databento, and nothing falls back across providers.
 */
const priceFamilies = (id: string) => INSTRUMENTS.find((d) => d.id === id)!.providerMappings.filter((m) => m.role === 'price').map((m) => m.family);

describe('provider routing - two independent real providers, no cross substitution', () => {
  it('XAUUSD / XAGUSD -> MT5 only; GC / SI -> Databento (futures feed) only', () => {
    expect(priceFamilies('XAUUSD')).toEqual(['mt5']);
    expect(priceFamilies('XAGUSD')).toEqual(['mt5']);
    expect(priceFamilies('GC')).toEqual(['futures-feed']);
    expect(priceFamilies('SI')).toEqual(['futures-feed']);
  });

  it('GC and XAUUSD stay separate instruments (no alias, no shared mapping)', () => {
    const gc = INSTRUMENTS.find((d) => d.id === 'GC')!;
    const xau = INSTRUMENTS.find((d) => d.id === 'XAUUSD')!;
    expect(gc.aliases ?? []).not.toContain('XAUUSD');
    expect(xau.aliases ?? []).not.toContain('GC');
    expect(gc.providerMappings.some((m) => m.family === 'mt5')).toBe(false);
    expect(xau.providerMappings.some((m) => m.family === 'futures-feed')).toBe(false);
  });
});
