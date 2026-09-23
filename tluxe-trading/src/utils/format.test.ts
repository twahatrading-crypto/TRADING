import { describe, expect, it } from 'vitest';
import { directionOf, formatPercent, formatPrice, formatSigned, formatVolume, UNKNOWN } from './format';

describe('formatters never turn missing data into numbers', () => {
  it.each([null, undefined, NaN, Infinity])('%s → UNKNOWN', (v) => {
    expect(formatPrice(v)).toBe(UNKNOWN);
    expect(formatSigned(v)).toBe(UNKNOWN);
    expect(formatPercent(v)).toBe(UNKNOWN);
    expect(formatVolume(v)).toBe(UNKNOWN);
    expect(directionOf(v)).toBe('unknown');
  });

  it('formats real values', () => {
    expect(formatPrice(2362.4)).toBe('2,362.4');
    expect(formatSigned(12.6)).toBe('+12.6');
    expect(formatSigned(-3)).toBe('−3.0');
    expect(formatPercent(0.54)).toBe('+0.54%');
    expect(formatVolume(12487)).toBe('12,487');
    expect(formatPrice(0)).toBe('0.0'); // a real zero stays zero
  });
});
