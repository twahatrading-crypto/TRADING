import { DISPLAY_MAX_OVERLAP, DISPLAY_PROXIMITY_CAP_ATR, DISPLAY_PROXIMITY_PENALTY, type SRSettings } from './settings';
import type { SRZone, ZoneStatus } from './types';

/**
 * DISPLAY-ONLY selection of the most relevant zones (ALL TF view and chart).
 * It never mutates or deletes engine zones — it returns a subset for drawing.
 *
 * 1. Exclude EXPIRED always, and BROKEN unless explicitly requested.
 * 2. Exclude zones scoring below minDisplayScore.
 * 3. Rank: score − 4 × min(distanceAtr, 10)   (near + strong first; score already
 *    includes timeframe significance, status and confluence).
 * 4. Skip a zone overlapping an already-selected same-role zone by ≥ 60 % of its width.
 * 5. Keep the first maxDisplayedZones.
 */
export function displayRank(z: SRZone): number {
  return z.score.total - DISPLAY_PROXIMITY_PENALTY * Math.min(z.distanceAtr ?? DISPLAY_PROXIMITY_CAP_ATR, DISPLAY_PROXIMITY_CAP_ATR);
}

export function selectDisplayZones(
  zones: readonly SRZone[],
  settings: Pick<SRSettings, 'minDisplayScore' | 'maxDisplayedZones'>,
  opts: { includeStatuses?: readonly ZoneStatus[] } = {},
): SRZone[] {
  const allowBroken = opts.includeStatuses?.includes('BROKEN') ?? false;
  const ranked = zones
    .filter((z) => z.status !== 'EXPIRED' && (allowBroken || z.status !== 'BROKEN'))
    .filter((z) => z.score.total >= settings.minDisplayScore)
    .sort((a, b) => displayRank(b) - displayRank(a) || (a.id < b.id ? -1 : 1));
  const out: SRZone[] = [];
  for (const z of ranked) {
    if (out.length >= settings.maxDisplayedZones) break;
    const redundant = out.some((o) => {
      if (o.role !== z.role) return false;
      const ov = Math.min(o.zoneHigh, z.zoneHigh) - Math.max(o.zoneLow, z.zoneLow);
      return ov > 0 && ov >= DISPLAY_MAX_OVERLAP * z.width;
    });
    if (!redundant) out.push(z);
  }
  return out;
}
