import type { Timeframe } from '../../types/market';
import {
  CLOSE_THROUGH_PENALTY,
  FRESHNESS_AGE_WEIGHT,
  PENETRATION_WEIGHT,
  SCORE_WEIGHTS,
  STRUCTURE_CLUSTER_FULL,
  STRUCTURE_CLUSTER_SHARE,
  STRUCTURE_PROMINENCE_SHARE,
  TIMEFRAME_SIGNIFICANCE,
  UNTESTED_TOUCH_QUALITY,
  type SRSettings,
} from './settings';
import type { Interaction, ScoreBreakdown, ScoreComponentKey, ScoreComponents, ZoneStatus } from './types';

/** Multiplier applied after weighting: degraded / invalidated zones score lower. */
export const STATUS_FACTOR: Readonly<Record<ZoneStatus, number>> = Object.freeze({
  FRESH: 1,
  ACTIVE: 1,
  TESTED: 1,
  WEAKENING: 0.8,
  FLIPPED: 0.9,
  BROKEN: 0.3,
  EXPIRED: 0.2,
});

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

export interface ScoreInputs {
  timeframe: Timeframe;
  status: ZoneStatus;
  interactions: readonly Interaction[];
  /** Formation excursion (ATR) of every contributing pivot. */
  formationExcursionsAtr: readonly number[];
  /** Prominence (ATR) of the originating pivot. */
  prominenceAtr: number;
  sourcePivotCount: number;
  barsSinceLastInteraction: number;
  /** 0–100, supplied by multi-timeframe confluence (0 when evaluated alone). */
  confluence: number;
}

/**
 * Each component is 0–100:
 * - timeframe:    TIMEFRAME_SIGNIFICANCE[tf]
 * - reaction:     100 × min(1, mean(reaction ATRs) / reactionFullAtr) — reactions = every
 *                 contributing pivot's formation excursion + every resolved interaction's
 *                 move away (failed touches pull the mean down)
 * - touchQuality: 50 if never resolved; else 100 × rejections/resolved × (1 − 0.5 × mean
 *                 penetration ratio, capped 1) − 15 × close-throughs
 * - freshness:    100 × freshnessDecay^resolved × (1 − 0.5 × min(1, barsSinceLast / expiryBars))
 * - structure:    100 × (0.6 × min(1, prominence / structureFullAtr) + 0.4 × min(1, (pivots − 1) / 2))
 * - confluence:   from MTF (50 per additional timeframe, max 100)
 * More touches never raise the score by themselves: they lower freshness and
 * only help touch quality if they were genuine rejections.
 */
export function scoreComponents(input: ScoreInputs, s: SRSettings): ScoreComponents {
  const resolved = input.interactions.filter((i) => i.rejected !== null || i.broke);
  const rejections = resolved.filter((i) => i.rejected === true && !i.broke).length;
  const closeThroughs = input.interactions.filter((i) => i.closedThrough).length;

  const reactions = [...input.formationExcursionsAtr, ...resolved.map((i) => i.rejectionAtr)];
  const meanReaction = reactions.length ? reactions.reduce((a, b) => a + b, 0) / reactions.length : 0;
  const reaction = 100 * Math.min(1, meanReaction / s.reactionFullAtr);

  let touchQuality = UNTESTED_TOUCH_QUALITY;
  if (resolved.length > 0) {
    const meanPen = resolved.reduce((a, i) => a + Math.min(1, i.penetrationRatio), 0) / resolved.length;
    touchQuality = 100 * (rejections / resolved.length) * (1 - PENETRATION_WEIGHT * meanPen) - CLOSE_THROUGH_PENALTY * closeThroughs;
  }

  const age = Math.min(1, input.barsSinceLastInteraction / s.expiryBars);
  const freshness = 100 * Math.pow(s.freshnessDecay, resolved.length) * (1 - FRESHNESS_AGE_WEIGHT * age);

  const structure =
    100 *
    (STRUCTURE_PROMINENCE_SHARE * Math.min(1, input.prominenceAtr / s.structureFullAtr) +
      STRUCTURE_CLUSTER_SHARE * Math.min(1, (input.sourcePivotCount - 1) / STRUCTURE_CLUSTER_FULL));

  return {
    timeframe: TIMEFRAME_SIGNIFICANCE[input.timeframe],
    reaction: round1(clamp(reaction)),
    touchQuality: round1(clamp(touchQuality)),
    freshness: round1(clamp(freshness)),
    structure: round1(clamp(structure)),
    confluence: round1(clamp(input.confluence)),
  };
}

/** total = clamp(round(Σ weight × component × statusFactor), 0, 100) */
export function finalizeScore(components: ScoreComponents, status: ZoneStatus): ScoreBreakdown {
  const weighted = (Object.keys(SCORE_WEIGHTS) as ScoreComponentKey[]).reduce((sum, k) => sum + SCORE_WEIGHTS[k] * components[k], 0);
  const statusFactor = STATUS_FACTOR[status];
  return {
    components,
    weights: SCORE_WEIGHTS,
    weighted: round1(weighted),
    statusFactor,
    total: Math.round(clamp(weighted * statusFactor)),
  };
}
