import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import type { VPScoreKey } from './config';

/** Which volume a profile is built from — never mixed inside one profile. */
export type VolumeMode = 'EXCHANGE' | 'MT5_REAL' | 'MT5_TICK' | 'NONE';
export interface VolumeSource {
  mode: VolumeMode;
  /** e.g. "COMEX Exchange Volume", "MT5 Tick Volume", "VOLUME DATA UNAVAILABLE". */
  label: string;
  detail: string;
  /** Bars whose chosen volume was usable / missing (missing bars are excluded, never filled). */
  usedBars: number;
  missingBars: number;
}

export type ProfileKind = 'CURRENT_SESSION' | 'PREVIOUS_SESSION' | 'ASIA' | 'LONDON' | 'NEW_YORK' | 'DAILY' | 'PREVIOUS_DAY' | 'WEEKLY' | 'PREVIOUS_WEEK' | 'TF' | 'RANGE';

export interface ProfileRow {
  /** Row lower edge. */
  price: number;
  volume: number;
}

export type NodeState = 'ACTIVE' | 'TESTED' | 'BROKEN' | 'EXPIRED';
export interface VolumeNode {
  id: string;
  type: 'HVN' | 'LVN';
  low: number;
  high: number;
  price: number;
  /** Smoothed volume relative to the profile's smoothed maximum (0–1). */
  relVolume: number;
  volume: number;
  /** 0–1 (HVN: relative volume; LVN: depth versus its flanks). */
  strength: number;
  strengthLabel: 'Strong' | 'Medium' | 'Weak';
  profileId: string;
  profileKind: ProfileKind;
  /** Profile start (s). */
  createdAt: number;
  /** Close time of the profile's last bar when the profile completed; null = developing. */
  confirmedAt: number | null;
  validFrom: number | null;
  developing: boolean;
  state: NodeState;
  testedAt: number | null;
  brokenAt: number | null;
  evidence: string;
}

export interface VolumeProfile {
  id: string;
  kind: ProfileKind;
  label: string;
  instrumentId: InstrumentId;
  /** Candle timeframe the profile is built from. */
  resolution: Timeframe;
  /** Window [from, to) in s; `to` may be in the future for a developing profile. */
  from: number;
  to: number;
  complete: boolean;
  bars: number;
  firstBar: number | null;
  lastBarClose: number | null;
  binSize: number;
  rows: ProfileRow[];
  total: number;
  poc: number | null;
  pocVolume: number;
  vah: number | null;
  val: number | null;
  vaVolume: number;
  /** Achieved value-area share (≥ target). */
  vaShare: number;
  valueAreaTarget: number;
  high: number | null;
  low: number | null;
  source: VolumeSource;
  hvn: VolumeNode[];
  lvn: VolumeNode[];
  /** Profile has bars but they do not cover the whole window (late start / gaps). */
  partial: boolean;
}

export type PriceLocation = 'ABOVE VALUE' | 'UPPER VALUE' | 'NEAR POC' | 'LOWER VALUE' | 'BELOW VALUE';
export interface LocationInfo {
  location: PriceLocation;
  price: number;
  distPoc: number;
  distVah: number;
  distVal: number;
  distPocAtr: number | null;
  distVahAtr: number | null;
  distValAtr: number | null;
}

export type AcceptanceState =
  | 'ACCEPTED ABOVE VAH'
  | 'REJECTED ABOVE VAH'
  | 'ACCEPTED BELOW VAL'
  | 'REJECTED BELOW VAL'
  | 'POC ACCEPTANCE'
  | 'POC REJECTION'
  | 'ROTATING INSIDE VALUE'
  | 'BREAKING FROM VALUE'
  | 'NO CONFIRMATION';
export interface Acceptance {
  state: AcceptanceState;
  referenceId: string;
  referenceLabel: string;
  evidence: string;
  /** Close time of the bar that established the state (s). */
  at: number | null;
}
export type ProfileState = 'BALANCED' | 'IMBALANCED UP' | 'IMBALANCED DOWN' | 'TRANSITION' | 'NO DATA';

export interface MtfRow {
  timeframe: Timeframe;
  available: boolean;
  bars: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  location: PriceLocation | null;
  nearestHvn: number | null;
  nearestLvn: number | null;
  context: string;
  source: VolumeSource;
}

export type VPEventType = 'NEW POC' | 'POC SHIFTED' | 'VAH TESTED' | 'VAL TESTED' | 'VAH REJECTED' | 'VAL RECLAIMED' | 'HVN CREATED' | 'LVN CREATED' | 'VALUE BREAK' | 'VALUE RE-ENTRY' | 'DATA REVISED';
export interface VPEvent {
  id: string;
  time: number;
  instrumentId: InstrumentId;
  type: VPEventType;
  price: number | null;
  profile: string;
  message: string;
  superseded?: boolean;
}

export interface KeyLevel {
  id: string;
  label: string;
  kind: 'POC' | 'VAH' | 'VAL' | 'HVN' | 'LVN';
  price: number;
  profileId: string;
  profileLabel: string;
  /** Deterministic rank score (0–100): profile weight × level weight × freshness. Not a trade rating. */
  importance: number;
  distanceAtr: number | null;
  state: NodeState | 'LEVEL';
}

export interface ConfluenceItem {
  id: string;
  level: string;
  price: number;
  with: string;
  engine: string;
  detail: string;
  strength: 'High' | 'Medium';
}

export interface VPScore {
  components: Record<VPScoreKey, number>;
  evidence: Record<VPScoreKey, string>;
  total: number | null;
  uncapped: number | null;
  missing: string[];
  note: string;
}

export interface VPSnapshot {
  instrumentId: InstrumentId;
  knowledgeTime: number | null;
  price: number | null;
  atr: number | null;
  /** Source of the headline (current session) profile. */
  source: VolumeSource;
  /** Instrument-level availability message (e.g. GC VOLUME DATA UNAVAILABLE). */
  unavailable: string | null;
  profiles: Partial<Record<ProfileKind, VolumeProfile>>;
  sessionName: string | null;
  location: LocationInfo | null;
  acceptance: Acceptance | null;
  sessionAcceptance: Acceptance | null;
  profileState: ProfileState;
  nodes: VolumeNode[];
  mtf: MtfRow[];
  keyLevels: KeyLevel[];
  events: VPEvent[];
  settingsKey: string;
}
