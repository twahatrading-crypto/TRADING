import type { SmcSettings } from './config';
import type { SmcDealingRange, SmcRangeLocation } from './types';

/**
 * Premium / discount inside a VALID dealing range: pct = (price − low) / (high − low) × 100.
 * EQUILIBRIUM within 50 % ± eqBandPct / 2, PREMIUM above, DISCOUNT below; outside the range
 * ABOVE_RANGE / BELOW_RANGE. Never computed without a valid range.
 */
export function rangeLocation(r: Pick<SmcDealingRange, 'high' | 'low'>, price: number, s: Pick<SmcSettings, 'eqBandPct'>): SmcRangeLocation {
  const span = r.high - r.low;
  const pct = span > 0 ? ((price - r.low) / span) * 100 : 50;
  const half = s.eqBandPct / 2;
  const zone = pct > 100 ? 'ABOVE_RANGE' : pct < 0 ? 'BELOW_RANGE' : Math.abs(pct - 50) <= half ? 'EQUILIBRIUM' : pct > 50 ? 'PREMIUM' : 'DISCOUNT';
  return { price, pct, zone };
}
