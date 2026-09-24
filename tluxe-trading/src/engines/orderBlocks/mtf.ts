import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import { OB_TF_RANK, type OBSettings } from './config';
import { finalizeOBScore } from './score';
import type { OBConfluence, OBMultiSnapshot, OBSnapshot, OrderBlock } from './types';

/** Blocks that still describe live structure (candidates for confluence and "nearest"). */
export const isLiveBlock = (b: OrderBlock) => b.state === 'FRESH' || b.state === 'ACTIVE' || b.state === 'TESTED';

/**
 * Multi-timeframe Order Block confluence. Every timeframe detects its own blocks
 * from its own candles first; this only compares those detections. No block is
 * ever created from, or copied onto, another timeframe.
 *
 *  - Eligible: FRESH / ACTIVE / TESTED. Anchors: higher timeframe, higher score, id.
 *  - For each other timeframe (high → low) the same-type block whose zone overlaps
 *    the anchor zone the most joins (ties: higher score, id). A block joins one result.
 *  - ≥ 2 timeframes → a SEPARATE confluence result: overlap = intersection of the
 *    member zones, score = min(100, round(max member score + 5 × (timeframes − 1))).
 *  - The per-timeframe snapshots are never modified; the merged block list carries
 *    confluence 50 × (timeframes − 1) (max 100) in its own score copy.
 */
export function buildOBMulti(instrumentId: InstrumentId, byTimeframe: Partial<Record<Timeframe, OBSnapshot>>, _s: OBSettings): OBMultiSnapshot {
  const all = Object.values(byTimeframe)
    .filter((s): s is OBSnapshot => !!s && s.state === 'READY' && s.instrumentId === instrumentId)
    .flatMap((s) => s.blocks);
  const eligible = all
    .filter(isLiveBlock)
    .sort((a, b) => OB_TF_RANK[b.timeframe] - OB_TF_RANK[a.timeframe] || b.score.total - a.score.total || (a.id < b.id ? -1 : 1));
  const tfs = [...new Set(eligible.map((b) => b.timeframe))].sort((a, b) => OB_TF_RANK[b] - OB_TF_RANK[a]);
  const used = new Set<string>();
  const confluences: OBConfluence[] = [];
  for (const anchor of eligible) {
    if (used.has(anchor.id)) continue;
    const members = [anchor];
    let lo = anchor.low;
    let hi = anchor.high;
    for (const tf of tfs) {
      if (tf === anchor.timeframe) continue;
      let pick: OrderBlock | null = null;
      let pickOv = 0;
      for (const b of eligible) {
        if (b.timeframe !== tf || b.type !== anchor.type || used.has(b.id)) continue;
        const ov = Math.min(hi, b.high) - Math.max(lo, b.low);
        if (ov <= 0) continue;
        if (!pick || ov > pickOv || (ov === pickOv && (b.score.total > pick.score.total || (b.score.total === pick.score.total && b.id < pick.id)))) {
          pick = b;
          pickOv = ov;
        }
      }
      if (pick) {
        members.push(pick);
        lo = Math.max(lo, pick.low);
        hi = Math.min(hi, pick.high);
      }
    }
    if (members.length < 2) continue;
    members.forEach((m) => used.add(m.id));
    confluences.push({
      id: `${instrumentId}:OBCF:${anchor.type === 'bullish' ? 'BULL' : 'BEAR'}:${members.map((m) => m.id).join('+')}`,
      type: anchor.type,
      blockIds: members.map((m) => m.id),
      timeframes: members.map((m) => m.timeframe),
      low: lo,
      high: hi,
      score: Math.min(100, Math.round(Math.max(...members.map((m) => m.score.total)) + 5 * (members.length - 1))),
    });
  }
  const byBlock = new Map<string, OBConfluence>();
  confluences.forEach((c) => c.blockIds.forEach((id) => byBlock.set(id, c)));
  const blocks = all.map((b) => {
    const c = byBlock.get(b.id);
    if (!c) return b;
    return { ...b, confluenceIds: [c.id], score: finalizeOBScore({ ...b.score.components, confluence: Math.min(100, 50 * (c.timeframes.length - 1)) }) };
  });
  return { instrumentId, byTimeframe, blocks, confluences };
}

/** Nearest live bullish block below / bearish block above a price (context only). */
export function nearestBlocks(blocks: readonly OrderBlock[], price: number | null): { above: OrderBlock | null; below: OrderBlock | null } {
  if (price === null) return { above: null, below: null };
  let above: OrderBlock | null = null;
  let below: OrderBlock | null = null;
  for (const b of blocks) {
    if (!isLiveBlock(b)) continue;
    if (b.low > price && (!above || b.low < above.low)) above = b;
    if (b.high < price && (!below || b.high > below.high)) below = b;
  }
  return { above, below };
}
