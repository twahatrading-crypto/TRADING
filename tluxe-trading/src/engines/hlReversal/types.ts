import type { InstrumentId } from '../../types/instruments';

/** The five timeframes the High / Low Reversal engine uses (context → entry). */
export type HLRTimeframe = 'H4' | 'H1' | 'M15' | 'M5' | 'M1';
export type Direction = 'BUY' | 'SELL';
export type H4State = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'INSUFFICIENT_DATA';

export interface HLRSwing {
  kind: 'high' | 'low';
  /** Swing bar open time. */
  time: number;
  price: number;
  /** Close time of the confirming bar (swingRight bars later) — when it became knowable. */
  confirmedAt: number;
}

export interface HLRBreak {
  direction: 'up' | 'down';
  kind: 'BOS' | 'CHOCH';
  /** Broken swing (confirmed on an earlier bar). */
  level: number;
  swingTime: number;
  /** Break bar open time / close time (knowable at close). */
  time: number;
  knownAt: number;
  close: number;
}

export interface H4Context {
  state: H4State;
  /** "HH + HL", "LH + LL", "HH + LL", … */
  structure: string;
  highs: 'HH' | 'LH' | null;
  lows: 'HL' | 'LL' | null;
  lastSwingHigh: HLRSwing | null;
  prevSwingHigh: HLRSwing | null;
  lastSwingLow: HLRSwing | null;
  prevSwingLow: HLRSwing | null;
  lastBreak: HLRBreak | null;
  /** 0–100: share of the last swing comparisons that agree with the state. */
  strength: number;
  barsProcessed: number;
}

export type LevelStatus = 'ACTIVE' | 'TESTED' | 'TAKEN' | 'SWEPT' | 'BROKEN' | 'EXPIRED';

/** An important H1 high / low. Identity and price are frozen at confirmation. */
export interface KeyLevel {
  /** instrument:HLR:LVL:HIGH|LOW:swingTime */
  id: string;
  side: 'high' | 'low';
  /** high → SELL candidate (buy-side liquidity above) · low → BUY candidate (sell-side liquidity below). */
  direction: Direction;
  price: number;
  time: number;
  confirmedAt: number;
  /** H1 ATR at confirmation. */
  atr: number;
  prominence: number;
  prominenceAtr: number;
  /** Bars back over which this is the extreme (capped). */
  dominanceBars: number;
  /** 0–100, frozen at confirmation. */
  significance: number;
  /** Later H1 swings within the equal-level tolerance (equal highs / lows). */
  equals: HLRSwing[];
  status: LevelStatus;
  testedAt: number | null;
  ageBars: number;
}

export type LiquidityStatus = 'NONE' | 'TOUCHED' | 'LIQUIDITY_TAKEN' | 'SWEPT' | 'RECLAIMED' | 'FAILED' | 'INVALIDATED';

export interface SweepRecord {
  level: number;
  /** M15 bar that first traded beyond the level (open / close time). */
  time: number;
  knownAt: number;
  /** Most extreme price beyond the level up to the reclaim (frozen once reclaimed). */
  extreme: number;
  extremeTime: number;
  penetration: number;
  /** Penetration ÷ level H1 ATR. */
  penetrationAtr: number;
  /** First M15 close back on the level's side (not yet by the reclaim margin). */
  closedBackAt: number | null;
}

export interface ReclaimRecord {
  time: number;
  knownAt: number;
  /** Reclaiming M15 close. */
  price: number;
  /** M15 bars from the sweep bar to the reclaim bar, inclusive. */
  bars: number;
  /** Reclaim close distance from the H1 level (≥ 0). */
  distance: number;
}

export interface DisplacementEvidence {
  /** Break close − sweep extreme (BUY) / sweep extreme − break close (SELL). */
  legSize: number;
  legAtr: number;
  maxBody: number;
  maxBodyAtr: number;
  bars: number;
  /** M5 ATR at the break bar. */
  atr: number;
}

export interface M5Confirmation {
  kind: 'BOS' | 'CHOCH';
  brokenLevel: number;
  swingTime: number;
  time: number;
  knownAt: number;
  close: number;
  displacement: DisplacementEvidence;
}

export type ZoneSource = 'OB+FVG' | 'OB' | 'FVG';
export interface EntryZone {
  source: ZoneSource;
  low: number;
  high: number;
  /** Order Block (Order Blocks v1 output) the zone comes from, if any. */
  orderBlockId: string | null;
  orderBlockTf: 'M5' | 'M1' | null;
  fvg: { low: number; high: number; time: number } | null;
  /** Known at the M5 confirmation close. */
  definedAt: number;
}

export interface RiskPlan {
  entry: number;
  stop: number;
  /** The sweep extreme — a close beyond it ends the idea. */
  invalidation: number;
  tp1: number;
  tp1Source: string;
  tp2: number | null;
  tp2Source: string;
  risk: number;
  rr1: number;
  rr2: number | null;
}

export interface EntryEvent {
  time: number;
  knownAt: number;
  price: number;
}

export type SetupState =
  | 'WATCHING_LEVEL'
  | 'LIQUIDITY_TAKEN'
  | 'RECLAIMED'
  | 'M5_CONFIRMATION_PENDING'
  | 'M5_CONFIRMED'
  | 'M1_PULLBACK_PENDING'
  | 'ENTRY_READY'
  | 'TRIGGERED'
  | 'FAILED_RECLAIM'
  | 'INVALIDATED'
  | 'MISSED'
  | 'EXPIRED';

export const TERMINAL_STATES: readonly SetupState[] = ['TRIGGERED', 'FAILED_RECLAIM', 'INVALIDATED', 'MISSED', 'EXPIRED'];

export type EntryStatus = 'WAIT' | 'SETUP_FORMING' | 'PULLBACK_WAIT' | 'ENTRY_READY' | 'TRIGGERED' | 'MISSED' | 'INVALIDATED' | 'EXPIRED';

export interface StateChange {
  from: SetupState | null;
  to: SetupState;
  /** Knowledge time (close of the bar that caused it). */
  time: number;
  reason: string;
}

export type HLRScoreKey = 'htfAlignment' | 'liquiditySweep' | 'reclaim' | 'm5Structure' | 'displacement' | 'entryQuality' | 'riskReward' | 'freshness';
export interface HLRScore {
  components: Record<HLRScoreKey, number>;
  weights: Readonly<Record<HLRScoreKey, number>>;
  contributions: Record<HLRScoreKey, number>;
  /** 0–100 descriptive setup quality. NOT a probability; never overrides a missing gate. */
  total: number;
}

export interface Setup {
  /** instrument:HLR:BUY|SELL:levelTime */
  id: string;
  instrumentId: InstrumentId;
  direction: Direction;
  levelId: string;
  level: number;
  levelTime: number;
  levelConfirmedAt: number;
  levelSignificance: number;
  levelEquals: number;
  state: SetupState;
  entryStatus: EntryStatus;
  stateHistory: StateChange[];
  liquidity: LiquidityStatus;
  touchedAt: number | null;
  /** H4 context when liquidity was taken (null before). */
  h4AtSweep: H4State | null;
  counterTrend: boolean | null;
  sweep: SweepRecord | null;
  reclaim: ReclaimRecord | null;
  m5: M5Confirmation | null;
  /** M5 breaks in the right direction that lacked displacement (evidence only). */
  rejectedBreaks: number;
  zone: EntryZone | null;
  /** Why no entry zone exists after confirmation (null otherwise). */
  zoneNote: string | null;
  risk: RiskPlan | null;
  entry: EntryEvent | null;
  triggeredAt: number | null;
  /** Level confirmation (the setup starts being watched). */
  detectedAt: number;
  lastUpdate: number;
  /** Bars spent in the current stage (on that stage's timeframe). */
  stageBars: number;
  /** Timeframe the setup currently waits on. */
  stageTf: HLRTimeframe;
  distance: number | null;
  score: HLRScore;
}

export interface HLREvent {
  time: number;
  setupId: string;
  direction: Direction;
  from: SetupState | null;
  to: SetupState;
  reason: string;
}

export type HLRDataState = 'NO_DATA' | 'INSUFFICIENT_HISTORY' | 'READY';

export interface HLRTfStatus {
  state: HLRDataState;
  bars: number;
  required: number;
  lastClosedTime: number | null;
  atr: number | null;
  rejected: number;
}

export interface HLRSnapshot {
  instrumentId: InstrumentId;
  state: HLRDataState;
  /** Latest knowledge time processed (close time of the newest closed bar). */
  knowledgeTime: number | null;
  price: number | null;
  timeframes: Record<HLRTimeframe, HLRTfStatus>;
  h4: H4Context;
  m5Trend: 'up' | 'down' | null;
  levels: KeyLevel[];
  setups: Setup[];
  events: HLREvent[];
  settingsKey: string;
}
