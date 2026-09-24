import type { Timeframe } from '../../types/market';
import {
  DISPLACEMENT_FULL_ATR,
  EQUAL_LEVELS_SCORE,
  LIQUIDITY_SCORE_WEIGHTS,
  LIQUIDITY_TF_WEIGHT,
  SIGNIFICANCE_FULL_ATR,
  STATE_FACTOR,
  type LiquiditySettings,
} from './config';
import type { LiquidityScore, LiquidityScoreComponents, LiquidityScoreKey, PoolState } from './types';

export interface LiquidityScoreInputs {
  timeframe: Timeframe;
  state: PoolState;
  /** Contributing highs/lows (1 = single swing, 2+ = EQH/EQL). */
  contributions: number;
  /** Largest prominence (ATR) among the contributing swings. */
  prominenceAtr: number;
  /** Largest displacement away (ATR): formation displacement or the move that qualified the pool. */
  displacementAtr: number;
  tests: number;
  barsSinceConfirmation: number;
  /** 0–100 from multi-timeframe clustering (0 when evaluated alone). */
  confluence: number;
}

const clamp = (v: number) => Math.min(100, Math.max(0, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Liquidity Strength (0–100) — its own formula, independent of S&R. Components (0–100):
 *  timeframe     LIQUIDITY_TF_WEIGHT[tf]                    (M1 20 … D1 100)
 *  equalLevels   1 → 0, 2 → 60, 3 → 85, ≥4 → 100             (more equal highs/lows = more resting orders)
 *  significance  100 × min(1, prominence / 3 ATR)            (size of the leg into the swing)
 *  displacement  100 × min(1, displacement / 3 ATR)          (how decisively price left the level)
 *  tests         min(100, 40 + 20 × tests)                   (re-approaches that did not take it)
 *  freshness     100 × (1 − min(1, bars since confirmation / freshnessBars))
 *  confluence    50 per additional timeframe, max 100        (from multi-timeframe clustering)
 * total = round(clamp(Σ weight × component × STATE_FACTOR[state]))
 * Deterministic arithmetic only — no AI, no probability claims.
 */
export function liquidityScoreComponents(i: LiquidityScoreInputs, s: LiquiditySettings): LiquidityScoreComponents {
  return {
    timeframe: LIQUIDITY_TF_WEIGHT[i.timeframe],
    equalLevels: EQUAL_LEVELS_SCORE[Math.min(EQUAL_LEVELS_SCORE.length - 1, i.contributions)]!,
    significance: r1(clamp((100 * i.prominenceAtr) / SIGNIFICANCE_FULL_ATR)),
    displacement: r1(clamp((100 * i.displacementAtr) / DISPLACEMENT_FULL_ATR)),
    tests: clamp(40 + 20 * i.tests),
    freshness: r1(clamp(100 * (1 - Math.min(1, i.barsSinceConfirmation / s.freshnessBars)))),
    confluence: r1(clamp(i.confluence)),
  };
}

export function finalizeLiquidityScore(components: LiquidityScoreComponents, state: PoolState): LiquidityScore {
  const weighted = (Object.keys(LIQUIDITY_SCORE_WEIGHTS) as LiquidityScoreKey[]).reduce((a, k) => a + LIQUIDITY_SCORE_WEIGHTS[k] * components[k], 0);
  const stateFactor = STATE_FACTOR[state];
  return { components, weights: LIQUIDITY_SCORE_WEIGHTS, weighted: r1(weighted), stateFactor, total: Math.round(clamp(weighted * stateFactor)) };
}
