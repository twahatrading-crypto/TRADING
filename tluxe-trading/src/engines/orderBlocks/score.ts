import type { Timeframe } from '../../types/market';
import { OB_DISPLACEMENT_FULL_ATR, OB_SCORE_WEIGHTS, OB_TF_WEIGHT, type OBSettings } from './config';
import type { BreakKind, OBScore, OBScoreComponents, OBScoreKey, OBState } from './types';

export interface OBScoreInputs {
  timeframe: Timeframe;
  state: OBState;
  legAtr: number;
  breakKind: BreakKind;
  /** Origin candle body ÷ range (0–1): a decisive origin candle is cleaner. */
  originBodyRatio: number;
  ageBars: number;
  tests: number;
  mitigationPct: number;
  hasImbalance: boolean;
  /** 0–100 from MTF overlap (0 when evaluated alone). */
  confluence: number;
}

const c100 = (v: number) => Math.min(100, Math.max(0, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Order Block strength (0–100). Descriptive strength — NOT a probability of profit.
 * Components (0–100) and weights (%, total exactly 100):
 *  timeframe     15  OB_TF_WEIGHT[tf] (M1 20 … D1 100)
 *  displacement  20  100 × min(1, leg ATR / 4)
 *  structure     20  CHOCH 100 · BOS 80
 *  origin        15  100 × origin body ÷ origin range
 *  freshness     10  100 × (1 − min(1, age / expiryBars))  (expiry 0 → age / 500)
 *  mitigation    10  untested 100; else max(0, 100 − 20 × tests − 0.5 × mitigation %); INVALIDATED / EXPIRED 0
 *  imbalance      5  100 if a fair-value gap exists inside the displacement leg, else 0
 *  confluence     5  50 per additional independently detected overlapping timeframe (max 100)
 * total = round(Σ weight × component / 100). No other adjustment exists.
 */
export function obScoreComponents(i: OBScoreInputs, s: OBSettings): OBScoreComponents {
  const ended = i.state === 'INVALIDATED' || i.state === 'EXPIRED';
  return {
    timeframe: OB_TF_WEIGHT[i.timeframe],
    displacement: r1(c100((100 * i.legAtr) / OB_DISPLACEMENT_FULL_ATR)),
    structure: i.breakKind === 'CHOCH' ? 100 : 80,
    origin: r1(c100(100 * i.originBodyRatio)),
    freshness: r1(c100(100 * (1 - Math.min(1, i.ageBars / (s.expiryBars || 500))))),
    mitigation: ended ? 0 : i.tests === 0 ? 100 : r1(c100(100 - 20 * i.tests - 0.5 * i.mitigationPct)),
    imbalance: i.hasImbalance ? 100 : 0,
    confluence: r1(c100(i.confluence)),
  };
}

export function finalizeOBScore(components: OBScoreComponents): OBScore {
  const keys = Object.keys(OB_SCORE_WEIGHTS) as OBScoreKey[];
  const contributions = Object.fromEntries(keys.map((k) => [k, r1((OB_SCORE_WEIGHTS[k] * components[k]) / 100)])) as OBScoreComponents;
  const raw = keys.reduce((a, k) => a + (OB_SCORE_WEIGHTS[k] * components[k]) / 100, 0);
  return { components, weights: OB_SCORE_WEIGHTS, contributions, total: Math.round(c100(raw)) };
}
