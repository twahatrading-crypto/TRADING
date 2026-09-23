import type { Timeframe } from '../../types/market';

/**
 * Support & Resistance engine parameters — the ONLY place engine constants live.
 *
 * Distances are expressed in ATR multiples of the zone's own timeframe so the
 * same settings work on GC, EURUSD, BTCUSD… No instrument-specific price
 * distances exist anywhere in the engine. `minZoneTicks` uses the instrument's
 * tick size as an absolute floor.
 */
export interface SRSettings {
  /** Wilder ATR period used to normalise every distance. */
  atrPeriod: number;
  /** Bars to the left a swing extreme must exceed. */
  pivotLeft: number;
  /** Bars to the right that must close before a pivot is confirmed (confirmation strength). */
  pivotRight: number;
  /** 'wickBody' = extreme→body edge, clamped; 'atr' = fixed ATR multiple from the extreme. */
  zoneWidthMethod: 'wickBody' | 'atr';
  /** Zone width in ATR when zoneWidthMethod = 'atr'. */
  zoneAtrMultiplier: number;
  /** Minimum zone width (ATR). */
  zoneMinAtr: number;
  /** Maximum zone width (ATR) for the wickBody method. */
  zoneMaxAtr: number;
  /** Absolute minimum zone width in instrument ticks. */
  minZoneTicks: number;
  /** New pivot joins an existing same-role zone if the gap between them ≤ this (ATR). */
  clusterToleranceAtr: number;
  /** Price within this distance of the zone's facing edge counts as reaching it (ATR). */
  touchToleranceAtr: number;
  /** Price must move this far beyond the facing edge to end an interaction (ATR). */
  touchSeparationAtr: number;
  /** Minimum move away from the zone to count as a rejection (ATR). */
  rejectionMinAtr: number;
  /** Bars after an interaction starts within which the rejection must occur. */
  rejectionWindowBars: number;
  /** A wick must exceed the far edge by at least this to be a sweep (ATR). */
  sweepMinAtr: number;
  /** Bars (after the sweeping wick) allowed for a close back inside to reclaim. */
  sweepReclaimBars: number;
  /** A close beyond far edge ± this is a close-through (ATR). */
  breakToleranceAtr: number;
  /** Consecutive closes beyond the tolerance that confirm a break. */
  breakConfirmCloses: number;
  /** A single close this far beyond the far edge confirms a break immediately (ATR). */
  breakDisplacementAtr: number;
  /** Bars after a break during which a retest may flip the zone's role. */
  flipWindowBars: number;
  /** Resolved interactions after which a holding zone is WEAKENING. */
  weakeningTouches: number;
  /** Bars without interaction after which a holding zone EXPIRES. */
  expiryBars: number;
  /** Freshness multiplier applied per resolved interaction (0–1). */
  freshnessDecay: number;
  /** Average reaction (ATR) that earns the full reaction score. */
  reactionFullAtr: number;
  /** Pivot prominence (ATR) that earns full structure prominence. */
  structureFullAtr: number;
  /** Two zones from different timeframes overlap meaningfully if overlap ≥ this × narrower width. */
  confluenceMinOverlap: number;
  /** Closed bars required before a timeframe reports zones. */
  minHistoryBars: number;
  /** Candle gap larger than this many bar-lengths is reported as missing data. */
  gapToleranceBars: number;
  /** Display: zones below this score are hidden in ALL TF / chart views. */
  minDisplayScore: number;
  /** Display: maximum zones drawn on the chart. */
  maxDisplayedZones: number;
  /** Analysis tab: zones within this many ATR count as "nearby". */
  nearbyAtr: number;
}

export const DEFAULT_SR_SETTINGS: Readonly<SRSettings> = Object.freeze({
  atrPeriod: 14,
  pivotLeft: 3,
  pivotRight: 3,
  zoneWidthMethod: 'wickBody',
  zoneAtrMultiplier: 0.35,
  zoneMinAtr: 0.1,
  zoneMaxAtr: 0.75,
  minZoneTicks: 2,
  clusterToleranceAtr: 0.25,
  touchToleranceAtr: 0.05,
  touchSeparationAtr: 0.5,
  rejectionMinAtr: 1.0,
  rejectionWindowBars: 12,
  sweepMinAtr: 0.05,
  sweepReclaimBars: 2,
  breakToleranceAtr: 0.1,
  breakConfirmCloses: 2,
  breakDisplacementAtr: 1.0,
  flipWindowBars: 120,
  weakeningTouches: 3,
  expiryBars: 400,
  freshnessDecay: 0.8,
  reactionFullAtr: 3,
  structureFullAtr: 2,
  confluenceMinOverlap: 0.3,
  minHistoryBars: 50,
  gapToleranceBars: 1.5,
  minDisplayScore: 40,
  maxDisplayedZones: 12,
  nearbyAtr: 3,
});

type NumericKey = { [K in keyof SRSettings]: SRSettings[K] extends number ? K : never }[keyof SRSettings];

export interface SettingSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  group: 'Structure' | 'Zones' | 'Interactions' | 'Breaks' | 'Lifecycle' | 'Display';
  help: string;
}

/** Bounds + labels for every numeric setting (used to sanitise input and by the Settings tab). */
export const SR_SETTING_SPECS: Record<NumericKey, SettingSpec> = {
  atrPeriod: { label: 'ATR period', min: 5, max: 50, step: 1, group: 'Structure', help: 'Volatility window used to normalise every distance.' },
  pivotLeft: { label: 'Pivot left bars', min: 1, max: 10, step: 1, group: 'Structure', help: 'Bars before a swing that it must exceed.' },
  pivotRight: { label: 'Pivot confirmation bars', min: 1, max: 10, step: 1, group: 'Structure', help: 'Closed bars after a swing required to confirm it.' },
  zoneAtrMultiplier: { label: 'Zone width (ATR method)', min: 0.1, max: 1.5, step: 0.05, group: 'Zones', help: 'Zone width when the ATR method is selected.' },
  zoneMinAtr: { label: 'Min zone width (ATR)', min: 0.02, max: 0.5, step: 0.01, group: 'Zones', help: 'Narrowest allowed zone.' },
  zoneMaxAtr: { label: 'Max zone width (ATR)', min: 0.2, max: 2, step: 0.05, group: 'Zones', help: 'Widest allowed zone (wick/body method).' },
  minZoneTicks: { label: 'Min zone width (ticks)', min: 1, max: 20, step: 1, group: 'Zones', help: 'Absolute floor in instrument ticks.' },
  clusterToleranceAtr: { label: 'Clustering tolerance (ATR)', min: 0, max: 1, step: 0.05, group: 'Zones', help: 'Gap within which a new pivot joins an existing zone.' },
  touchToleranceAtr: { label: 'Touch tolerance (ATR)', min: 0, max: 0.5, step: 0.01, group: 'Interactions', help: 'How close counts as reaching the zone.' },
  touchSeparationAtr: { label: 'Touch separation (ATR)', min: 0.1, max: 2, step: 0.05, group: 'Interactions', help: 'Distance price must leave before a new touch can count.' },
  rejectionMinAtr: { label: 'Rejection size (ATR)', min: 0.25, max: 5, step: 0.05, group: 'Interactions', help: 'Move away needed to count as a rejection.' },
  rejectionWindowBars: { label: 'Rejection window (bars)', min: 2, max: 60, step: 1, group: 'Interactions', help: 'Bars allowed for the rejection to happen.' },
  sweepMinAtr: { label: 'Sweep depth (ATR)', min: 0, max: 1, step: 0.01, group: 'Interactions', help: 'Wick beyond the zone needed for a sweep.' },
  sweepReclaimBars: { label: 'Sweep reclaim (bars)', min: 0, max: 10, step: 1, group: 'Interactions', help: 'Bars allowed to close back inside after a sweep.' },
  breakToleranceAtr: { label: 'Break tolerance (ATR)', min: 0, max: 1, step: 0.01, group: 'Breaks', help: 'Close beyond the zone by more than this is a close-through.' },
  breakConfirmCloses: { label: 'Break confirmation closes', min: 1, max: 5, step: 1, group: 'Breaks', help: 'Consecutive closes beyond that confirm a break.' },
  breakDisplacementAtr: { label: 'Displacement break (ATR)', min: 0.25, max: 5, step: 0.05, group: 'Breaks', help: 'One close this far beyond confirms a break.' },
  flipWindowBars: { label: 'Flip window (bars)', min: 10, max: 500, step: 5, group: 'Breaks', help: 'Bars after a break in which a retest can flip the role.' },
  weakeningTouches: { label: 'Weakening after touches', min: 2, max: 10, step: 1, group: 'Lifecycle', help: 'Resolved touches after which a zone is weakening.' },
  expiryBars: { label: 'Expiry (bars)', min: 50, max: 2000, step: 10, group: 'Lifecycle', help: 'Bars without interaction before a zone expires.' },
  freshnessDecay: { label: 'Freshness decay per touch', min: 0.3, max: 1, step: 0.05, group: 'Lifecycle', help: 'Freshness multiplier per resolved touch.' },
  reactionFullAtr: { label: 'Full reaction (ATR)', min: 1, max: 10, step: 0.25, group: 'Lifecycle', help: 'Average reaction that scores 100.' },
  structureFullAtr: { label: 'Full prominence (ATR)', min: 0.5, max: 6, step: 0.25, group: 'Lifecycle', help: 'Swing prominence that scores 100.' },
  confluenceMinOverlap: { label: 'MTF overlap required', min: 0.05, max: 1, step: 0.05, group: 'Lifecycle', help: 'Overlap (fraction of the narrower zone) for confluence.' },
  minHistoryBars: { label: 'Minimum history (bars)', min: 20, max: 500, step: 5, group: 'Lifecycle', help: 'Closed bars needed before zones are reported.' },
  gapToleranceBars: { label: 'Gap tolerance (bars)', min: 1, max: 10, step: 0.5, group: 'Lifecycle', help: 'Candle gaps above this are reported as missing data.' },
  minDisplayScore: { label: 'Minimum display score', min: 0, max: 100, step: 1, group: 'Display', help: 'Hide weaker zones on the chart / ALL TF.' },
  maxDisplayedZones: { label: 'Maximum displayed zones', min: 1, max: 40, step: 1, group: 'Display', help: 'Cap on zones drawn on the chart.' },
  nearbyAtr: { label: 'Nearby distance (ATR)', min: 0.5, max: 20, step: 0.5, group: 'Display', help: 'Distance counted as “nearby” in Analysis.' },
};

/** Clamp every field into its documented range; unknown/invalid input falls back to defaults. */
export function sanitizeSettings(input: Partial<SRSettings> | null | undefined): SRSettings {
  const out: SRSettings = { ...DEFAULT_SR_SETTINGS };
  if (!input || typeof input !== 'object') return out;
  for (const [key, spec] of Object.entries(SR_SETTING_SPECS) as [NumericKey, SettingSpec][]) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const clamped = Math.min(spec.max, Math.max(spec.min, v));
      out[key] = (spec.step >= 1 ? Math.round(clamped) : clamped) as never;
    }
  }
  if (input.zoneWidthMethod === 'atr' || input.zoneWidthMethod === 'wickBody') out.zoneWidthMethod = input.zoneWidthMethod;
  if (out.zoneMaxAtr < out.zoneMinAtr) out.zoneMaxAtr = out.zoneMinAtr;
  return out;
}

/** Stable key identifying a settings set (snapshots record which settings produced them). */
export function settingsKey(s: SRSettings): string {
  return (Object.keys(DEFAULT_SR_SETTINGS) as (keyof SRSettings)[]).map((k) => `${k}=${s[k]}`).join(';');
}

/* ------------------------------ Scoring constants ------------------------------ */

/** Final score = Σ weight × component (each 0–100), then × status factor, clamped 0–100. */
export const SCORE_WEIGHTS = Object.freeze({
  timeframe: 0.2,
  reaction: 0.25,
  touchQuality: 0.15,
  freshness: 0.15,
  structure: 0.15,
  confluence: 0.1,
});

/** Timeframe significance component (0–100). */
export const TIMEFRAME_SIGNIFICANCE: Readonly<Record<Timeframe, number>> = Object.freeze({
  M1: 20,
  M5: 35,
  M15: 50,
  M30: 60,
  H1: 70,
  H4: 85,
  D1: 100,
});

/** Timeframe order (low → high) used for confluence anchoring. */
export const TIMEFRAME_RANK: Readonly<Record<Timeframe, number>> = Object.freeze({ M1: 1, M5: 2, M15: 3, M30: 4, H1: 5, H4: 6, D1: 7 });

export const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> = Object.freeze({
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
});

/** Untested zones have no evidence either way; touch quality starts neutral. */
export const UNTESTED_TOUCH_QUALITY = 50;
/** Touch-quality penalty per close-through (failed breakdown/breakout). */
export const CLOSE_THROUGH_PENALTY = 15;
/** Share of freshness lost as bars-since-last-interaction approaches expiry. */
export const FRESHNESS_AGE_WEIGHT = 0.5;
/** Structure = prominence share + cluster share (confirming pivots beyond the first, up to 2). */
export const STRUCTURE_PROMINENCE_SHARE = 0.6;
export const STRUCTURE_CLUSTER_SHARE = 0.4;
export const STRUCTURE_CLUSTER_FULL = 2;
/** Confluence component = CONFLUENCE_PER_EXTRA_TF × (participating timeframes − 1), max 100. */
export const CONFLUENCE_PER_EXTRA_TF = 50;
/** Combined confluence score = mean member score + bonus × (timeframes − 1), max 100. */
export const CONFLUENCE_TF_BONUS = 10;
/** Penetration beyond this share of the zone width counts as deep in touch quality. */
export const PENETRATION_WEIGHT = 0.5;

/* ------------------------------ Display constants ----------------------------- */

/** ALL TF / chart ranking: displayRank = score − PROXIMITY_PENALTY × min(distanceAtr, PROXIMITY_CAP_ATR). */
export const DISPLAY_PROXIMITY_PENALTY = 4;
export const DISPLAY_PROXIMITY_CAP_ATR = 10;
/** A lower-ranked zone overlapping a shown same-role zone by ≥ this share of its width is not drawn. */
export const DISPLAY_MAX_OVERLAP = 0.6;
