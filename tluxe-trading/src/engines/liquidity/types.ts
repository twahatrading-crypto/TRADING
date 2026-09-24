import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';

/** BSL rests ABOVE highs (buy stops); SSL rests BELOW lows (sell stops). */
export type LiquiditySide = 'BSL' | 'SSL';

/**
 * Pool lifecycle (see engine.ts for the exact rules):
 *  FORMING      confirmed swing that does not (yet) qualify as liquidity — hidden by default
 *  ACTIVE       qualified, untaken, not yet approached again
 *  TESTED       price came back into the pool's tolerance band without taking it
 *  SWEPT        price traded beyond the band (liquidity taken); may later be RECLAIMED (flag)
 *  CONSUMED     after a sweep, price was ACCEPTED beyond the level (continuation) — terminal
 *  INVALIDATED  rule-defined end for a FORMING candidate (never qualified / taken first) — terminal
 */
export type PoolState = 'FORMING' | 'ACTIVE' | 'TESTED' | 'SWEPT' | 'CONSUMED' | 'INVALIDATED';
export const POOL_STATES: readonly PoolState[] = ['FORMING', 'ACTIVE', 'TESTED', 'SWEPT', 'CONSUMED', 'INVALIDATED'];

/** 'swing' = one qualifying swing; 'equal' = two or more near-equal swings (EQH / EQL). */
export type PoolSource = 'swing' | 'equal';

/** A confirmed swing high/low. Confirmed only after `swingRight` later bars have CLOSED. */
export interface LiquiditySwing {
  id: string;
  kind: 'high' | 'low';
  index: number;
  /** Open time (UTC s) of the swing bar. */
  time: number;
  price: number;
  confirmedIndex: number;
  /** Open time of the bar whose close confirmed the swing. */
  confirmedAt: number;
  /** ATR at confirmation. */
  atr: number;
  /** Size of the leg into the swing over `swingLeft` bars (ATR). */
  prominenceAtr: number;
  /** Furthest CLOSE away from the swing during the confirmation bars (ATR). */
  displacementAtr: number;
}

export interface PoolContribution {
  swingId: string;
  time: number;
  price: number;
  confirmedAt: number;
}

export interface TestEvent {
  /** Bar on which price re-entered the tolerance band. */
  time: number;
  /** Closest approach (price) during this test. */
  extreme: number;
}

/**
 * 'pending'   sweep in progress, not yet resolved
 * 'reclaimed' a close back on the resting side within reclaimWindowBars (information only — not a signal)
 * 'accepted'  acceptance beyond the level (continuation) → pool CONSUMED
 * 'returned'  price closed back on the resting side, but after the reclaim window
 */
export type SweepOutcome = 'pending' | 'reclaimed' | 'accepted' | 'returned';

export interface SweepEvent {
  id: string;
  poolId: string;
  side: LiquiditySide;
  /** 1 = first sweep of this pool, ≥ 2 = repeated sweep. */
  sequence: number;
  /** Bar that first traded beyond the band. */
  time: number;
  /** Pool level that was taken. */
  level: number;
  /** Most extreme price beyond the level during the sweep (updated while pending). */
  extremePrice: number;
  extremeTime: number;
  /** extremePrice − level (BSL) / level − extremePrice (SSL), ≥ 0. */
  penetration: number;
  penetrationAtr: number;
  /** Close of the sweep bar. */
  sweepClose: number;
  /** 'wick' = sweep bar closed back on the resting side; 'closeThrough' = closed beyond the level. */
  kind: 'wick' | 'closeThrough';
  outcome: SweepOutcome;
  reclaimed: boolean;
  reclaimTime: number | null;
  /** Bars from the sweep bar to the reclaiming close (0 = same bar). */
  barsToReclaim: number | null;
  acceptedTime: number | null;
  /** Bar on which the outcome was decided (null while pending). */
  resolvedTime: number | null;
}

export interface StateChange {
  from: PoolState | null;
  to: PoolState;
  time: number;
  reason: string;
}

export type LiquidityScoreKey = 'timeframe' | 'equalLevels' | 'significance' | 'displacement' | 'tests' | 'freshness' | 'confluence';
export type LiquidityScoreComponents = Record<LiquidityScoreKey, number>;

export interface LiquidityScore {
  components: LiquidityScoreComponents;
  weights: Readonly<Record<LiquidityScoreKey, number>>;
  weighted: number;
  stateFactor: number;
  /** 0–100 integer. A measure of how much/obvious the resting liquidity is — never a probability. */
  total: number;
}

export interface LiquidityPool {
  /** Stable: instrument:tf:LQ:side:time-of-first-swing. */
  id: string;
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  side: LiquiditySide;
  source: PoolSource;
  /** The price that must be traded through: highest contributing high (BSL) / lowest contributing low (SSL). */
  level: number;
  /** Span of the contributing highs/lows. */
  rangeLow: number;
  rangeHigh: number;
  /** Equal-level / sweep tolerance, frozen when the pool is created. */
  tolerance: number;
  /** Swing bar of the first contribution (structure time). */
  createdAt: number;
  /** Bar whose close confirmed the first contribution (knowable from its close). */
  confirmedAt: number;
  confirmedIndex: number;
  atrAtConfirmation: number;
  contributions: PoolContribution[];
  tests: TestEvent[];
  sweeps: SweepEvent[];
  state: PoolState;
  stateHistory: StateChange[];
  reclaimed: boolean;
  consumedAt: number | null;
  invalidatedAt: number | null;
  lastInteractionAt: number | null;
  /** Closed bars since confirmation. */
  ageBars: number;
  /** Price-relative (forming bar allowed): level − price. */
  distance: number | null;
  distanceAtr: number | null;
  /**
   * Forming-bar context only: the still-forming bar is currently trading beyond
   * the band. NOT a sweep (sweeps are confirmed on bar close) — never recorded.
   */
  liveProbe: boolean;
  score: LiquidityScore;
  confluenceIds: string[];
}

export interface LiquidityGap {
  after: number;
  before: number;
  missingBars: number;
}

export type LiquidityDataState = 'NO_DATA' | 'INSUFFICIENT_HISTORY' | 'READY';

export interface LiquiditySnapshot {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  state: LiquidityDataState;
  barsProcessed: number;
  requiredBars: number;
  lastClosedTime: number | null;
  currentPrice: number | null;
  atr: number | null;
  /** Every pool including FORMING / INVALIDATED (the UI filters). */
  pools: LiquidityPool[];
  swings: LiquiditySwing[];
  gaps: LiquidityGap[];
  settingsKey: string;
}

export interface LiquidityClusterMember {
  poolId: string;
  timeframe: Timeframe;
  level: number;
  score: number;
}

export interface LiquidityCluster {
  id: string;
  side: LiquiditySide;
  poolIds: string[];
  timeframes: Timeframe[];
  members: LiquidityClusterMember[];
  /** Span of the member levels. */
  low: number;
  high: number;
  score: number;
}

export interface LiquidityMultiSnapshot {
  instrumentId: InstrumentId;
  byTimeframe: Partial<Record<Timeframe, LiquiditySnapshot>>;
  /** Pools from every timeframe (their own detections), with confluence applied to scores. */
  pools: LiquidityPool[];
  clusters: LiquidityCluster[];
}
