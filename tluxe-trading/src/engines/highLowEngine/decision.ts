import { DEFAULT_HLE_SETTINGS } from './config';
import { mandatoryGates } from './engine';
import type { BlockerCode, Candidate, EntryZone, HLESnapshot, Level, RiskPlan, Setup, Side } from './types';

/**
 * The published signal (handoff §9). The engine snapshot is feed-agnostic (so replay and the
 * anti-repaint audit are pure); THIS layer applies the feed gate: a complete setup is only
 * BUY / SELL CONFIRMED on a LIVE feed (or in replay, which is historical by definition). On a
 * stale / disconnected feed it is WAITING with DATA_STALE / DISCONNECTED and Entry / SL / TP are
 * withheld. The score is never read here.
 */
export type HLEFeed = 'LIVE' | 'STALE' | 'DISCONNECTED' | 'REPLAY';
export type HLESignal = 'NO_DATA' | 'NO_SETUP' | 'WATCHING_BUY' | 'WATCHING_SELL' | 'WAITING' | 'BUY_CONFIRMED' | 'SELL_CONFIRMED' | 'INVALIDATED';

export const SIGNAL_LABEL: Record<HLESignal, string> = {
  NO_DATA: 'NO DATA',
  NO_SETUP: 'NO SETUP',
  WATCHING_BUY: 'WATCHING BUY',
  WATCHING_SELL: 'WATCHING SELL',
  WAITING: 'WAIT',
  BUY_CONFIRMED: 'BUY CONFIRMED',
  SELL_CONFIRMED: 'SELL CONFIRMED',
  INVALIDATED: 'INVALIDATED',
};

export interface MandatoryRow {
  key: 'level' | 'sweep' | 'reclaim' | 'm5' | 'pullback' | 'target';
  label: string;
  pass: boolean;
}
export interface HLEDecision {
  signal: HLESignal;
  label: string;
  code: BlockerCode;
  why: string;
  direction: Side | null;
  confirmed: boolean;
  signalsLive: boolean;
  stage: number;
  candidate: Candidate | null;
  setup: Setup | null;
  level: Level | null;
  mandatory: MandatoryRow[];
  /** Only when confirmed (withheld otherwise, handoff §9.3). */
  tradeLevels: (RiskPlan & { zone: EntryZone }) | null;
  conflicts: string[];
}

export function mandatoryRows(side: Side, setup: Setup | null, level: Level | null): MandatoryRow[] {
  const buy = side === 'BUY';
  const g = setup ? mandatoryGates(setup) : null;
  return [
    { key: 'level', label: `${buy ? 'Important low' : 'Important high'} reached (H1)`, pass: g ? g.level : !!level && level.touchedAt !== null },
    { key: 'sweep', label: `${buy ? 'Sell-side (SSL)' : 'Buy-side (BSL)'} liquidity swept (M15)`, pass: !!g?.sweep },
    { key: 'reclaim', label: 'M15 close back through the level', pass: !!g?.reclaim },
    { key: 'm5', label: `${buy ? 'Bullish' : 'Bearish'} M5 CHOCH/BOS on a closed candle`, pass: !!g?.m5 },
    { key: 'pullback', label: 'M1 pullback into the entry zone', pass: !!g?.pullback },
    { key: 'target', label: 'Opposing liquidity target exists', pass: !!g?.target },
  ];
}

export function hleDecision(snap: HLESnapshot | null, feed: HLEFeed): HLEDecision {
  const signalsLive = feed === 'LIVE' || feed === 'REPLAY';
  const base = { signalsLive, candidate: null, setup: null, level: null, tradeLevels: null, conflicts: [] as string[], confirmed: false, direction: null, stage: 0 };
  if (!snap || snap.state !== 'READY') {
    const why = snap?.reason ? `Waiting for data — ${snap.reason}.` : 'No closed candles yet.';
    return { ...base, signal: 'NO_DATA', label: SIGNAL_LABEL.NO_DATA, code: 'NO_DATA', why, mandatory: mandatoryRows('BUY', null, null) };
  }
  const side: Side = snap.pick ?? (snap.candidates.BUY.stage >= snap.candidates.SELL.stage ? 'BUY' : 'SELL');
  const cand = snap.candidates[side];
  const setup = cand.setupId ? (snap.setups.find((s) => s.id === cand.setupId) ?? null) : null;
  const level = cand.levelId ? (snap.levels.find((l) => l.id === cand.levelId) ?? null) : null;
  const mandatory = mandatoryRows(side, setup, level);
  const allPass = mandatory.every((m) => m.pass);
  let signal: HLESignal;
  let code: BlockerCode = cand.code;
  let why = cand.why;
  if (cand.invalidated) signal = 'INVALIDATED';
  else if (allPass && cand.stage >= 5) {
    if (!signalsLive) {
      signal = 'WAITING';
      code = feed === 'STALE' ? 'DATA_STALE' : 'DISCONNECTED';
      why = `A complete ${side} setup is being withheld: the MT5 feed is ${feed === 'STALE' ? 'stale' : 'not connected'}. Nothing is confirmed on untrustworthy data.`;
    } else signal = side === 'BUY' ? 'BUY_CONFIRMED' : 'SELL_CONFIRMED';
  } else if (cand.stage >= 2) signal = 'WAITING';
  else if (cand.stage >= 1) signal = side === 'BUY' ? 'WATCHING_BUY' : 'WATCHING_SELL';
  else signal = 'NO_SETUP';
  const confirmed = signal === 'BUY_CONFIRMED' || signal === 'SELL_CONFIRMED';
  const direction = cand.stage > 0 || cand.invalidated ? side : null;
  const conflicts: string[] = [];
  const dir = side === 'BUY' ? 1 : -1;
  const h4dir = setup?.context ? setup.context.h4Dir : snap.h4.dir;
  if (direction && h4dir !== 0 && h4dir !== dir) conflicts.push(`H4 structure is ${setup?.context?.h4 ?? snap.h4.raw}, against this ${side} (counter-trend — allowed, scored lower).`);
  if (setup?.risk?.belowMinRR) conflicts.push(`R:R to TP1 is ${setup.risk.rr1.toFixed(2)}, below ${DEFAULT_HLE_SETTINGS.minRR} — reported only, never blocks.`);
  if (setup?.m5?.preSweepSwing) conflicts.push('The M5 break was measured against a swing that formed before the sweep (no newer swing existed).');
  return {
    signal,
    label: SIGNAL_LABEL[signal],
    code: confirmed ? 'NONE' : code,
    why: confirmed ? 'Every mandatory condition passed on a live feed.' : why,
    direction,
    confirmed,
    signalsLive,
    stage: cand.stage,
    candidate: cand,
    setup,
    level,
    mandatory,
    tradeLevels: confirmed && setup?.risk && setup.zone ? { ...setup.risk, zone: setup.zone } : null,
    conflicts,
  };
}

/** PRE-ENTRY (derived, never a signal, handoff §9.4): M5 confirmed + zone defined, waiting for the M1 pullback, on a live feed. */
export function isPreEntry(d: HLEDecision): boolean {
  const s = d.setup;
  return d.signalsLive && !d.confirmed && d.signal === 'WAITING' && d.code === 'WAITING_PULLBACK' && !!s && s.state === 'WAITING_M1' && !!s.m5 && !!s.zone && !s.entry;
}
