import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import type { SCORE_WEIGHTS } from './settings';

export type SRZoneType = 'support' | 'resistance';

/** Every status the engine can produce. Components must not invent others. */
export type ZoneStatus = 'FRESH' | 'ACTIVE' | 'TESTED' | 'WEAKENING' | 'BROKEN' | 'FLIPPED' | 'EXPIRED';

export const ZONE_STATUSES: readonly ZoneStatus[] = ['FRESH', 'ACTIVE', 'TESTED', 'WEAKENING', 'BROKEN', 'FLIPPED', 'EXPIRED'];

/** A confirmed swing high/low. Only created once `pivotRight` later bars have closed. */
export interface Pivot {
  id: string;
  kind: 'high' | 'low';
  index: number;
  /** Open time (epoch s) of the swing bar. */
  pivotTime: number;
  price: number;
  /** Open time of the bar whose close confirmed the pivot. */
  confirmedAt: number;
  confirmedIndex: number;
  /** ATR at confirmation (the value every distance for this pivot uses). */
  atr: number;
  /** Size of the leg into the pivot over `pivotLeft` bars, in ATR. */
  prominenceAtr: number;
  /** Furthest CLOSE away from the extreme during the confirmation bars, in ATR. */
  formationExcursionAtr: number;
}

/**
 * Classification of one interaction episode, in precedence order:
 * break > closeThrough > sweep > rejection > touch. 'pending' until resolved.
 */
export type InteractionOutcome = 'pending' | 'touch' | 'rejection' | 'sweep' | 'closeThrough' | 'break';

export interface Interaction {
  id: string;
  /** Role the zone had during this interaction. */
  role: SRZoneType;
  /** 'hold' = normal life of the zone; 'retest' = after a break, testing for a flip. */
  phase: 'hold' | 'retest';
  startTime: number;
  endTime: number | null;
  /** Bar with the deepest move into / beyond the zone. */
  extremeTime: number;
  extremePrice: number;
  /** How far price went past the facing edge into the zone (price units, ≥ 0). */
  penetration: number;
  /** penetration ÷ zone width (can exceed 1 when price went beyond). */
  penetrationRatio: number;
  /** Close location of the extreme bar: 1 = closed at the rejecting end, 0 = at the extreme. */
  closeLocation: number;
  swept: boolean;
  sweepTime: number | null;
  /** Wick depth beyond the far edge at the sweep (price units). */
  sweepDepth: number;
  closedThrough: boolean;
  broke: boolean;
  /** null while pending. */
  rejected: boolean | null;
  /** Maximum CLOSE away from the facing edge within the rejection window (price units). Decides rejection. */
  rejectionDistance: number;
  rejectionAtr: number;
  /** Maximum HIGH/LOW excursion away from the facing edge within the window (reported, not decisive). */
  maxExcursion: number;
  maxExcursionAtr: number;
  /** Bars from the extreme to the rejection threshold, when rejected. */
  barsToRejection: number | null;
  atr: number;
  outcome: InteractionOutcome;
  resolvedTime: number | null;
}

export interface BreakEvidence {
  rule: 'consecutiveCloses' | 'displacement';
  /** Closes (and their bar times) that satisfied the rule. */
  closeTimes: number[];
  closes: number[];
  /** Price beyond which closes counted. */
  threshold: number;
  atr: number;
  /** Role that was broken. */
  role: SRZoneType;
}

export interface StatusChange {
  from: ZoneStatus | null;
  to: ZoneStatus;
  time: number;
  reason: string;
}

export interface RoleChange {
  from: SRZoneType;
  to: SRZoneType;
  time: number;
}

export type ScoreComponentKey = keyof typeof SCORE_WEIGHTS;
export type ScoreComponents = Record<ScoreComponentKey, number>;

export interface ScoreBreakdown {
  components: ScoreComponents;
  weights: Readonly<Record<ScoreComponentKey, number>>;
  /** Σ weight × component, before the status factor. */
  weighted: number;
  statusFactor: number;
  /** Final 0–100 integer. */
  total: number;
}

/**
 * Immutable facts fixed at confirmation. Future candles can never change these
 * (the anti-repaint guarantee): they are frozen objects.
 */
export interface SRZoneDefinition {
  readonly id: string;
  readonly instrumentId: InstrumentId;
  readonly timeframe: Timeframe;
  /** Role at creation. */
  readonly type: SRZoneType;
  readonly zoneLow: number;
  readonly zoneHigh: number;
  readonly midPrice: number;
  readonly width: number;
  readonly pivotId: string;
  /** Swing bar time (when the structure formed). */
  readonly createdAt: number;
  /** Bar whose close confirmed the zone. */
  readonly confirmedAt: number;
  readonly confirmedIndex: number;
  readonly atrAtConfirmation: number;
}

/** Snapshot view of a zone: frozen definition + current evolving state. */
export interface SRZone extends SRZoneDefinition {
  role: SRZoneType;
  status: ZoneStatus;
  statusHistory: StatusChange[];
  roleHistory: RoleChange[];
  sourcePivotIds: string[];
  interactions: Interaction[];
  touchCount: number;
  rejectionCount: number;
  sweepCount: number;
  closeThroughCount: number;
  brokenAt: number | null;
  breakEvidence: BreakEvidence | null;
  flippedAt: number | null;
  lastInteractionAt: number | null;
  /** Price is currently interacting with the zone. */
  inZone: boolean;
  score: ScoreBreakdown;
  /** midPrice − current price (price units); null without a current price. */
  distanceFromPrice: number | null;
  /** |distance| in ATR of the zone's timeframe. */
  distanceAtr: number | null;
  confluenceIds: string[];
}

export interface DataGap {
  after: number;
  before: number;
  missingBars: number;
}

export type SRState = 'NO_DATA' | 'INSUFFICIENT_HISTORY' | 'READY';

export interface SRSnapshot {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  state: SRState;
  barsProcessed: number;
  requiredBars: number;
  /** Open time of the newest CLOSED bar analysed. */
  lastClosedTime: number | null;
  /** Latest price (may come from the forming bar). Used for distance only. */
  currentPrice: number | null;
  atr: number | null;
  zones: SRZone[];
  pivots: Pivot[];
  gaps: DataGap[];
  settingsKey: string;
}

export interface ConfluenceMember {
  zoneId: string;
  timeframe: Timeframe;
  zoneLow: number;
  zoneHigh: number;
  score: number;
}

export interface SRConfluence {
  id: string;
  instrumentId: InstrumentId;
  role: SRZoneType;
  zoneIds: string[];
  timeframes: Timeframe[];
  members: ConfluenceMember[];
  overlapLow: number;
  overlapHigh: number;
  score: number;
}

export interface SRMultiSnapshot {
  instrumentId: InstrumentId;
  byTimeframe: Partial<Record<Timeframe, SRSnapshot>>;
  /** Every zone from every timeframe, with confluence applied to scores. */
  zones: SRZone[];
  confluences: SRConfluence[];
}
