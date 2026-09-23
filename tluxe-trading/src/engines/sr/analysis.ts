import type { SRSettings } from './settings';
import { isHolding } from './stateMachine';
import type { SRConfluence, SRZone } from './types';

/**
 * Facts about current S&R context. Deliberately contains NO trade direction:
 * the S&R engine identifies price areas and their state, nothing more.
 */
export interface SRFacts {
  price: number | null;
  nearestSupport: SRZone | null;
  nearestResistance: SRZone | null;
  strongestNearbySupport: SRZone | null;
  strongestNearbyResistance: SRZone | null;
  insideZones: SRZone[];
  nearbyConfluences: SRConfluence[];
}

export function summarize(
  zones: readonly SRZone[],
  confluences: readonly SRConfluence[],
  price: number | null,
  settings: Pick<SRSettings, 'nearbyAtr'>,
): SRFacts {
  const holding = zones.filter((z) => isHolding(z.status));
  if (price === null) {
    return { price, nearestSupport: null, nearestResistance: null, strongestNearbySupport: null, strongestNearbyResistance: null, insideZones: [], nearbyConfluences: [] };
  }
  const inside = holding.filter((z) => price >= z.zoneLow && price <= z.zoneHigh);
  const below = holding.filter((z) => z.role === 'support' && z.zoneHigh < price).sort((a, b) => b.zoneHigh - a.zoneHigh);
  const above = holding.filter((z) => z.role === 'resistance' && z.zoneLow > price).sort((a, b) => a.zoneLow - b.zoneLow);
  const near = (z: SRZone) => z.distanceAtr !== null && z.distanceAtr <= settings.nearbyAtr;
  const strongest = (list: SRZone[]) => [...list].filter(near).sort((a, b) => b.score.total - a.score.total)[0] ?? null;
  const members = new Map(zones.map((z) => [z.id, z]));
  return {
    price,
    nearestSupport: below[0] ?? null,
    nearestResistance: above[0] ?? null,
    strongestNearbySupport: strongest([...below, ...inside.filter((z) => z.role === 'support')]),
    strongestNearbyResistance: strongest([...above, ...inside.filter((z) => z.role === 'resistance')]),
    insideZones: inside,
    nearbyConfluences: confluences.filter((c) => c.zoneIds.some((id) => {
      const z = members.get(id);
      return !!z && near(z);
    })),
  };
}
