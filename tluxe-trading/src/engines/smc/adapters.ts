import type { LiquiditySnapshot } from '../liquidity/types';
import type { OBSnapshot } from '../orderBlocks/types';
import type { SmcBreak, SmcLiquidityView, SmcOrderBlockView, SmcSweepView } from './types';

/*
 * READ-ONLY adapters: SMC consumes the public snapshots of the UNCHANGED Order Block and Liquidity
 * engines (its own instances, fed the same closed candles). Nothing here detects blocks, pools or
 * sweeps — it only maps their output to SMC's vocabulary. The source engines are never mutated.
 */

const LIVE_OB = new Set(['FRESH', 'ACTIVE', 'TESTED']);

export function orderBlockViews(s: OBSnapshot): SmcOrderBlockView[] {
  return s.blocks.map((b) => ({
    id: b.id,
    timeframe: b.timeframe,
    direction: b.type,
    low: b.low,
    high: b.high,
    mid: b.mid,
    state: b.state,
    fresh: b.state === 'FRESH',
    live: LIVE_OB.has(b.state),
    mitigationPct: b.mitigationPct,
    mitigatedAt: b.mitigatedAt,
    firstTestAt: b.firstTestAt,
    originTime: b.originTime,
    confirmedAt: b.confirmedAt,
    breakKind: b.breakKind,
    score: b.score.total,
    evidence: `Order Block engine: ${b.breakKind} through ${b.brokenLevel}; displacement ${b.displacement.legAtr.toFixed(2)} ATR; ${b.hasImbalance ? 'with imbalance' : 'no imbalance'}; mitigation ${Math.round(b.mitigationPct)}%; OB score ${b.score.total}`,
  }));
}

export function liquidityViews(s: LiquiditySnapshot): SmcLiquidityView[] {
  return s.pools
    .filter((p) => p.state !== 'FORMING' && p.state !== 'INVALIDATED')
    .map((p) => ({
      id: p.id,
      timeframe: p.timeframe,
      side: p.side,
      kind: p.source === 'equal' ? (p.side === 'BSL' ? 'EQH' : 'EQL') : p.side,
      level: p.level,
      poolState: p.state,
      status: p.state === 'SWEPT' ? 'LIQUIDITY SWEPT' : p.state === 'CONSUMED' ? 'LIQUIDITY CONSUMED' : 'LIQUIDITY PRESENT',
      confirmedAt: p.confirmedAt,
      lastSweepAt: p.sweeps.length ? p.sweeps[p.sweeps.length - 1]!.time : null,
      score: p.score.total,
      touches: p.tests.length,
    }));
}

/**
 * Sweeps as the Liquidity engine recorded them. A sweep is NOT a reversal: `reversalBreakId` is set
 * only when SMC later confirmed a CHOCH against the swept side (SSL swept → bullish CHOCH,
 * BSL swept → bearish CHOCH) as the FIRST structural break after the sweep, within `windowSec` —
 * CONFIRMED STRUCTURAL REVERSAL. A continuation break first means no reversal.
 */
export function sweepViews(s: LiquiditySnapshot, breaks: readonly SmcBreak[], windowSec: number): SmcSweepView[] {
  const out: SmcSweepView[] = [];
  for (const p of s.pools)
    for (const w of p.sweeps) {
      const dir = w.side === 'SSL' ? 'bullish' : 'bearish';
      const next = breaks.find((b) => b.confirmedAt >= w.time && b.confirmedAt <= w.time + windowSec);
      const rev = next && next.kind === 'CHOCH' && next.direction === dir ? next : null;
      out.push({
        id: w.id,
        timeframe: p.timeframe,
        poolId: p.id,
        side: w.side,
        time: w.time,
        level: w.level,
        extreme: w.extremePrice,
        penetrationAtr: w.penetrationAtr,
        kind: w.kind,
        outcome: w.outcome,
        reclaimed: w.reclaimed,
        reversalBreakId: rev?.id ?? null,
      });
    }
  return out.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
}
