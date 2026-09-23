import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import { finalizeScore } from './scoring';
import { CONFLUENCE_PER_EXTRA_TF, CONFLUENCE_TF_BONUS, TIMEFRAME_RANK, type SRSettings } from './settings';
import { isHolding } from './stateMachine';
import type { SRConfluence, SRMultiSnapshot, SRSnapshot, SRZone } from './types';

/**
 * Multi-timeframe confluence. Each timeframe is analysed independently first;
 * this only compares zones that were really detected on their own timeframe.
 *
 * Rule:
 *  - Eligible zones: HOLDING status (FRESH/ACTIVE/TESTED/WEAKENING/FLIPPED).
 *  - Anchors are taken in order: higher timeframe first, then higher score, then id.
 *  - For each other timeframe (high → low) the best-scoring eligible zone of the same
 *    current role whose overlap with the running intersection is
 *    ≥ confluenceMinOverlap × min(intersection width, zone width) joins; the
 *    intersection narrows to the overlap.
 *  - ≥ 2 distinct timeframes → one confluence. A zone belongs to at most one confluence.
 *  - Member zones get confluence component = 50 × (timeframes − 1) (max 100) and are rescored.
 *  - Confluence score = min(100, round(mean(member base scores) + 10 × (timeframes − 1))).
 */
export function buildMultiSnapshot(
  instrumentId: InstrumentId,
  byTimeframe: Partial<Record<Timeframe, SRSnapshot>>,
  settings: SRSettings,
): SRMultiSnapshot {
  const all: SRZone[] = Object.values(byTimeframe)
    .filter((s): s is SRSnapshot => !!s && s.state === 'READY' && s.instrumentId === instrumentId)
    .flatMap((s) => s.zones);

  const eligible = all
    .filter((z) => isHolding(z.status))
    .sort((a, b) => TIMEFRAME_RANK[b.timeframe] - TIMEFRAME_RANK[a.timeframe] || b.score.total - a.score.total || (a.id < b.id ? -1 : 1));
  const timeframes = [...new Set(eligible.map((z) => z.timeframe))].sort((a, b) => TIMEFRAME_RANK[b] - TIMEFRAME_RANK[a]);

  const used = new Set<string>();
  const confluences: SRConfluence[] = [];

  for (const anchor of eligible) {
    if (used.has(anchor.id)) continue;
    const members = [anchor];
    let lo = anchor.zoneLow;
    let hi = anchor.zoneHigh;
    for (const tf of timeframes) {
      if (tf === anchor.timeframe) continue;
      let pick: SRZone | null = null;
      for (const z of eligible) {
        if (z.timeframe !== tf || z.role !== anchor.role || used.has(z.id)) continue;
        const ov = Math.min(hi, z.zoneHigh) - Math.max(lo, z.zoneLow);
        if (ov <= 0 || ov < settings.confluenceMinOverlap * Math.min(hi - lo, z.width)) continue;
        if (!pick || z.score.total > pick.score.total || (z.score.total === pick.score.total && z.id < pick.id)) pick = z;
      }
      if (pick) {
        members.push(pick);
        lo = Math.max(lo, pick.zoneLow);
        hi = Math.min(hi, pick.zoneHigh);
      }
    }
    if (members.length < 2) continue;
    members.forEach((m) => used.add(m.id));
    const ids = members.map((m) => m.id);
    confluences.push({
      id: `${instrumentId}:CF:${anchor.role === 'support' ? 'S' : 'R'}:${ids.join('+')}`,
      instrumentId,
      role: anchor.role,
      zoneIds: ids,
      timeframes: members.map((m) => m.timeframe),
      members: members.map((m) => ({ zoneId: m.id, timeframe: m.timeframe, zoneLow: m.zoneLow, zoneHigh: m.zoneHigh, score: m.score.total })),
      overlapLow: lo,
      overlapHigh: hi,
      score: Math.min(100, Math.round(members.reduce((a, m) => a + m.score.total, 0) / members.length + CONFLUENCE_TF_BONUS * (members.length - 1))),
    });
  }

  const byZone = new Map<string, SRConfluence>();
  confluences.forEach((c) => c.zoneIds.forEach((id) => byZone.set(id, c)));
  const zones = all.map((z) => {
    const c = byZone.get(z.id);
    if (!c) return z;
    const components = { ...z.score.components, confluence: Math.min(100, CONFLUENCE_PER_EXTRA_TF * (c.timeframes.length - 1)) };
    return { ...z, confluenceIds: [c.id], score: finalizeScore(components, z.status) };
  });

  return { instrumentId, byTimeframe, zones, confluences };
}
