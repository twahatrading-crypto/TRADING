import { HLE_SCORE_WEIGHTS } from './config';
import type { Bias, HLEScore, HLEScoreKey, Setup } from './types';

const c01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Raw 0–100 components (all exposed in the UI):
 *  htfAlignment          H4 bias (at the sweep, else current): aligned 100 · neutral 50 · against 0 · insufficient 0
 *  levelImportance       level strength score (frozen at the sweep)
 *  sweepQuality          none 0; else 60·min(1, penetration / 0.25 ATR) + 40·rejection
 *  rejectionDisplacement none before reclaim; 50·rejection + 50·min(1, M5 leg ATR / 3)
 *  m5Structure           CHOCH 100 · BOS 80 · none 0
 *  m1EntryQuality        0 until ENTRY READY; then 60 + 40·min(1, R:R TP1 / 3) (60 when no TP1)
 *  fvgObConfluence       OB+FVG 100 · OB 70 · FVG 60 · reclaim band 0
 * total = round(Σ weight × component / 100). Descriptive only — the state machine never reads it.
 */
export function hleScoreComponents(s: Setup, levelScore: number, h4Now: Bias): Record<HLEScoreKey, number> {
  const h4 = s.h4AtSweep ?? h4Now;
  const aligned = (s.side === 'BUY' && h4 === 'BULLISH') || (s.side === 'SELL' && h4 === 'BEARISH');
  return {
    htfAlignment: aligned ? 100 : h4 === 'NEUTRAL' ? 50 : 0,
    levelImportance: s.sweep ? s.sweep.importanceAtSweep : levelScore,
    sweepQuality: s.sweep ? 60 * c01(s.sweep.penetrationAtr / 0.25) + 40 * c01(s.sweep.rejection) : 0,
    rejectionDisplacement: s.reclaim && s.sweep ? 50 * c01(s.sweep.rejection) + 50 * c01((s.m5?.displacement.legAtr ?? 0) / 3) : 0,
    m5Structure: s.m5 ? (s.m5.kind === 'CHOCH' ? 100 : 80) : 0,
    m1EntryQuality: s.entry ? 60 + 40 * c01((s.risk?.rr1 ?? 0) / 3) : 0,
    fvgObConfluence: s.zone ? { 'OB+FVG': 100, OB: 70, FVG: 60, RECLAIM: 0 }[s.zone.source] : 0,
  };
}

export function finalizeHLEScore(components: Record<HLEScoreKey, number>): HLEScore {
  const contributions = {} as Record<HLEScoreKey, number>;
  let sum = 0;
  for (const k of Object.keys(HLE_SCORE_WEIGHTS) as HLEScoreKey[]) {
    contributions[k] = (HLE_SCORE_WEIGHTS[k] * components[k]) / 100;
    sum += contributions[k];
  }
  return { components, weights: HLE_SCORE_WEIGHTS, contributions, total: Math.round(sum) };
}
