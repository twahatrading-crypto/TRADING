import type { InstrumentId } from '../../types/instruments';

/** High / Low Engine timeframes (context → entry). */
export type HLETimeframe = 'H4' | 'H1' | 'M15' | 'M5' | 'M1';
export type Side = 'BUY' | 'SELL';
export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'INSUFFICIENT_DATA';

export interface HLESwing {
  kind: 'high' | 'low';
  time: number;
  price: number;
  /** Close time of the confirming bar. */
  confirmedAt: number;
}

export interface HLEBreak {
  direction: 'up' | 'down';
  kind: 'BOS' | 'CHOCH';
  level: number;
  swingTime: number;
  time: number;
  knownAt: number;
  close: number;
}

/** Structure context of a timeframe from its last confirmed swings (H4 direction / H1 bias). */
export interface StructureContext {
  bias: Bias;
  /** "Higher Highs + Higher Lows", "Lower Highs + Lower Lows", "Range / Neutral", … */
  structure: string;
  short: string;
  lastSwingHigh: HLESwing | null;
  prevSwingHigh: HLESwing | null;
  lastSwingLow: HLESwing | null;
  prevSwingLow: HLESwing | null;
  /** 0–100: share of recent swing comparisons agreeing with the bias. */
  strength: number;
  bars: number;
}

export type LevelType = 'PDH' | 'PDL' | 'ASIA_HIGH' | 'ASIA_LOW' | 'SWING_HIGH' | 'SWING_LOW';
export type Strength = 'STRONG' | 'MEDIUM' | 'WEAK';
export type LevelStatus = 'ACTIVE' | 'SWEPT' | 'BROKEN' | 'EXPIRED' | 'SUPERSEDED';

/** An important H1 level. Identity, price, time and strength are frozen at creation. */
export interface Level {
  /** instrument:HLE:LVL:TYPE:sourceTime */
  id: string;
  type: LevelType;
  kind: 'high' | 'low';
  /** high → SELL candidate (BSL above) · low → BUY candidate (SSL below). */
  side: Side;
  price: number;
  /** Open time of the H1 bar that made the extreme. */
  sourceTime: number;
  /** Period the level describes (day / Asia session / swing bar). */
  periodStart: number;
  periodEnd: number;
  /** Knowledge time: when the level became known (closed candles only). */
  createdAt: number;
  atr: number;
  strengthScore: number;
  strength: Strength;
  /** Other active levels within tolerance at creation (confluence). */
  confluence: string[];
  /** Setup that watches this level (own, or the one it merged into). */
  setupId: string;
  status: LevelStatus;
  statusAt: number | null;
  distance: number | null;
}

export type SetupState =
  | 'LEVEL_ACTIVE'
  | 'LIQUIDITY_APPROACH'
  | 'SWEPT'
  | 'RECLAIMED'
  | 'WAITING_M5'
  | 'M5_CONFIRMED'
  | 'WAITING_M1'
  | 'ENTRY_READY'
  | 'INVALIDATED'
  | 'EXPIRED';
export const TERMINAL: readonly SetupState[] = ['INVALIDATED', 'EXPIRED'];

export interface StateChange {
  from: SetupState | null;
  to: SetupState;
  time: number;
  reason: string;
}

export interface SweepRecord {
  /** M15 bar that first traded beyond the level. */
  time: number;
  knownAt: number;
  extreme: number;
  extremeTime: number;
  penetration: number;
  /** ÷ H1 ATR of the level. */
  penetrationAtr: number;
  /** Rejection wick of the sweep bar ÷ its range (0–1). */
  rejection: number;
  /** Level importance frozen when liquidity was taken. */
  importanceAtSweep: number;
}

export interface ReclaimRecord {
  time: number;
  knownAt: number;
  price: number;
  /** M15 bars from sweep bar to reclaim bar, inclusive. */
  bars: number;
}

export interface M5Confirmation {
  kind: 'BOS' | 'CHOCH';
  brokenLevel: number;
  swingTime: number;
  time: number;
  knownAt: number;
  close: number;
  displacement: { legAtr: number; maxBodyAtr: number; breakBodyAtr: number; bars: number; atr: number; strong: boolean };
}

export type ZoneSource = 'OB+FVG' | 'OB' | 'FVG' | 'RECLAIM';
export interface EntryZone {
  source: ZoneSource;
  low: number;
  high: number;
  ob: { low: number; high: number; time: number } | null;
  fvg: { low: number; high: number; time: number } | null;
  definedAt: number;
}

export interface RiskPlan {
  entry: number;
  stop: number;
  tp1: number | null;
  tp1Source: string;
  tp2: number | null;
  tp2Source: string;
  risk: number;
  rr1: number | null;
  rr2: number | null;
}

export type HLEScoreKey = 'htfAlignment' | 'levelImportance' | 'sweepQuality' | 'rejectionDisplacement' | 'm5Structure' | 'm1EntryQuality' | 'fvgObConfluence';
export interface HLEScore {
  components: Record<HLEScoreKey, number>;
  weights: Readonly<Record<HLEScoreKey, number>>;
  contributions: Record<HLEScoreKey, number>;
  /** 0–100 descriptive quality. NOT a win probability; never replaces a missing stage. */
  total: number;
}

export interface Setup {
  /** instrument:HLE:BUY|SELL:levelId-suffix */
  id: string;
  instrumentId: InstrumentId;
  side: Side;
  levelId: string;
  levelType: LevelType;
  level: number;
  levelCreatedAt: number;
  /** Levels merged into this setup (confluence), incl. its own. */
  levelIds: string[];
  state: SetupState;
  history: StateChange[];
  approachAt: number | null;
  h4AtSweep: Bias | null;
  counterTrend: boolean | null;
  sweep: SweepRecord | null;
  reclaim: ReclaimRecord | null;
  m5: M5Confirmation | null;
  zone: EntryZone | null;
  risk: RiskPlan | null;
  pullback: { time: number; knownAt: number; price: number } | null;
  entry: { time: number; knownAt: number; price: number } | null;
  stageBars: number;
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
  | 'ENTRY_READY'
  | 'SETUP_INVALIDATED'
  | 'SETUP_EXPIRED';

export interface HLEEvent {
  /** Deterministic: instrument:type:setup-or-tf:time. */
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

export interface HLESnapshot {
  instrumentId: InstrumentId;
  state: HLEDataState;
  /** WAITING_FOR_LEVEL when no setup is open. */
  engineState: 'WAITING_FOR_LEVEL' | 'TRACKING';
  knowledgeTime: number | null;
  price: number | null;
  timeframes: Record<HLETimeframe, HLETfStatus>;
  h4: StructureContext;
  h1: StructureContext;
  levels: Level[];
  setups: Setup[];
  events: HLEEvent[];
  /** The live ENTRY_READY setup (BUY / SELL CONFIRMED), if any. */
  signal: { side: Side; setupId: string; at: number } | null;
  settingsKey: string;
}
