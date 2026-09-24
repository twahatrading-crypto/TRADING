import { HLE_TF_SECONDS, HLE_TIMEFRAMES } from '../../engines/highLowEngine/config';
import { levelLabel } from '../../engines/highLowEngine/engine';
import type { HLESnapshot, HLETimeframe, Level, LevelType, Setup, SetupState } from '../../engines/highLowEngine/types';
import { TERMINAL } from '../../engines/highLowEngine/types';
import type { ConnectionState, FeedStatusCode } from '../../types/market';
import { formatPrice } from '../../utils/format';

/* ------------------------------ data state ------------------------------ */

export type HLEViewState = 'LIVE' | 'REPLAY' | 'INSUFFICIENT_DATA' | 'DEPENDENCY_UNAVAILABLE' | 'STALE' | 'OFFLINE' | 'ERROR' | 'UNAVAILABLE';
export const HLE_VIEW_TITLE: Record<HLEViewState, string> = {
  LIVE: 'LIVE',
  REPLAY: 'REPLAY',
  INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY DATA UNAVAILABLE',
  STALE: 'DATA STALE',
  OFFLINE: 'MARKET DATA OFFLINE',
  ERROR: 'ERROR',
  UNAVAILABLE: 'DATA UNAVAILABLE',
};

/** Truthful page state: LIVE only with a live feed and every timeframe READY. Never falls back to generated data. */
export function hleViewState(o: { tradable: boolean; connection: ConnectionState; feedCode?: FeedStatusCode | null; snapshot: HLESnapshot | null; replay?: boolean }): HLEViewState {
  if (!o.tradable) return 'UNAVAILABLE';
  const snap = o.snapshot;
  const tfs = snap ? HLE_TIMEFRAMES.map((tf) => snap.timeframes[tf].state) : [];
  const anyData = tfs.some((s) => s !== 'NO_DATA');
  const missing = tfs.some((s) => s === 'NO_DATA');
  if (o.replay) return snap?.state === 'READY' ? 'REPLAY' : anyData && missing ? 'DEPENDENCY_UNAVAILABLE' : 'INSUFFICIENT_DATA';
  if (o.feedCode === 'ERROR') return 'ERROR';
  const live = (o.connection === 'LIVE' || o.connection === 'DELAYED') && o.feedCode !== 'STALE';
  if (!anyData) return live ? 'INSUFFICIENT_DATA' : 'OFFLINE';
  if (missing) return 'DEPENDENCY_UNAVAILABLE';
  if (snap!.state !== 'READY') return 'INSUFFICIENT_DATA';
  return live ? 'LIVE' : 'STALE';
}
export const hasData = (s: HLEViewState) => s === 'LIVE' || s === 'STALE' || s === 'REPLAY';

/* ------------------------------ setups ------------------------------ */

const RANK: Record<SetupState, number> = { ENTRY_READY: 0, WAITING_M1: 1, M5_CONFIRMED: 2, WAITING_M5: 3, RECLAIMED: 4, SWEPT: 5, LIQUIDITY_APPROACH: 6, LEVEL_ACTIVE: 7, INVALIDATED: 8, EXPIRED: 8 };
export const isOpen = (s: Setup) => !TERMINAL.includes(s.state);

/**
 * The setup the page follows: the most advanced open setup that has swept liquidity; otherwise
 * the setup with the most recent sweep; otherwise the nearest approached / watched level.
 */
export function focusSetup(setups: readonly Setup[], price: number | null): Setup | null {
  const open = setups.filter(isOpen).sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastUpdate - a.lastUpdate || (a.id < b.id ? -1 : 1));
  // Proximity alone (LEVEL_ACTIVE / LIQUIDITY_APPROACH) never outranks real liquidity evidence.
  if (open[0] && open[0].state !== 'LEVEL_ACTIVE' && open[0].state !== 'LIQUIDITY_APPROACH') return open[0];
  // Most recent real liquidity event (sweep time), not whichever setup happened to expire last.
  const recent = setups.filter((s) => !isOpen(s) && s.sweep).sort((a, b) => b.sweep!.knownAt - a.sweep!.knownAt || (a.id < b.id ? -1 : 1))[0];
  if (recent) return recent;
  return open.sort((a, b) => Math.abs(a.level - (price ?? a.level)) - Math.abs(b.level - (price ?? b.level)))[0] ?? null;
}

export const STATE_LABEL: Record<SetupState, string> = {
  LEVEL_ACTIVE: 'LEVEL ACTIVE',
  LIQUIDITY_APPROACH: 'APPROACHING',
  SWEPT: 'SWEPT',
  RECLAIMED: 'RECLAIMED',
  WAITING_M5: 'WAITING M5',
  M5_CONFIRMED: 'M5 CONFIRMED',
  WAITING_M1: 'WAITING M1',
  ENTRY_READY: 'ENTRY READY',
  INVALIDATED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
};

/** The single next condition the engine needs (from the setup's own state). */
export function nextRequired(s: Setup, d: number): string {
  const buy = s.side === 'BUY';
  switch (s.state) {
    case 'LEVEL_ACTIVE':
    case 'LIQUIDITY_APPROACH':
      return `M15 must trade ${buy ? 'below' : 'above'} ${formatPrice(s.level, d)} (${buy ? 'SSL' : 'BSL'})`;
    case 'SWEPT':
      return `M15 close back ${buy ? 'above' : 'below'} ${formatPrice(s.level, d)} (reclaim)`;
    case 'RECLAIMED':
    case 'WAITING_M5':
      return `M5 ${buy ? 'bullish' : 'bearish'} CHOCH / BOS on a closed candle`;
    case 'M5_CONFIRMED':
    case 'WAITING_M1':
      return `M1 pullback into ${formatPrice(s.zone!.low, d)} – ${formatPrice(s.zone!.high, d)}`;
    case 'ENTRY_READY':
      return `${s.side} CONFIRMED — every mandatory stage complete`;
    default:
      return 'None — setup finished';
  }
}

/* --------------------------- setup sequence --------------------------- */

export type StepStatus = 'done' | 'active' | 'pending' | 'failed';
export function sequence(s: Setup | null): { side: 'BUY' | 'SELL'; steps: { label: string; status: StepStatus }[] } {
  const side = s?.side ?? 'BUY';
  const buy = side === 'BUY';
  const dead = !!s && TERMINAL.includes(s.state) && !s.entry;
  const st = (done: boolean, active: boolean): StepStatus => (done ? 'done' : dead ? 'failed' : active ? 'active' : 'pending');
  return {
    side,
    steps: [
      { label: buy ? 'Important Low' : 'Important High', status: s ? 'done' : 'pending' },
      { label: buy ? 'SSL Sweep' : 'BSL Sweep', status: st(!!s?.reclaim, !!s) },
      { label: buy ? 'Bullish CHOCH/BOS' : 'Bearish CHOCH/BOS', status: st(!!s?.m5, !!s?.reclaim) },
      { label: 'Pullback (M1)', status: st(!!s?.entry, !!s?.m5) },
      { label: buy ? 'BUY Confirmed' : 'SELL Confirmed', status: st(!!s?.entry, !!s?.m5) },
    ],
  };
}

/* ------------------------------- levels ------------------------------- */

/** Latest level of each type (the H1 card); `null` when that type has no level yet. */
export function latestByType(levels: readonly Level[]): Record<LevelType, Level | null> {
  const out = { PDH: null, PDL: null, ASIA_HIGH: null, ASIA_LOW: null, SWING_HIGH: null, SWING_LOW: null } as Record<LevelType, Level | null>;
  for (const l of levels) if (!out[l.type] || l.createdAt > out[l.type]!.createdAt) out[l.type] = l;
  return out;
}
export const LEVEL_ORDER: LevelType[] = ['PDH', 'PDL', 'ASIA_HIGH', 'ASIA_LOW', 'SWING_HIGH', 'SWING_LOW'];
export { levelLabel };

/* --------------------------- chart overlays ---------------------------- */

export interface HLETools {
  levels: boolean;
  liquidity: boolean;
  sweeps: boolean;
  structure: boolean;
  risk: boolean;
}
export interface HLEDrawable {
  id: string;
  kind: 'level' | 'zone' | 'stop' | 'tp' | 'structure' | 'entry';
  tone: 'buy' | 'sell' | 'structure' | 'zone' | 'gold' | 'muted';
  low: number;
  high: number;
  from: number;
  to: number | null;
  label: string;
  dashed: boolean;
  emphasis: boolean;
}
export interface HLEMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text: string;
}

const alignTo = (t: number, tf: HLETimeframe) => Math.floor(t / HLE_TF_SECONDS[tf]) * HLE_TF_SECONDS[tf];

/** Chart overlays — actual engine outputs only, filtered by the Tools toggles. */
export function hleOverlays(o: { levels: readonly Level[]; selected: Setup | null; chartTf: HLETimeframe; decimals: number; tools: HLETools }): { drawables: HLEDrawable[]; markers: HLEMarker[] } {
  const d = o.decimals;
  const out: HLEDrawable[] = [];
  const s = o.selected;
  const own = new Set(s?.levelIds ?? []);
  for (const l of o.levels) {
    if (l.status !== 'ACTIVE' && !own.has(l.id)) continue;
    const isSwing = l.type === 'SWING_HIGH' || l.type === 'SWING_LOW';
    if ((isSwing && !o.tools.levels) || (!isSwing && !o.tools.liquidity)) continue;
    const broken = l.status === 'BROKEN' || l.status === 'SWEPT';
    out.push({
      id: l.id,
      kind: 'level',
      tone: own.has(l.id) ? 'gold' : l.kind === 'high' ? 'sell' : 'buy',
      low: l.price,
      high: l.price,
      from: l.sourceTime,
      to: null,
      label: `${levelLabel(l.type)} ${formatPrice(l.price, d)}${broken ? ` (${l.status.toLowerCase()})` : ''} · ${l.kind === 'high' ? 'BSL' : 'SSL'}`,
      dashed: !own.has(l.id),
      emphasis: own.has(l.id),
    });
  }
  const markers: HLEMarker[] = [];
  if (s) {
    const buy = s.side === 'BUY';
    if (s.m5 && o.tools.structure) out.push({ id: `${s.id}:bos`, kind: 'structure', tone: 'structure', low: s.m5.brokenLevel, high: s.m5.brokenLevel, from: s.m5.swingTime, to: s.m5.time, label: `M5 ${s.m5.kind}`, dashed: false, emphasis: true });
    if (s.risk && o.tools.risk) {
      const from = s.zone!.definedAt;
      out.push({ id: `${s.id}:zone`, kind: 'zone', tone: 'zone', low: s.zone!.low, high: s.zone!.high, from, to: null, label: `Entry ${formatPrice(s.risk.entry, d)} (${s.zone!.source})`, dashed: false, emphasis: true });
      out.push({ id: `${s.id}:sl`, kind: 'stop', tone: 'sell', low: s.risk.stop, high: s.risk.stop, from, to: null, label: `SL ${formatPrice(s.risk.stop, d)}`, dashed: true, emphasis: false });
      if (s.risk.tp1 !== null) out.push({ id: `${s.id}:tp1`, kind: 'tp', tone: 'buy', low: s.risk.tp1, high: s.risk.tp1, from, to: null, label: `TP1 ${formatPrice(s.risk.tp1, d)}`, dashed: true, emphasis: false });
      if (s.risk.tp2 !== null) out.push({ id: `${s.id}:tp2`, kind: 'tp', tone: 'buy', low: s.risk.tp2, high: s.risk.tp2, from, to: null, label: `TP2 ${formatPrice(s.risk.tp2, d)}`, dashed: true, emphasis: false });
    }
    const side = buy ? 'belowBar' : 'aboveBar';
    if (s.sweep && o.tools.sweeps) {
      markers.push({ time: alignTo(s.sweep.extremeTime, o.chartTf), position: side, shape: buy ? 'arrowUp' : 'arrowDown', color: buy ? '#3cc9a0' : '#ef5d5d', text: `${buy ? 'SSL' : 'BSL'} Sweep` });
      if (s.reclaim) markers.push({ time: alignTo(s.reclaim.time, o.chartTf), position: side, shape: 'circle', color: '#d4a94f', text: 'Reclaim' });
    }
    if (s.m5 && o.tools.structure) markers.push({ time: alignTo(s.m5.time, o.chartTf), position: buy ? 'aboveBar' : 'belowBar', shape: 'square', color: '#a78bfa', text: s.m5.kind });
    if (s.entry && o.tools.risk) markers.push({ time: alignTo(s.entry.time, o.chartTf), position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', color: '#5b8cff', text: `${s.side} Confirmed` });
  }
  const gap = 3 * HLE_TF_SECONDS[o.chartTf];
  const merged: HLEMarker[] = [];
  for (const m of [...markers].sort((a, b) => a.time - b.time)) {
    const e = [...merged].reverse().find((x) => x.position === m.position && m.time - x.time <= gap);
    if (e) e.text = [e.text, m.text].filter(Boolean).join(' · ');
    else merged.push({ ...m });
  }
  return { drawables: out, markers: merged };
}
