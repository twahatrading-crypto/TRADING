import { HLE_SCORE_WEIGHTS } from './config';
import type { HLEScore, HLEScoreKey, Setup } from './types';

const c01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/**
 * Setup Score (handoff §10) — each component a 0..1 fraction of its maximum:
 *  htf     (H4 dir = trade ? 0.6 : H4 0 ? 0.3 : 0) + (H1 dir = trade ? 0.4 : H1 0 ? 0.2 : 0)
 *  level   the level's rating score (§4.6)
 *  sweep   min(1, penetration ATR / 0.75) × 0.6 + (reclaimed ? 0.4 : 0)
 *  reject  clamp(wick / 0.45) × 0.5 + (M5 break ? clamp(body ATR / 1.00) × 0.5 : 0)
 *  m5      (CHOCH 0.60 · BOS 0.45) + (displaced ? 0.40 : 0); none 0
 *  m1      pullback ? 0.6 + (R:R1 ? clamp((R:R1 − 1) / 2) × 0.4 : 0) : 0
 *  conf    zone ? (M1 FVG ? 0.6 : 0) + (M1 OB ? 0.4 : 0) : 0
 * points = round(fraction × max); total = Σ points. A missing stage scores zero (never skipped).
 * Descriptive only: nothing in the engine reads it.
 */
export function hleScoreFractions(s: Setup, o: { h4Dir: number; h1Dir: number; levelRating: number; fvg: boolean; ob: boolean }): Record<HLEScoreKey, number> {
  const dir = s.side === 'BUY' ? 1 : -1;
  const ctx = s.context;
  const h4 = ctx ? ctx.h4Dir : o.h4Dir;
  const h1 = ctx ? ctx.h1Dir : o.h1Dir;
  const sw = s.sweep;
  const m5 = s.m5;
  return {
    htfAlignment: c01((h4 === dir ? 0.6 : h4 === 0 ? 0.3 : 0) + (h1 === dir ? 0.4 : h1 === 0 ? 0.2 : 0)),
    levelImportance: c01(o.levelRating),
    sweepQuality: c01(Math.min(1, sw.penetrationAtr / 0.75) * 0.6 + (s.reclaim ? 0.4 : 0)),
    rejectionDisplacement: c01(c01(sw.wick / 0.45) * 0.5 + (m5 ? c01(m5.displacement.bodyAtr / 1.0) * 0.5 : 0)),
    m5Structure: m5 ? c01((m5.kind === 'CHOCH' ? 0.6 : 0.45) + (m5.displacement.displaced ? 0.4 : 0)) : 0,
    m1EntryQuality: s.entry ? c01(0.6 + (s.risk ? c01((s.risk.rr1 - 1) / 2) * 0.4 : 0)) : 0,
    fvgObConfluence: s.zone ? c01((o.fvg ? 0.6 : 0) + (o.ob ? 0.4 : 0)) : 0,
  };
}

export function finalizeHLEScore(fr: Record<HLEScoreKey, number>, frozen: boolean): HLEScore {
  const components = {} as Record<HLEScoreKey, number>;
  const contributions = {} as Record<HLEScoreKey, number>;
  let total = 0;
  for (const k of Object.keys(HLE_SCORE_WEIGHTS) as HLEScoreKey[]) {
    components[k] = Math.round(c01(fr[k]) * 100);
    contributions[k] = Math.round(c01(fr[k]) * HLE_SCORE_WEIGHTS[k]);
    total += contributions[k];
  }
  return { components, weights: HLE_SCORE_WEIGHTS, contributions, total, frozen };
}
