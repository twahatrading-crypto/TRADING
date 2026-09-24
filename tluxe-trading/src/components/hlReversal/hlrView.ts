import { HLR_TF_SECONDS, HLR_TIMEFRAMES } from '../../engines/hlReversal/config';
import type { Direction, HLREvent, HLRSnapshot, HLRTimeframe, KeyLevel, Setup, SetupState } from '../../engines/hlReversal/types';
import { TERMINAL_STATES } from '../../engines/hlReversal/types';
import type { ConnectionState, FeedStatusCode } from '../../types/market';
import { formatPrice } from '../../utils/format';

/* ------------------------------ data state ------------------------------ */

export type HLRViewState = 'LIVE' | 'REPLAY' | 'INSUFFICIENT_HISTORY' | 'DEPENDENCY_UNAVAILABLE' | 'STALE' | 'OFFLINE' | 'ERROR' | 'UNAVAILABLE';

export const HLR_VIEW_TITLE: Record<HLRViewState, string> = {
  LIVE: 'HIGH / LOW REVERSAL LIVE',
  REPLAY: 'HIGH / LOW REVERSAL REPLAY',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT HISTORY',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY DATA UNAVAILABLE',
  STALE: 'DATA STALE',
  OFFLINE: 'MARKET DATA OFFLINE',
  ERROR: 'ERROR',
  UNAVAILABLE: 'DATA UNAVAILABLE',
};

/**
 * Truthful page state. Setups are LIVE only with a live / delayed feed and every one of the
 * five timeframes READY. A timeframe with no data while others have data = DEPENDENCY DATA
 * UNAVAILABLE (the chain H4 → M1 cannot be evaluated without it).
 */
export function hlrViewState(o: { tradable: boolean; connection: ConnectionState; feedCode?: FeedStatusCode | null; snapshot: HLRSnapshot | null; replay?: boolean }): HLRViewState {
  if (!o.tradable) return 'UNAVAILABLE';
  const snap = o.snapshot;
  const tfs = snap ? HLR_TIMEFRAMES.map((tf) => snap.timeframes[tf].state) : [];
  const anyData = tfs.some((s) => s !== 'NO_DATA');
  const missing = tfs.some((s) => s === 'NO_DATA');
  if (o.replay) return snap?.state === 'READY' ? 'REPLAY' : anyData && missing ? 'DEPENDENCY_UNAVAILABLE' : 'INSUFFICIENT_HISTORY';
  if (o.feedCode === 'ERROR') return 'ERROR';
  const live = (o.connection === 'LIVE' || o.connection === 'DELAYED') && o.feedCode !== 'STALE';
  if (!anyData) return live ? 'INSUFFICIENT_HISTORY' : 'OFFLINE';
  if (missing) return 'DEPENDENCY_UNAVAILABLE';
  if (snap!.state !== 'READY') return 'INSUFFICIENT_HISTORY';
  return live ? 'LIVE' : 'STALE';
}

export const hasSetups = (s: HLRViewState) => s === 'LIVE' || s === 'STALE' || s === 'REPLAY';

/** Timeframes without data (for DEPENDENCY DATA UNAVAILABLE) / below the history minimum. */
export function missingTimeframes(snap: HLRSnapshot | null): { none: HLRTimeframe[]; short: HLRTimeframe[] } {
  if (!snap) return { none: [...HLR_TIMEFRAMES], short: [] };
  return {
    none: HLR_TIMEFRAMES.filter((tf) => snap.timeframes[tf].state === 'NO_DATA'),
    short: HLR_TIMEFRAMES.filter((tf) => snap.timeframes[tf].state === 'INSUFFICIENT_HISTORY'),
  };
}

/* ------------------------------ setup list ------------------------------ */

export type DirFilter = 'ALL' | Direction;
export type TfFilter = 'ALL' | HLRTimeframe;
export interface SetupFilters {
  dir: DirFilter;
  tf: TfFilter;
}

const RANK: Record<SetupState, number> = {
  ENTRY_READY: 0,
  M1_PULLBACK_PENDING: 1,
  M5_CONFIRMED: 2,
  M5_CONFIRMATION_PENDING: 3,
  RECLAIMED: 4,
  LIQUIDITY_TAKEN: 5,
  WATCHING_LEVEL: 6,
  TRIGGERED: 7,
  MISSED: 8,
  EXPIRED: 8,
  FAILED_RECLAIM: 8,
  INVALIDATED: 8,
};
export const isOpen = (s: Setup) => !TERMINAL_STATES.includes(s.state);

/** Setup List: open setups (most advanced first, then most recent); History: finished ones. */
export function listSetups(setups: readonly Setup[], f: SetupFilters, which: 'open' | 'history'): Setup[] {
  return setups
    .filter((s) => (which === 'open' ? isOpen(s) : !isOpen(s)) && (f.dir === 'ALL' || s.direction === f.dir) && (f.tf === 'ALL' || s.stageTf === f.tf))
    .sort((a, b) => (which === 'open' ? RANK[a.state] - RANK[b.state] : 0) || b.lastUpdate - a.lastUpdate || (a.id < b.id ? -1 : 1));
}

/** The open setup furthest along the chain (null when none is open). */
export function activeSetup(setups: readonly Setup[]): Setup | null {
  const open = listSetups(setups, { dir: 'ALL', tf: 'ALL' }, 'open');
  return open[0] ?? null;
}

/**
 * What the page follows when the user has selected nothing: an open setup past WATCHING;
 * otherwise the most recent finished setup that actually swept liquidity (so the latest
 * real event stays visible); otherwise the nearest watched level.
 */
export function defaultSetup(setups: readonly Setup[]): Setup | null {
  const active = activeSetup(setups);
  if (active && active.state !== 'WATCHING_LEVEL') return active;
  const recent = listSetups(setups, { dir: 'ALL', tf: 'ALL' }, 'history').find((s) => s.sweep);
  return recent ?? active;
}

export const STATE_LABEL: Record<SetupState, string> = {
  WATCHING_LEVEL: 'WAIT · WATCHING',
  LIQUIDITY_TAKEN: 'LIQUIDITY TAKEN',
  RECLAIMED: 'RECLAIMED',
  M5_CONFIRMATION_PENDING: 'M5 PENDING',
  M5_CONFIRMED: 'M5 CONFIRMED',
  M1_PULLBACK_PENDING: 'PULLBACK WAIT',
  ENTRY_READY: 'ENTRY READY',
  TRIGGERED: 'TRIGGERED',
  FAILED_RECLAIM: 'FAILED RECLAIM',
  INVALIDATED: 'INVALIDATED',
  MISSED: 'MISSED',
  EXPIRED: 'EXPIRED',
};

/** The single next condition the engine is waiting for (from the setup's own state and records). */
export function nextRequired(s: Setup, d: number): string {
  const up = s.direction === 'BUY';
  const lvl = formatPrice(s.level, d);
  switch (s.state) {
    case 'WATCHING_LEVEL':
      return `M15 must trade ${up ? 'below' : 'above'} the H1 ${up ? 'low' : 'high'} ${lvl} (${up ? 'sell' : 'buy'}-side liquidity)`;
    case 'LIQUIDITY_TAKEN':
      return `M15 close back ${up ? 'above' : 'below'} ${lvl} (reclaim)`;
    case 'RECLAIMED':
    case 'M5_CONFIRMATION_PENDING':
      return `M5 ${up ? 'bullish' : 'bearish'} CHOCH / BOS close with displacement`;
    case 'M5_CONFIRMED':
      return s.zoneNote ? `No entry zone — ${s.zoneNote}` : 'Entry zone';
    case 'M1_PULLBACK_PENDING':
      return `M1 pullback into ${formatPrice(s.zone!.low, d)} – ${formatPrice(s.zone!.high, d)}`;
    case 'ENTRY_READY':
      return `M1 close back ${up ? 'above' : 'below'} ${formatPrice(up ? s.zone!.high : s.zone!.low, d)} (reaction)`;
    default:
      return 'None — setup finished';
  }
}

/* ------------------------------ 5-stage chain ----------------------------- */

export type StageStatus = 'done' | 'active' | 'pending' | 'failed';
export interface Stage {
  n: number;
  tf: HLRTimeframe;
  title: string;
  status: StageStatus;
  value: string;
}

export function stages(s: Setup | null, h4: HLRSnapshot['h4'] | null, d: number): Stage[] {
  const dead = !!s && TERMINAL_STATES.includes(s.state) && s.state !== 'TRIGGERED';
  const st = (done: boolean, active: boolean): StageStatus => (done ? 'done' : dead ? 'failed' : active ? 'active' : 'pending');
  const h4Label = h4 ? (h4.state === 'INSUFFICIENT_DATA' ? 'Insufficient data' : h4.state[0] + h4.state.slice(1).toLowerCase()) : '—';
  return [
    { n: 1, tf: 'H4', title: 'H4 Direction', status: h4 && h4.state !== 'INSUFFICIENT_DATA' ? 'done' : 'pending', value: h4Label + (s?.counterTrend ? ' (counter-trend)' : '') },
    { n: 2, tf: 'H1', title: 'H1 Key Level', status: s ? 'done' : 'pending', value: s ? `${s.direction === 'BUY' ? 'Major low' : 'Major high'} ${formatPrice(s.level, d)}` : '—' },
    { n: 3, tf: 'M15', title: 'M15 Sweep + Reclaim', status: st(!!s?.reclaim, !!s && !s.reclaim), value: s?.reclaim ? 'Swept + reclaimed' : s?.sweep ? 'Liquidity taken' : 'Waiting' },
    { n: 4, tf: 'M5', title: 'M5 Confirmation', status: st(!!s?.m5, !!s?.reclaim && !s.m5), value: s?.m5 ? `${s.m5.kind} ✓` : s?.reclaim ? 'Pending' : '—' },
    { n: 5, tf: 'M1', title: 'M1 Entry', status: st(!!s?.entry, !!s?.m5 && !s.entry), value: s?.entry ? (s.state === 'TRIGGERED' ? 'Triggered' : 'Ready') : s?.zone ? 'Pullback wait' : '—' },
  ];
}

/* --------------------------- chart overlays ---------------------------- */

export type HLRDrawKind = 'level' | 'zone' | 'entry' | 'stop' | 'tp' | 'structure';
export interface HLRDrawable {
  id: string;
  kind: HLRDrawKind;
  /** 'buy' green/teal, 'sell' red, 'structure' blue, 'zone' purple, 'gold' selected level. */
  tone: 'buy' | 'sell' | 'structure' | 'zone' | 'gold' | 'muted';
  low: number;
  high: number;
  from: number;
  to: number | null;
  label: string;
  dashed: boolean;
  emphasis: boolean;
}
export interface HLRMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text: string;
}

const alignTo = (t: number, tf: HLRTimeframe) => Math.floor(t / HLR_TF_SECONDS[tf]) * HLR_TF_SECONDS[tf];

/**
 * Chart overlays — real engine outputs only. Important H1 levels still being watched (nearest
 * few), and for the selected setup: its level, M5 broken structure, entry zone and risk lines.
 * Markers (sweep / reclaim / M5 break / entry) sit on the chart timeframe's own bar that
 * contains the event.
 */
export function hlrOverlays(o: { levels: readonly KeyLevel[]; setups: readonly Setup[]; selected: Setup | null; price: number | null; chartTf: HLRTimeframe; decimals: number; maxLevels?: number }): { drawables: HLRDrawable[]; markers: HLRMarker[] } {
  const d = o.decimals;
  const out: HLRDrawable[] = [];
  const watching = new Set(o.setups.filter((s) => s.state === 'WATCHING_LEVEL').map((s) => s.levelId));
  const lv = o.levels
    .filter((l) => watching.has(l.id) && l.id !== o.selected?.levelId)
    .sort((a, b) => Math.abs(a.price - (o.price ?? a.price)) - Math.abs(b.price - (o.price ?? b.price)) || (a.id < b.id ? -1 : 1))
    .slice(0, o.maxLevels ?? 4);
  for (const l of lv)
    out.push({ id: l.id, kind: 'level', tone: l.side === 'high' ? 'sell' : 'buy', low: l.price, high: l.price, from: l.time, to: null, label: `H1 Major ${l.side === 'high' ? 'High (BSL)' : 'Low (SSL)'} ${formatPrice(l.price, d)}`, dashed: true, emphasis: false });
  const markers: HLRMarker[] = [];
  const s = o.selected;
  if (s) {
    const buy = s.direction === 'BUY';
    out.push({ id: `${s.id}:lvl`, kind: 'level', tone: 'gold', low: s.level, high: s.level, from: s.levelTime, to: null, label: `H1 Major ${buy ? 'Low (SSL)' : 'High (BSL)'} ${formatPrice(s.level, d)}`, dashed: false, emphasis: true });
    if (s.m5) out.push({ id: `${s.id}:bos`, kind: 'structure', tone: 'structure', low: s.m5.brokenLevel, high: s.m5.brokenLevel, from: s.m5.swingTime, to: s.m5.time, label: `M5 ${s.m5.kind}`, dashed: false, emphasis: true });
    if (s.zone) out.push({ id: `${s.id}:zone`, kind: 'zone', tone: 'zone', low: s.zone.low, high: s.zone.high, from: s.zone.definedAt, to: s.triggeredAt ?? null, label: `Entry zone (${s.zone.source})`, dashed: false, emphasis: true });
    if (s.risk) {
      const from = s.zone!.definedAt;
      out.push({ id: `${s.id}:sl`, kind: 'stop', tone: 'sell', low: s.risk.stop, high: s.risk.stop, from, to: null, label: `SL ${formatPrice(s.risk.stop, d)}`, dashed: true, emphasis: false });
      out.push({ id: `${s.id}:tp1`, kind: 'tp', tone: 'buy', low: s.risk.tp1, high: s.risk.tp1, from, to: null, label: `TP1 ${formatPrice(s.risk.tp1, d)}`, dashed: true, emphasis: false });
      if (s.risk.tp2 !== null) out.push({ id: `${s.id}:tp2`, kind: 'tp', tone: 'buy', low: s.risk.tp2, high: s.risk.tp2, from, to: null, label: `TP2 ${formatPrice(s.risk.tp2, d)}`, dashed: true, emphasis: false });
    }
    const tf = o.chartTf;
    const side = buy ? 'belowBar' : 'aboveBar';
    const col = buy ? '#3cc9a0' : '#ef5d5d';
    if (s.sweep) markers.push({ time: alignTo(s.sweep.extremeTime, tf), position: side, shape: buy ? 'arrowUp' : 'arrowDown', color: col, text: `${buy ? 'SSL' : 'BSL'} Sweep` });
    if (s.reclaim) markers.push({ time: alignTo(s.reclaim.time, tf), position: side, shape: 'circle', color: '#d4a94f', text: 'Reclaim' });
    // The M5 break is labelled by its structure line; the marker only pins the bar.
    if (s.m5) markers.push({ time: alignTo(s.m5.time, tf), position: buy ? 'aboveBar' : 'belowBar', shape: 'square', color: '#5b8cff', text: '' });
    if (s.entry) markers.push({ time: alignTo(s.entry.time, tf), position: buy ? 'aboveBar' : 'belowBar', shape: buy ? 'arrowDown' : 'arrowUp', color: '#a78bfa', text: s.state === 'TRIGGERED' ? 'Entry · Triggered' : 'Entry Ready' });
    // Events within 3 chart bars on the same side merge into one marker so texts never overlap.
    const gap = 3 * HLR_TF_SECONDS[tf];
    const merged: HLRMarker[] = [];
    for (const m of [...markers].sort((a, b) => a.time - b.time)) {
      const e = [...merged].reverse().find((x) => x.position === m.position && m.time - x.time <= gap);
      if (e) e.text = [e.text, m.text].filter(Boolean).join(' · ');
      else merged.push({ ...m });
    }
    return { drawables: out, markers: merged };
  }
  return { drawables: out, markers };
}

/* ------------------------------ alerts log ------------------------------ */

export function alertEvents(events: readonly HLREvent[], max = 40): HLREvent[] {
  return [...events].filter((e) => e.to !== 'WATCHING_LEVEL').sort((a, b) => b.time - a.time).slice(0, max);
}

/** Candles for the snapshot mini-chart: the M5 bars around the setup's sweep → latest event. */
export function snapshotWindow<T extends { time: number }>(bars: readonly T[], s: Setup, max = 60): T[] {
  const start = (s.sweep?.time ?? s.levelConfirmedAt) - 12 * 300;
  const end = (s.entry?.knownAt ?? s.m5?.knownAt ?? s.reclaim?.knownAt ?? s.lastUpdate) + 10 * 300;
  const w = bars.filter((b) => b.time >= start && b.time <= end);
  return w.slice(-max);
}
