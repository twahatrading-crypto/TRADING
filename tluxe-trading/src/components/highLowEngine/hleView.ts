import { HLE_TF_SECONDS, HLE_TIMEFRAMES } from '../../engines/highLowEngine/config';
import type { HLEDecision, HLEFeed } from '../../engines/highLowEngine/decision';
import { levelLabel } from '../../engines/highLowEngine/engine';
import type { Candidate, HLESnapshot, HLETimeframe, Level, LevelType, Setup, Side } from '../../engines/highLowEngine/types';
import { hleFeedOf } from '../../services/highLowEngine/feed';
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

/** Truthful page state: LIVE only with a fresh feed and every timeframe READY. Never falls back to generated data. */
export function hleViewState(o: { tradable: boolean; connection: ConnectionState; feedCode?: FeedStatusCode | null; snapshot: HLESnapshot | null; replay?: boolean }): HLEViewState {
  if (!o.tradable) return 'UNAVAILABLE';
  const snap = o.snapshot;
  const tfs = snap ? HLE_TIMEFRAMES.map((tf) => snap.timeframes[tf].state) : [];
  const anyData = tfs.some((s) => s !== 'NO_DATA');
  const missing = tfs.some((s) => s === 'NO_DATA');
  if (o.replay) return snap?.state === 'READY' ? 'REPLAY' : anyData && missing ? 'DEPENDENCY_UNAVAILABLE' : 'INSUFFICIENT_DATA';
  if (o.feedCode === 'ERROR') return 'ERROR';
  const live = hleFeedOf(o.connection, o.feedCode) === 'LIVE';
  if (!anyData) return live ? 'INSUFFICIENT_DATA' : 'OFFLINE';
  if (missing) return 'DEPENDENCY_UNAVAILABLE';
  if (snap!.state !== 'READY') return 'INSUFFICIENT_DATA';
  return live ? 'LIVE' : 'STALE';
}
export const hasData = (s: HLEViewState) => s === 'LIVE' || s === 'STALE' || s === 'REPLAY';
/** Feed gate for the decision layer. Replay is historical by definition. */
export function feedForView(v: HLEViewState, connection: ConnectionState, feedCode: FeedStatusCode | null | undefined): HLEFeed {
  if (v === 'REPLAY') return 'REPLAY';
  return hleFeedOf(connection, feedCode);
}

/* --------------------------- setup sequence --------------------------- */

export type StepState = 'PENDING' | 'ACTIVE' | 'DONE' | 'DEAD';
const STEPS = [
  { n: 1, buy: 'Important Low', sell: 'Important High' },
  { n: 2, buy: 'SSL Swept', sell: 'BSL Swept' },
  { n: 3, buy: 'Bullish CHOCH/BOS', sell: 'Bearish CHOCH/BOS' },
  { n: 4, buy: 'Pullback (M1)', sell: 'Pullback (M1)' },
  { n: 5, buy: 'BUY Confirmed', sell: 'SELL Confirmed' },
];
/** Pipeline boxes for one direction (handoff §8.4). The last box lights only on the real, live confirmation. */
export function pipeline(c: Candidate | null, side: Side, confirmed: boolean): { label: string; state: StepState }[] {
  const reached = c?.stage ?? 0;
  const dead = !!c?.invalidated;
  return STEPS.map((s) => {
    let state: StepState;
    if (s.n === 5) state = confirmed ? 'DONE' : reached >= 5 ? (dead ? 'DEAD' : 'ACTIVE') : 'PENDING';
    else if (s.n <= reached) state = dead ? 'DEAD' : 'DONE';
    else if (!dead && reached >= 1 && s.n === reached + 1) state = 'ACTIVE';
    else state = 'PENDING';
    return { label: side === 'BUY' ? s.buy : s.sell, state };
  });
}

/* ------------------------------- levels ------------------------------- */

export type HeadlineKey = 'PDH' | 'PDL' | 'ASIA_HIGH' | 'ASIA_LOW' | 'MAJOR_HIGH' | 'MAJOR_LOW';
export const HEADLINE: { key: HeadlineKey; label: string }[] = [
  { key: 'PDH', label: 'Previous Day High' },
  { key: 'PDL', label: 'Previous Day Low' },
  { key: 'ASIA_HIGH', label: 'Asia High' },
  { key: 'ASIA_LOW', label: 'Asia Low' },
  { key: 'MAJOR_HIGH', label: 'Major Swing High' },
  { key: 'MAJOR_LOW', label: 'Major Swing Low' },
];
/** The six headline levels (handoff §4.7) — current definitions only; null when not formed yet. */
export function headline(levels: readonly Level[]): Record<HeadlineKey, Level | null> {
  const live = levels.filter((l) => l.retiredAt === null);
  const pick = (f: (l: Level) => boolean) => live.filter(f).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  return {
    PDH: pick((l) => l.type === 'PDH'),
    PDL: pick((l) => l.type === 'PDL'),
    ASIA_HIGH: pick((l) => l.type === 'ASIA_HIGH'),
    ASIA_LOW: pick((l) => l.type === 'ASIA_LOW'),
    MAJOR_HIGH: pick((l) => l.source === 'swing' && l.major && l.kind === 'high'),
    MAJOR_LOW: pick((l) => l.source === 'swing' && l.major && l.kind === 'low'),
  };
}
export const LEVEL_TYPES: LevelType[] = ['PDH', 'PDL', 'ASIA_HIGH', 'ASIA_LOW', 'SWING_HIGH', 'SWING_LOW'];
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

/**
 * Chart overlays — the engine result only (handoff §11.3): the six headline levels as bands of the
 * tolerance the engine used (consumed levels drawn faint and captioned "broken", never removed),
 * the sweep marker, the CHOCH / BOS line from the broken swing to the closing candle, and Entry /
 * SL / TP ONLY from the decision's trade levels (null unless confirmed on a live feed).
 */
export function hleOverlays(o: { levels: readonly Level[]; setup: Setup | null; decision: HLEDecision | null; chartTf: HLETimeframe; decimals: number; tools: HLETools }): { drawables: HLEDrawable[]; markers: HLEMarker[] } {
  const d = o.decimals;
  const out: HLEDrawable[] = [];
  const s = o.setup;
  const active = s?.levelId ?? o.decision?.level?.id ?? null;
  const heads = headline(o.levels);
  for (const h of HEADLINE) {
    const l = heads[h.key];
    if (!l) continue;
    const isMajor = h.key === 'MAJOR_HIGH' || h.key === 'MAJOR_LOW';
    if ((isMajor && !o.tools.levels) || (!isMajor && !o.tools.liquidity)) continue;
    const on = l.id === active;
    const half = Math.max(l.tol, 0);
    out.push({
      id: l.id,
      kind: 'level',
      tone: on ? 'gold' : l.state === 'CONSUMED' ? 'muted' : l.kind === 'high' ? 'sell' : 'buy',
      low: l.price - half,
      high: l.price + half,
      from: l.formedAt,
      to: null,
      label: `${l.label} ${formatPrice(l.price, d)}${l.state === 'CONSUMED' ? ' · broken' : l.state === 'SWEPT' ? ' · swept' : ''} · ${l.kind === 'high' ? 'BSL' : 'SSL'}${on ? ' ● setup' : ''}`,
      dashed: l.state !== 'ACTIVE',
      emphasis: on,
    });
  }
  const markers: HLEMarker[] = [];
  if (s) {
    const buy = s.side === 'BUY';
    if (s.m5 && o.tools.structure)
      out.push({ id: `${s.id}:bos`, kind: 'structure', tone: 'structure', low: s.m5.brokenLevel, high: s.m5.brokenLevel, from: s.m5.swingTime, to: s.m5.time, label: `${s.m5.kind}${s.m5.displacement.displaced ? ' + disp' : ''}`, dashed: true, emphasis: true });
    const t = o.decision?.setup?.id === s.id ? o.decision.tradeLevels : null;
    if (t && o.tools.risk) {
      const from = t.zone.definedAt;
      out.push({ id: `${s.id}:zone`, kind: 'zone', tone: 'zone', low: t.zone.low, high: t.zone.high, from, to: null, label: `Entry ${formatPrice(t.entry, d)}`, dashed: false, emphasis: true });
      out.push({ id: `${s.id}:sl`, kind: 'stop', tone: 'sell', low: t.stop, high: t.stop, from, to: null, label: `SL ${formatPrice(t.stop, d)}`, dashed: true, emphasis: false });
      out.push({ id: `${s.id}:tp1`, kind: 'tp', tone: 'buy', low: t.tp1, high: t.tp1, from, to: null, label: `TP1 ${formatPrice(t.tp1, d)}`, dashed: true, emphasis: false });
      if (t.tp2 !== null) out.push({ id: `${s.id}:tp2`, kind: 'tp', tone: 'buy', low: t.tp2, high: t.tp2, from, to: null, label: `TP2 ${formatPrice(t.tp2, d)}`, dashed: true, emphasis: false });
    }
    const side = buy ? 'belowBar' : 'aboveBar';
    if (o.tools.sweeps) {
      markers.push({ time: alignTo(s.sweep.extremeTime, o.chartTf), position: side, shape: buy ? 'arrowUp' : 'arrowDown', color: '#ffd54f', text: `${buy ? 'SSL' : 'BSL'} Sweep` });
      if (s.reclaim) markers.push({ time: alignTo(s.reclaim.time, o.chartTf), position: side, shape: 'circle', color: '#d4a94f', text: 'Reclaim' });
    }
    if (s.m5 && o.tools.structure) markers.push({ time: alignTo(s.m5.time, o.chartTf), position: buy ? 'aboveBar' : 'belowBar', shape: 'square', color: '#ab47bc', text: s.m5.kind });
    if (t && o.tools.risk && s.entry) markers.push({ time: alignTo(s.entry.time, o.chartTf), position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', color: '#4c8dff', text: `${s.side} Confirmed` });
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
