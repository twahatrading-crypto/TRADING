import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import type { SmcScoreKey } from './config';

/* All times are UTC epoch SECONDS (candle open times), as in every TLUXE candle engine.
 * originTime  open time of the bar that formed the object
 * confirmedAt open time of the bar whose CLOSE confirmed it
 * validFrom   close time of that bar = the first moment the object is knowable (knowledge time)
 */

export type SmcDirection = 'bullish' | 'bearish';
export type SmcStructureState = 'BULLISH' | 'BEARISH' | 'RANGING' | 'UNDEFINED';
export type SwingLabel = 'HH' | 'LH' | 'EQH' | 'HL' | 'LL' | 'EQL';

interface Base {
  id: string;
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  originTime: number;
  confirmedAt: number;
  validFrom: number;
  /** Measured evidence, human readable. */
  evidence: string;
}

export interface SmcSwing extends Base {
  kind: 'high' | 'low';
  price: number;
  originIndex: number;
  confirmedIndex: number;
  /** vs the previous confirmed swing of the same kind; null for the first one. */
  label: SwingLabel | null;
  prevPrice: number | null;
  atr: number;
  prominenceAtr: number;
  /** ACTIVE = not yet closed through; BROKEN = a close beyond it (BOS / CHOCH) or superseded as reference. */
  state: 'ACTIVE' | 'BROKEN';
  brokenAt: number | null;
}

export interface SmcBreak extends Base {
  kind: 'BOS' | 'CHOCH';
  direction: SmcDirection;
  swingId: string;
  swingLabel: SwingLabel | null;
  /** The swing price that was closed through. */
  level: number;
  breakIndex: number;
  close: number;
  /** close − level (bullish) / level − close (bearish), > 0. */
  breakDistance: number;
  breakAtr: number;
  /** Break-based trend before this break. */
  prevState: SmcStructureState;
  /** First break of the history: establishes the trend (not a change of character). */
  initial: boolean;
  displacementId: string | null;
  state: 'CONFIRMED';
}

export interface SmcDisplacement extends Base {
  direction: SmcDirection;
  rule: 'single' | 'run';
  startTime: number;
  /** Index of the qualifying bar. */
  confirmedIndex: number;
  bars: number;
  /** Close of the last bar − open of the first (signed in the direction). */
  netMove: number;
  netMoveAtr: number;
  maxBody: number;
  maxBodyAtr: number;
  /** Largest body as a share of its bar's range (0–1). */
  maxBodyPct: number;
  /** Smallest body share in the run (0–1). */
  minBodyPct: number;
  atr: number;
  /** Set when a same-direction BOS / CHOCH used it (lifecycle field). */
  breakId: string | null;
}

export type FvgState = 'FRESH' | 'ACTIVE' | 'PARTIALLY_FILLED' | 'FILLED' | 'INVALIDATED' | 'EXPIRED';

export interface SmcFvg extends Base {
  direction: SmcDirection;
  /** Frozen at creation. */
  upper: number;
  lower: number;
  mid: number;
  size: number;
  sizeAtr: number;
  createdIndex: number;
  // lifecycle
  state: FvgState;
  /** Deepest fill so far, 0–100 (wicks; monotonic). */
  fillPct: number;
  firstTouchAt: number | null;
  filledAt: number | null;
  invalidatedAt: number | null;
  expiredAt: number | null;
  ageBars: number;
  history: { to: FvgState; time: number }[];
}

export type RangeZone = 'PREMIUM' | 'EQUILIBRIUM' | 'DISCOUNT' | 'ABOVE_RANGE' | 'BELOW_RANGE';

export interface SmcDealingRange extends Base {
  direction: SmcDirection;
  high: number;
  low: number;
  eq: number;
  highTime: number;
  lowTime: number;
  anchorBreakId: string;
  sizeAtr: number;
  state: 'VALID' | 'INVALIDATED';
  invalidatedAt: number | null;
}

export interface SmcRangeLocation {
  price: number;
  /** Position in the range, 0 = low, 100 = high (may exceed 0–100 outside the range). */
  pct: number;
  zone: RangeZone;
}

export interface SmcInducement extends Base {
  direction: SmcDirection;
  price: number;
  swingId: string;
  rangeId: string;
  state: 'UNTAKEN' | 'TAKEN' | 'VOID';
  takenAt: number | null;
  penetrationAtr: number | null;
  zoneAtTake: RangeZone | null;
}

/** An Order Block from the (unchanged) Order Block engine, as SMC shows it. */
export interface SmcOrderBlockView {
  id: string;
  timeframe: Timeframe;
  direction: SmcDirection;
  low: number;
  high: number;
  mid: number;
  state: string;
  fresh: boolean;
  live: boolean;
  mitigationPct: number;
  mitigatedAt: number | null;
  firstTestAt: number | null;
  originTime: number;
  confirmedAt: number;
  breakKind: 'BOS' | 'CHOCH';
  score: number;
  evidence: string;
}

export type LiquidityStatus = 'LIQUIDITY PRESENT' | 'LIQUIDITY SWEPT' | 'LIQUIDITY CONSUMED';

/** A liquidity pool from the (unchanged) Liquidity engine. */
export interface SmcLiquidityView {
  id: string;
  timeframe: Timeframe;
  side: 'BSL' | 'SSL';
  /** EQH / EQL for equal-level pools. */
  kind: 'BSL' | 'SSL' | 'EQH' | 'EQL';
  level: number;
  poolState: string;
  status: LiquidityStatus;
  confirmedAt: number;
  lastSweepAt: number | null;
  score: number;
  touches: number;
}

/** A sweep from the Liquidity engine, with SMC's structural follow-up (never the same event). */
export interface SmcSweepView {
  id: string;
  timeframe: Timeframe;
  poolId: string;
  side: 'BSL' | 'SSL';
  time: number;
  level: number;
  extreme: number;
  penetrationAtr: number;
  kind: 'wick' | 'closeThrough';
  outcome: string;
  reclaimed: boolean;
  /** CONFIRMED STRUCTURAL REVERSAL: a CHOCH against the swept side after the sweep (id), else null. */
  reversalBreakId: string | null;
}

export type SmcEventType =
  | 'SWING CONFIRMED'
  | 'STRUCTURE CHANGED'
  | 'BOS CONFIRMED'
  | 'CHOCH CONFIRMED'
  | 'DISPLACEMENT'
  | 'FVG CREATED'
  | 'FVG PARTIALLY FILLED'
  | 'FVG FILLED'
  | 'FVG INVALIDATED'
  | 'OB MITIGATED'
  | 'LIQUIDITY SWEPT'
  | 'DEALING RANGE CHANGED'
  | 'INDUCEMENT CANDIDATE'
  | 'DATA REVISED'
  | 'DATA STALE'
  | 'DATA RECOVERED';

export interface SmcEvent {
  /** Deterministic: instrument:tf:type:object. */
  id: string;
  /** Knowledge time (s). */
  time: number;
  instrumentId: InstrumentId;
  timeframe: Timeframe | null;
  type: SmcEventType;
  price: number | null;
  message: string;
  /** Kept in the log but no longer produced after a data revision rebuild. */
  superseded?: boolean;
}

export type SmcDataState = 'NO_DATA' | 'INSUFFICIENT_DATA' | 'READY';

export type SequenceStageState = 'CONFIRMED' | 'WAITING';
export interface SequenceStage {
  key: 'liquidity' | 'sweep' | 'displacement' | 'choch' | 'bos' | 'poi' | 'mitigation';
  label: string;
  state: SequenceStageState;
  time: number | null;
  evidence: string | null;
}
export interface SmcSequence {
  direction: SmcDirection;
  timeframe: Timeframe;
  stages: SequenceStage[];
  confirmed: number;
  /** Confirmed stages happened in the listed order. */
  inOrder: boolean;
  anchorTime: number | null;
}

export interface SmcTimeframeSnapshot {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  dataState: SmcDataState;
  barsProcessed: number;
  requiredBars: number;
  rejectedBars: number;
  lastClosedTime: number | null;
  knowledgeTime: number | null;
  atr: number | null;
  price: number | null;
  state: SmcStructureState;
  trend: SmcDirection | null;
  stateEvidence: string;
  lastBreakAt: number | null;
  swings: SmcSwing[];
  lastHigh: SmcSwing | null;
  lastLow: SmcSwing | null;
  refHigh: SmcSwing | null;
  refLow: SmcSwing | null;
  breaks: SmcBreak[];
  displacements: SmcDisplacement[];
  fvgs: SmcFvg[];
  range: SmcDealingRange | null;
  location: SmcRangeLocation | null;
  rangeUnavailable: string | null;
  inducements: SmcInducement[];
  orderBlocks: SmcOrderBlockView[];
  liquidity: SmcLiquidityView[];
  sweeps: SmcSweepView[];
  sequences: { bullish: SmcSequence; bearish: SmcSequence };
  events: SmcEvent[];
  gaps: { after: number; before: number; missingBars: number }[];
}

export interface MatrixRow {
  timeframe: Timeframe;
  dataState: SmcDataState;
  state: SmcStructureState;
  lastSwing: string;
  liquidity: string;
  sweep: string;
  bos: string;
  choch: string;
  displacement: string;
  ob: string;
  fvg: string;
  premiumDiscount: string;
}

export type MtfVerdict = 'BULLISH ALIGNMENT' | 'BEARISH ALIGNMENT' | 'MIXED' | 'NEUTRAL' | 'WAIT' | 'INSUFFICIENT DATA' | 'DATA STALE' | 'DATA UNAVAILABLE';
export interface SmcConflict {
  id: string;
  severity: 'conflict' | 'warning' | 'info';
  text: string;
}
export interface MtfSummary {
  verdict: MtfVerdict;
  bias: SmcDirection | null;
  reason: string;
  conflicts: SmcConflict[];
}

export interface SmcScore {
  direction: SmcDirection | null;
  components: Record<SmcScoreKey, number>;
  evidence: Record<SmcScoreKey, string>;
  weights: Readonly<Record<SmcScoreKey, number>>;
  /** 0–100 integer, or null when data does not allow a score. NOT a probability of winning. */
  total: number | null;
  uncapped: number | null;
  missing: string[];
  note: string;
}

export type SmcFeed = 'LIVE' | 'STALE' | 'DISCONNECTED' | 'REPLAY';

export interface SmcSnapshot {
  instrumentId: InstrumentId;
  knowledgeTime: number | null;
  price: number | null;
  feed: SmcFeed;
  byTimeframe: Partial<Record<Timeframe, SmcTimeframeSnapshot>>;
  matrix: MatrixRow[];
  summary: MtfSummary;
  score: SmcScore;
  events: SmcEvent[];
  settingsKey: string;
}
