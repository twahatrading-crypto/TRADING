import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import { LIQUIDITY_TF_RANK, type LiquiditySettings } from './config';
import { finalizeLiquidityScore } from './score';
import type { LiquidityCluster, LiquidityMultiSnapshot, LiquidityPool, LiquiditySnapshot } from './types';

/** Untaken, qualified liquidity (the only pools that can form MTF clusters or be "nearest"). */
export const isOpenLiquidity = (p: LiquidityPool) => p.state === 'ACTIVE' || p.state === 'TESTED';

const band = (p: LiquidityPool) => [p.level - p.tolerance, p.level + p.tolerance] as const;

/**
 * Multi-timeframe liquidity clusters. Every timeframe detects its own pools from
 * its own candles first; this ONLY compares those independent detections — no
 * level is ever copied to another timeframe.
 *
 *  - Eligible: ACTIVE / TESTED pools. Anchors in order: higher timeframe, higher score, id.
 *  - For each other timeframe (high → low) the pool of the same side whose band
 *    (level ± its tolerance) intersects the anchor's band and whose level is closest to
 *    the anchor level joins (ties: higher score, then id). A pool joins at most one cluster.
 *  - ≥ 2 timeframes → cluster. Span = [min, max] of member levels.
 *  - Members' confluence component = 50 × (timeframes − 1), max 100 (then rescored).
 *  - Cluster score = min(100, round(max member score + 5 × (timeframes − 1))).
 */
export function buildLiquidityMulti(
  instrumentId: InstrumentId,
  byTimeframe: Partial<Record<Timeframe, LiquiditySnapshot>>,
  _settings: LiquiditySettings,
): LiquidityMultiSnapshot {
  const all = Object.values(byTimeframe)
    .filter((s): s is LiquiditySnapshot => !!s && s.state === 'READY' && s.instrumentId === instrumentId)
    .flatMap((s) => s.pools);
  const eligible = all
    .filter(isOpenLiquidity)
    .sort((a, b) => LIQUIDITY_TF_RANK[b.timeframe] - LIQUIDITY_TF_RANK[a.timeframe] || b.score.total - a.score.total || (a.id < b.id ? -1 : 1));
  const tfs = [...new Set(eligible.map((p) => p.timeframe))].sort((a, b) => LIQUIDITY_TF_RANK[b] - LIQUIDITY_TF_RANK[a]);
  const used = new Set<string>();
  const clusters: LiquidityCluster[] = [];

  for (const anchor of eligible) {
    if (used.has(anchor.id)) continue;
    const [aLo, aHi] = band(anchor);
    const members = [anchor];
    for (const tf of tfs) {
      if (tf === anchor.timeframe) continue;
      let pick: LiquidityPool | null = null;
      for (const p of eligible) {
        if (p.timeframe !== tf || p.side !== anchor.side || used.has(p.id)) continue;
        const [lo, hi] = band(p);
        if (hi < aLo || lo > aHi) continue;
        const d = Math.abs(p.level - anchor.level);
        const pd = pick ? Math.abs(pick.level - anchor.level) : Infinity;
        if (!pick || d < pd || (d === pd && (p.score.total > pick.score.total || (p.score.total === pick.score.total && p.id < pick.id)))) pick = p;
      }
      if (pick) members.push(pick);
    }
    if (members.length < 2) continue;
    members.forEach((m) => used.add(m.id));
    const levels = members.map((m) => m.level);
    clusters.push({
      id: `${instrumentId}:LQCF:${anchor.side}:${members.map((m) => m.id).join('+')}`,
      side: anchor.side,
      poolIds: members.map((m) => m.id),
      timeframes: members.map((m) => m.timeframe),
      members: members.map((m) => ({ poolId: m.id, timeframe: m.timeframe, level: m.level, score: m.score.total })),
      low: Math.min(...levels),
      high: Math.max(...levels),
      score: Math.min(100, Math.round(Math.max(...members.map((m) => m.score.total)) + 5 * (members.length - 1))),
    });
  }

  const byPool = new Map<string, LiquidityCluster>();
  clusters.forEach((c) => c.poolIds.forEach((id) => byPool.set(id, c)));
  const pools = all.map((p) => {
    const c = byPool.get(p.id);
    if (!c) return p;
    const components = { ...p.score.components, confluence: Math.min(100, 50 * (c.timeframes.length - 1)) };
    return { ...p, confluenceIds: [c.id], score: finalizeLiquidityScore(components, p.state) };
  });
  return { instrumentId, byTimeframe, pools, clusters };
}

/** Nearest open BSL above and SSL below a price (context only — never a signal). */
export function nearestLiquidity(pools: readonly LiquidityPool[], price: number | null): { above: LiquidityPool | null; below: LiquidityPool | null } {
  if (price === null) return { above: null, below: null };
  let above: LiquidityPool | null = null;
  let below: LiquidityPool | null = null;
  for (const p of pools) {
    if (!isOpenLiquidity(p)) continue;
    if (p.side === 'BSL' && p.level > price && (!above || p.level < above.level || (p.level === above.level && p.score.total > above.score.total))) above = p;
    if (p.side === 'SSL' && p.level < price && (!below || p.level > below.level || (p.level === below.level && p.score.total > below.score.total))) below = p;
  }
  return { above, below };
}
