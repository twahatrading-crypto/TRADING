import type { InstrumentId } from '../../types/instruments';

/** High / Low Engine timeframes (context → entry). */
export type HLETimeframe = 'H4' | 'H1' | 'M15' | 'M5' | 'M1';
export type Side = 'BUY' | 'SELL';
/** Display bias. RANGING / UNCLEAR map to NEUTRAL; too little history → INSUFFICIENT_DATA. */
export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'INSUFFICIENT_DATA';
/** structureBias() labels (handoff §3). */
export type RawBias = 'BULLISH' | 'BEARISH' | 'RANGING' | 'UNCLEAR' | 'UNKNOWN';

export interface HLESwing {
  kind: 'high' | 'low';
  time: number;
  price: number;
  /** Close time of the confirming bar (pivot + k). */
  confirmedAt: number;
}

/** H4 direction / H1 bias from the last two confirmed swing highs and lows. Context only — never a gate. */
export interface StructureContext {
  bias: Bias;
  raw: RawBias;
  dir: -1 | 0 | 1;
  /** Honest label: the test compares exactly the last two swing highs and the last two swing lows. */
  structure: string;
  reason: string;
  lastSwingHigh: HLESwing | null;
  prevSwingHigh: HLESwing | null;
  lastSwingLow: HLESwing | null;
  prevSwingLow: HLESwing | null;
  /** Share of the last ≤4 swing steps (highs + lows) agreeing with the label; null when dir = 0. */
  strength: { value: number; agree: number; total: number } | null;
  bars: number;
  required: number;
}

export type LevelType = 'PDH' | 'PDL' | 'ASIA_HIGH' | 'ASIA_LOW' | 'SWING_HIGH' | 'SWING_LOW';
/** Rating family. Clusters are 'swing'; the cluster with the most pivots per side is rated 'major'. */
export type LevelSource = 'pdh' | 'pdl' | 'asia' | 'swing';
export type Strength = 'STRONG' | 'MEDIUM' | 'WEAK';
/** H1 state from validFrom with the tolerance frozen at validFrom (R2 fix). */
export type LevelState = 'ACTIVE' | 'SWEPT' | 'CONSUMED';

export interface LevelRating {
  score: number;
  label: Strength;
  parts: { kind: number; touches: number; reaction: number; freshness: number; untouched: number };
}

/** An important H1 level. Identity, price, validFrom and tolerance are frozen at creation. */
export interface Level {
  /** instrument:HLE:LVL:TYPE:identity */
  id: string;
  type: LevelType;
  source: LevelSource;
  kind: 'high' | 'low';
  /** low → BUY candidate (SSL below) · high → SELL candidate (BSL above). A level alone is never a signal. */
  side: Side;
  price: number;
  /** When the level formed (PD: day end · Asia: the candle that set it · cluster: its last pivot). */
  formedAt: number;
  /** Causality gate: the level does not exist before this instant. */
  validFrom: number;
  /** Knowledge time the engine published it (≥ validFrom). */
  createdAt: number;
  /** PD / Asia 1 · cluster: number of confirmed pivots. */
  touches: number;
  /** Cluster member pivot times (empty for PD / Asia). */
  members: number[];
  /** H1 ATR at validFrom and the frozen tolerance = max(ATR × 0.15, price × 0.00015). */
  atr: number;
  tol: number;
  state: LevelState;
  /** Open time of the first H1 bar that wicked through / closed through (beyond tol). */
  sweptAt: number | null;
  consumedAt: number | null;
  /** Largest H1 penetration beyond the level since validFrom (price units). */
  penetration: number;
  /** Replaced by a newer definition (new day / session extreme / cluster change). */
  retiredAt: number | null;
  setupId: string | null;
  /* ---- evaluated at the snapshot (display / score; drift by design, handoff R4) ---- */
  label: string;
  major: boolean;
  rating: LevelRating;
  distance: number | null;
  distanceAtr: number | null;
  near: boolean;
  /** First M15 bar that reached the level (within 0.25 ATR) since validFrom. */
  touchedAt: number | null;
}

export type SetupState = 'SWEPT' | 'WAITING_M5' | 'WAITING_M1' | 'NO_TARGET' | 'ENTRY_READY' | 'INVALIDATED' | 'EXPIRED';
export const TERMINAL: readonly SetupState[] = ['INVALIDATED', 'EXPIRED'];

export type BlockerCode =
  | 'NO_DATA'
  | 'NO_LEVEL'
  | 'NOT_AT_LEVEL'
  | 'TOO_FAR'
  | 'WAITING_SWEEP'
  | 'WAITING_RECLAIM'
  | 'WAITING_STRUCTURE'
  | 'WAITING_PULLBACK'
  | 'NO_TARGET'
  | 'EXPIRED'
  | 'LEVEL_BROKEN'
  | 'LEVEL_CONSUMED'
  | 'STRUCTURE_FAILED'
  | 'DATA_STALE'
  | 'DISCONNECTED'
  | 'NONE';

export interface StateChange {
  from: SetupState | null;
  to: SetupState;
  time: number;
  reason: string;
}

export interface SweepRecord {
  /** Open time of the M15 bar that first traded beyond the level by ≥ 0.10 ATR. */
  time: number;
  knownAt: number;
  /** Furthest point of the sweep run (frozen at the reclaim close). */
  extreme: number;
  extremeTime: number;
  /** Last M15 bar of the run still beyond the level. */
  runEnd: number;
  /** Penetration of the sweep bar ÷ M15 ATR at that bar. */
  penetration: number;
  penetrationAtr: number;
  atr: number;
  /** Sweep-candle rejection wick ÷ range, and whether it counts as rejection (reclaimed or ≥ 0.45). */
  wick: number;
  rejection: boolean;
  /** The sweep candle closed beyond the level by > 0.10 ATR (break risk). */
  closedBeyond: boolean;
}

export interface ReclaimRecord {
  time: number;
  knownAt: number;
  price: number;
  /** M15 bars from the sweep bar to the reclaim bar, inclusive. */
  bars: number;
}

export interface M5Confirmation {
  /** CHOCH = the M5 bias before the sweep was not this trade's direction (incl. ranging); BOS = it was. */
  kind: 'BOS' | 'CHOCH';
  preBias: RawBias;
  brokenLevel: number;
  swingTime: number;
  /** The broken swing formed before the sweep (fallback, handoff R8). */
  preSweepSwing: boolean;
  time: number;
  knownAt: number;
  close: number;
  atr: number;
  displacement: { body: number; bodyAtr: number; bodyPct: number; displaced: boolean };
}

/** Fib pullback band of the impulse, frozen at the M5 confirmation. */
export interface EntryZone {
  low: number;
  high: number;
  impulseFrom: number;
  impulseTo: number;
  stop: number;
  definedAt: number;
}

export interface ConfluenceItem {
  low: number;
  high: number;
  time: number;
}

/** Frozen at the pullback close (R1 fix): never re-read from later prices. */
export interface RiskPlan {
  entry: number;
  stop: number;
  tp1: number;
  tp1Source: string;
  tp2: number | null;
  tp2Source: string | null;
  risk: number;
  rr1: number;
  rr2: number | null;
  belowMinRR: boolean;
  targetsConsidered: number;
}

export type HLEScoreKey = 'htfAlignment' | 'levelImportance' | 'sweepQuality' | 'rejectionDisplacement' | 'm5Structure' | 'm1EntryQuality' | 'fvgObConfluence';
export interface HLEScore {
  /** 0–100 fraction of each component's maximum. */
  components: Record<HLEScoreKey, number>;
  weights: Readonly<Record<HLEScoreKey, number>>;
  /** Points per component = round(fraction × max). */
  contributions: Record<HLEScoreKey, number>;
  /** 0–100 descriptive quality. NOT a win probability; never creates or blocks a signal. */
  total: number;
  frozen: boolean;
}

export interface Setup {
  /** instrument:HLE:BUY|SELL:levelId */
  id: string;
  instrumentId: InstrumentId;
  side: Side;
  levelId: string;
  levelType: LevelType;
  levelLabel: string;
  level: number;
  levelValidFrom: number;
  state: SetupState;
  code: BlockerCode;
  /** Pipeline stage 2–5 (handoff §8.2); an invalidated setup keeps the stage it died at. */
  stage: number;
  history: StateChange[];
  touch: { time: number; knownAt: number } | null;
  sweep: SweepRecord;
  reclaim: ReclaimRecord | null;
  m5: M5Confirmation | null;
  zone: EntryZone | null;
  /** M1 pullback bar (overlap with the zone) — the entry event. */
  entry: { time: number; knownAt: number; price: number } | null;
  risk: RiskPlan | null;
  confluence: { fvg: ConfluenceItem[]; ob: ConfluenceItem[]; at: number } | null;
  /** H4 / H1 at the entry event (frozen); counter-trend = H4 against the trade. */
  context: { h4: RawBias; h4Dir: number; h1: RawBias; h1Dir: number; counterTrend: boolean } | null;
  /** Alert identity: HLE-<SYMBOL>-<DIR>-<M5 break candle UTC YYYYMMDDTHHMM>. */
  alertKey: string | null;
  lastUpdate: number;
  distance: number | null;
  score: HLEScore;
}

export type HLEEventType =
  | 'H4_BIAS_CHANGED'
  | 'H1_BIAS_CHANGED'
  | 'LEVEL_DETECTED'
  | 'LEVEL_APPROACH'
  | 'SSL_TAKEN'
  | 'BSL_TAKEN'
  | 'LEVEL_RECLAIMED'
  | 'M5_CHOCH'
  | 'M5_BOS'
  | 'M1_PULLBACK'
  | 'NO_TARGET'
  | 'ENTRY_READY'
  | 'SETUP_INVALIDATED'
  | 'SETUP_EXPIRED'
  | 'DATA_REVISED';

export interface HLEEvent {
  /** Deterministic: instrument:type:subject:time. */
  id: string;
  time: number;
  instrumentId: InstrumentId;
  timeframe: HLETimeframe;
  type: HLEEventType;
  price: number | null;
  setupId: string | null;
  message: string;
}

export type HLEDataState = 'NO_DATA' | 'INSUFFICIENT_HISTORY' | 'READY';
export interface HLETfStatus {
  state: HLEDataState;
  bars: number;
  required: number;
  lastClosedTime: number | null;
  atr: number | null;
  rejected: number;
}

/** Where one direction's walk stands (both directions are always published, handoff §8.3). */
export interface Candidate {
  side: Side;
  stage: number;
  invalidated: boolean;
  code: BlockerCode;
  why: string;
  levelId: string | null;
  setupId: string | null;
  distanceAtr: number | null;
}

export interface HLESnapshot {
  instrumentId: InstrumentId;
  state: HLEDataState;
  /** Human reason when not READY ("need 60 closed H4 candles, have 12"). */
  reason: string | null;
  knowledgeTime: number | null;
  /** Last CLOSED M15 close — the price every engine decision uses. */
  price: number | null;
  /** Display price (latest close supplied by the caller), used only for distances. */
  displayPrice: number | null;
  atr15: number | null;
  timeframes: Record<HLETimeframe, HLETfStatus>;
  h4: StructureContext;
  h1: StructureContext;
  levels: Level[];
  setups: Setup[];
  candidates: { BUY: Candidate; SELL: Candidate };
  /** Direction the engine is working (handoff §8.3), null when neither side passed stage 1. */
  pick: Side | null;
  events: HLEEvent[];
  settingsKey: string;
}
