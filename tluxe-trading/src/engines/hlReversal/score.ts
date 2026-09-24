import { HLR_SCORE_WEIGHTS, type HLRSettings } from './config';
import type { H4State, HLRScore, HLRScoreKey, Setup } from './types';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Raw 0–100 components (documented; every one is exposed in the UI):
 *  htfAlignment    H4 (at the sweep, else current): aligned 100 · neutral 50 · counter-trend 25 · insufficient 0
 *  liquiditySweep  no sweep 0; else 50·min(1, penetration / 0.25 ATR) + 30·significance/100 + 20·min(1, equals/2)
 *  reclaim         none 0; else max(40, 100 − 15 × (bars to reclaim − 1))
 *  m5Structure     CHOCH 100 · BOS 80 · none 0
 *  displacement    none 0; else 100 × min(1, leg ATR / 4)
 *  entryQuality    OB+FVG 100 · OB 80 · FVG 60 · none 0
 *  riskReward      none 0; else 100 × min(1, R:R to TP1 / 3)
 *  freshness       remaining share of the current stage window; finished states 0 (TRIGGERED 100)
 * total = round(Σ weight × component / 100). The score is descriptive and NEVER gates a state.
 */
export function hlrScoreComponents(s: Setup, h4Now: H4State, levelAgeBars: number, st: HLRSettings): Record<HLRScoreKey, number> {
  const h4 = s.h4AtSweep ?? h4Now;
  const aligned = (s.direction === 'BUY' && h4 === 'BULLISH') || (s.direction === 'SELL' && h4 === 'BEARISH');
  const htfAlignment = h4 === 'INSUFFICIENT_DATA' ? 0 : aligned ? 100 : h4 === 'NEUTRAL' ? 50 : 25;
  const liquiditySweep = s.sweep ? 50 * clamp01(s.sweep.penetrationAtr / 0.25) + 30 * (s.levelSignificance / 100) + 20 * clamp01(s.levelEquals / 2) : 0;
  const reclaim = s.reclaim ? Math.max(40, 100 - 15 * (s.reclaim.bars - 1)) : 0;
  const m5Structure = s.m5 ? (s.m5.kind === 'CHOCH' ? 100 : 80) : 0;
  const displacement = s.m5 ? 100 * clamp01(s.m5.displacement.legAtr / 4) : 0;
  const entryQuality = s.zone ? (s.zone.source === 'OB+FVG' ? 100 : s.zone.source === 'OB' ? 80 : 60) : 0;
  const riskReward = s.risk ? 100 * clamp01(s.risk.rr1 / 3) : 0;
  const window =
    s.state === 'WATCHING_LEVEL'
      ? { used: levelAgeBars, of: st.levelExpiryBars }
      : s.state === 'LIQUIDITY_TAKEN'
        ? { used: s.stageBars, of: st.reclaimWindowBars }
        : s.state === 'RECLAIMED' || s.state === 'M5_CONFIRMATION_PENDING'
          ? { used: s.stageBars, of: st.m5WindowBars }
          : s.state === 'M5_CONFIRMED' || s.state === 'M1_PULLBACK_PENDING'
            ? { used: s.stageBars, of: st.m1PullbackWindowBars }
            : s.state === 'ENTRY_READY'
              ? { used: s.stageBars, of: st.m1TriggerWindowBars }
              : null;
  const freshness = s.state === 'TRIGGERED' ? 100 : window ? 100 * clamp01(1 - window.used / window.of) : 0;
  return { htfAlignment, liquiditySweep, reclaim, m5Structure, displacement, entryQuality, riskReward, freshness };
}

export function finalizeHLRScore(components: Record<HLRScoreKey, number>): HLRScore {
  const keys = Object.keys(HLR_SCORE_WEIGHTS) as HLRScoreKey[];
  const contributions = {} as Record<HLRScoreKey, number>;
  let sum = 0;
  for (const k of keys) {
    contributions[k] = (HLR_SCORE_WEIGHTS[k] * components[k]) / 100;
    sum += contributions[k];
  }
  return { components, weights: HLR_SCORE_WEIGHTS, contributions, total: Math.round(sum) };
}
