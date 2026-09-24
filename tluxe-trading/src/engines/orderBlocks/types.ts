import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';

export type OBType = 'bullish' | 'bearish';
export type BreakKind = 'BOS' | 'CHOCH';

/**
 * Lifecycle (see engine.ts for exact transitions):
 *  FRESH        confirmed; price has not returned into the zone; ≤ freshBars old
 *  ACTIVE       still untouched and valid, older than freshBars
 *  TESTED       price entered the zone; deepest penetration < mitigation threshold
 *  MITIGATED    deepest penetration ≥ mitigation threshold (a close beyond the far edge is still required to invalidate)
 *  INVALIDATED  a CLOSE beyond the far edge (terminal)
 *  EXPIRED      older than expiryBars without invalidation (terminal, if enabled)
 */
export type OBState = 'FRESH' | 'ACTIVE' | 'TESTED' | 'MITIGATED' | 'INVALIDATED' | 'EXPIRED';
export const OB_STATES: readonly OBState[] = ['FRESH', 'ACTIVE', 'TESTED', 'MITIGATED', 'INVALIDATED', 'EXPIRED'];

export interface OBSwing {
  id: string;
  kind: 'high' | 'low';
  index: number;
  time: number;
  price: number;
  confirmedIndex: number;
  confirmedAt: number;
}

/** Objective evidence for the displacement leg (origin+1 … break bar). */
export interface DisplacementEvidence {
  /** Break close − origin low (bullish) / origin high − break close (bearish), price units. */
  legSize: number;
  legAtr: number;
  /** Largest candle body in the leg, and in ATR. */
  maxBody: number;
  maxBodyAtr: number;
  bars: number;
  atr: number;
}

/** A confirmed structural break: a CLOSE beyond a previously confirmed swing. */
export interface StructureBreak {
  id: string;
  direction: 'up' | 'down';
  kind: BreakKind;
  /** The swing that was broken (confirmed BEFORE the break bar). */
  swingId: string;
  level: number;
  time: number;
  index: number;
  close: number;
  /** close − level (up) / level − close (down), ≥ 0. */
  breakDistance: number;
  /** Order block created from this break, or why none was. */
  orderBlockId: string | null;
  noBlockReason: string | null;
}

export interface OBTest {
  /** Bar that re-entered the zone. */
  time: number;
  /** Deepest penetration during this test as % of zone height (0–100, wicks). */
  depthPct: number;
}

export interface OBStateChange {
  from: OBState | null;
  to: OBState;
  time: number;
  reason: string;
}

export type OBScoreKey = 'timeframe' | 'displacement' | 'structure' | 'origin' | 'freshness' | 'mitigation' | 'imbalance' | 'confluence';
export type OBScoreComponents = Record<OBScoreKey, number>;

export interface OBScore {
  /** Raw 0–100 per component. */
  components: OBScoreComponents;
  /** Weights in % — they total exactly 100. */
  weights: Readonly<Record<OBScoreKey, number>>;
  /** weight × component / 100 per component (sums to total before rounding). */
  contributions: OBScoreComponents;
  /** 0–100 integer. Descriptive strength — NOT a probability of a profitable trade. */
  total: number;
}

export interface OrderBlock {
  /** Immutable: instrument:tf:OB:BULL|BEAR:originTime. */
  id: string;
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  type: OBType;
  /** Frozen at confirmation. */
  low: number;
  high: number;
  mid: number;
  boundaryMode: 'wickBody' | 'fullRange';
  /** Origin candle (the last opposite candle that launched the displacement). */
  originTime: number;
  originIndex: number;
  originOpen: number;
  originHigh: number;
  originLow: number;
  originClose: number;
  /** Candles in the origin cluster (1 in 'single' mode). */
  originCandles: number;
  /** = originTime (structure time). */
  createdAt: number;
  /** Break (confirmation) bar — knowable from its close. */
  confirmedAt: number;
  confirmedIndex: number;
  breakId: string;
  breakKind: BreakKind;
  brokenLevel: number;
  breakDistance: number;
  displacement: DisplacementEvidence;
  /** A three-candle fair-value gap inside the displacement leg (detected from candles). */
  hasImbalance: boolean;
  atrAtConfirmation: number;
  // --- lifecycle (the only fields future candles may change) ---
  state: OBState;
  stateHistory: OBStateChange[];
  tests: OBTest[];
  firstTestAt: number | null;
  lastTestAt: number | null;
  /** Deepest penetration so far, % of zone height (monotonic). */
  mitigationPct: number;
  mitigatedAt: number | null;
  invalidatedAt: number | null;
  expiredAt: number | null;
  lastInteractionAt: number | null;
  ageBars: number;
  /** mid − current price. */
  distance: number | null;
  distanceAtr: number | null;
  score: OBScore;
  confluenceIds: string[];
}

export type OBDataState = 'NO_DATA' | 'INSUFFICIENT_HISTORY' | 'READY';

export interface OBSnapshot {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  state: OBDataState;
  barsProcessed: number;
  requiredBars: number;
  /** Bars rejected as duplicate / out-of-order timestamps. */
  rejectedBars: number;
  lastClosedTime: number | null;
  currentPrice: number | null;
  atr: number | null;
  /** 'up' after a bullish break, 'down' after a bearish break. */
  trend: 'up' | 'down' | null;
  blocks: OrderBlock[];
  breaks: StructureBreak[];
  swings: OBSwing[];
  gaps: { after: number; before: number; missingBars: number }[];
  settingsKey: string;
}

export interface OBConfluence {
  id: string;
  type: OBType;
  blockIds: string[];
  timeframes: Timeframe[];
  low: number;
  high: number;
  score: number;
}

export interface OBMultiSnapshot {
  instrumentId: InstrumentId;
  byTimeframe: Partial<Record<Timeframe, OBSnapshot>>;
  blocks: OrderBlock[];
  confluences: OBConfluence[];
}
