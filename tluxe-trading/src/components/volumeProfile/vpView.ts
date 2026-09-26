import { VP_TF_SECONDS } from '../../engines/volumeProfile/config';
import type { AcceptanceState, PriceLocation, ProfileKind, ProfileRow, VPEvent, VPEventType, VPSnapshot, VolumeNode, VolumeProfile } from '../../engines/volumeProfile/types';
import type { SmcSnapshot } from '../../engines/smc/types';
import type { SRZone } from '../../engines/sr/types';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';

/* Pure view helpers for the Volume Profile page: turn ENGINE OUTPUT into chart drawables / labels.
 * Nothing here computes a profile — every row, level and zone comes from an engine. */

export interface VPHistogram {
  rows: ProfileRow[];
  binSize: number;
  max: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
}
export interface VPDrawable {
  id: string;
  kind: 'zone' | 'line';
  tone: 'poc' | 'va' | 'prev' | 'hvn' | 'lvn' | 'bull' | 'bear' | 'liq' | 'sr' | 'session';
  /** Time range (s); null `from` = left edge, null `to` = right edge. */
  from: number | null;
  to: number | null;
  high: number;
  low: number;
  label: string;
  dashed?: boolean;
  emphasis?: boolean;
}
export interface VPMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text: string;
}

export type VPToggleKey = 'volumeProfile' | 'poc' | 'vahVal' | 'hvn' | 'lvn' | 'previous' | 'sessions' | 'liquidity' | 'sweeps' | 'sr' | 'orderBlocks' | 'fvg' | 'bosChoch' | 'mtf';
export type VPToggles = Record<VPToggleKey, boolean>;
export const VP_TOGGLE_LABELS: [VPToggleKey, string][] = [
  ['volumeProfile', 'Volume Profile'],
  ['poc', 'POC'],
  ['vahVal', 'VAH / VAL'],
  ['hvn', 'HVN'],
  ['lvn', 'LVN'],
  ['previous', 'Previous Profile'],
  ['sessions', 'Session Profiles'],
  ['liquidity', 'Liquidity'],
  ['sweeps', 'Sweeps'],
  ['sr', 'Support / Resistance'],
  ['orderBlocks', 'Order Blocks'],
  ['fvg', 'FVG'],
  ['bosChoch', 'BOS / CHOCH'],
  ['mtf', 'MTF Confluence'],
];
export const DEFAULT_VP_TOGGLES: VPToggles = { volumeProfile: true, poc: true, vahVal: true, hvn: true, lvn: true, previous: true, sessions: false, liquidity: false, sweeps: false, sr: false, orderBlocks: false, fvg: false, bosChoch: false, mtf: false };

export type VPProfileChoice = Exclude<ProfileKind, 'TF' | 'RANGE'> | 'VISIBLE' | 'FIXED';
export const VP_PROFILE_CHOICES: [VPProfileChoice, string][] = [
  ['CURRENT_SESSION', 'Current Session'],
  ['PREVIOUS_SESSION', 'Previous Session'],
  ['DAILY', 'Daily'],
  ['PREVIOUS_DAY', 'Previous Day'],
  ['WEEKLY', 'Weekly'],
  ['PREVIOUS_WEEK', 'Previous Week'],
  ['VISIBLE', 'Visible Range'],
  ['FIXED', 'Fixed Range'],
  ['ASIA', 'Asia'],
  ['LONDON', 'London'],
  ['NEW_YORK', 'New York'],
];
/** Chart timeframe buttons (the engine's MTF set, highest → lowest). */
export const VP_CHART_TFS: Timeframe[] = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

const GREEN = '#3cc9a0';
const RED = '#ef5d5d';
const GOLD = '#d4a94f';
const BLUE = '#8ab4f8';
const OPEN_FVG = new Set(['FRESH', 'ACTIVE', 'PARTIALLY_FILLED']);

export function histogramOf(p: VolumeProfile | null | undefined): VPHistogram | null {
  if (!p || !p.rows.length || p.total <= 0) return null;
  let max = 0;
  for (const r of p.rows) if (r.volume > max) max = r.volume;
  return { rows: p.rows, binSize: p.binSize, max, poc: p.poc, vah: p.vah, val: p.val };
}

/** Last chart bar opening at or before `t - 1` (events carry close times; markers need a bar time). */
export function snapToBar(barTimes: readonly number[], t: number): number | null {
  let lo = 0;
  let hi = barTimes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barTimes[mid]! <= t - 1) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? null : barTimes[ans]!;
}

const EVENT_MARK: Partial<Record<VPEventType, { color: string; position: VPMarker['position']; shape: VPMarker['shape']; text: string }>> = {
  'NEW POC': { color: RED, position: 'aboveBar', shape: 'circle', text: 'NEW POC' },
  'POC SHIFTED': { color: RED, position: 'aboveBar', shape: 'circle', text: 'POC SHIFT' },
  'VAH TESTED': { color: BLUE, position: 'aboveBar', shape: 'square', text: 'VAH TEST' },
  'VAL TESTED': { color: BLUE, position: 'belowBar', shape: 'square', text: 'VAL TEST' },
  'VAH REJECTED': { color: RED, position: 'aboveBar', shape: 'arrowDown', text: 'VAH REJ' },
  'VAL RECLAIMED': { color: GREEN, position: 'belowBar', shape: 'arrowUp', text: 'VAL RECLAIM' },
  'VALUE BREAK': { color: GOLD, position: 'aboveBar', shape: 'square', text: 'VALUE BREAK' },
  'VALUE RE-ENTRY': { color: GOLD, position: 'belowBar', shape: 'square', text: 'RE-ENTRY' },
};

export interface VPOverlayInput {
  snapshot: VPSnapshot | null;
  profile: VolumeProfile | null;
  smc: SmcSnapshot | null;
  srZones: readonly SRZone[] | null;
  chartTf: Timeframe;
  toggles: VPToggles;
  decimals: number;
  barTimes: readonly number[];
}

export function vpOverlays(o: VPOverlayInput): { hist: VPHistogram | null; drawables: VPDrawable[]; markers: VPMarker[] } {
  const t = o.toggles;
  const out: VPDrawable[] = [];
  const markers: VPMarker[] = [];
  const f = (p: number) => formatPrice(p, o.decimals);
  const p = o.profile;
  const snap = o.snapshot;
  const price = snap?.price ?? null;
  const hist = t.volumeProfile ? histogramOf(p) : null;
  if (p && p.poc !== null) {
    if (t.poc) out.push({ id: 'vp:poc', kind: 'line', tone: 'poc', from: p.from, to: null, high: p.poc, low: p.poc, label: `POC ${f(p.poc)}`, emphasis: true });
    if (t.vahVal && p.vah !== null && p.val !== null) {
      out.push({ id: 'vp:va', kind: 'zone', tone: 'va', from: p.from, to: null, high: p.vah, low: p.val, label: '' });
      out.push({ id: 'vp:vah', kind: 'line', tone: 'va', from: p.from, to: null, high: p.vah, low: p.vah, label: `VAH ${f(p.vah)}` });
      out.push({ id: 'vp:val', kind: 'line', tone: 'va', from: p.from, to: null, high: p.val, low: p.val, label: `VAL ${f(p.val)}` });
    }
  }
  if (t.hvn || t.lvn) {
    const byId = new Map<string, VolumeNode>();
    for (const n of [...(p?.hvn ?? []), ...(p?.lvn ?? []), ...(snap?.nodes ?? [])]) if (n.state !== 'EXPIRED' && n.state !== 'BROKEN') byId.set(n.id, n);
    const ref = price ?? p?.poc ?? 0;
    for (const type of ['HVN', 'LVN'] as const) {
      if ((type === 'HVN' && !t.hvn) || (type === 'LVN' && !t.lvn)) continue;
      const list = [...byId.values()].filter((n) => n.type === type).sort((a, b) => Math.abs(a.price - ref) - Math.abs(b.price - ref)).slice(0, 5);
      for (const n of list) out.push({ id: `vp:node:${n.id}`, kind: 'zone', tone: type === 'HVN' ? 'hvn' : 'lvn', from: n.createdAt, to: null, high: n.high, low: n.low, label: `${type} ${f(n.price)}${n.developing ? ' (dev)' : ''}`, dashed: n.developing });
    }
  }
  if (t.previous && snap) {
    const pd = snap.profiles.PREVIOUS_DAY;
    if (pd && pd.poc !== null && pd.id !== p?.id) {
      out.push({ id: 'vp:pd:poc', kind: 'line', tone: 'prev', from: pd.from, to: null, high: pd.poc, low: pd.poc, label: `pPOC ${f(pd.poc)}`, dashed: true });
      if (pd.vah !== null) out.push({ id: 'vp:pd:vah', kind: 'line', tone: 'prev', from: pd.from, to: null, high: pd.vah, low: pd.vah, label: `pVAH ${f(pd.vah)}`, dashed: true });
      if (pd.val !== null) out.push({ id: 'vp:pd:val', kind: 'line', tone: 'prev', from: pd.from, to: null, high: pd.val, low: pd.val, label: `pVAL ${f(pd.val)}`, dashed: true });
    }
    const pw = snap.profiles.PREVIOUS_WEEK;
    if (pw && pw.poc !== null && pw.id !== p?.id) out.push({ id: 'vp:pw:poc', kind: 'line', tone: 'prev', from: pw.from, to: null, high: pw.poc, low: pw.poc, label: `Prev week POC ${f(pw.poc)}`, dashed: true });
  }
  if (t.sessions && snap)
    for (const k of ['ASIA', 'LONDON', 'NEW_YORK'] as const) {
      const s = snap.profiles[k];
      if (!s || s.poc === null) continue;
      out.push({ id: `vp:ses:${k}`, kind: 'line', tone: 'session', from: s.from, to: s.complete ? s.to : null, high: s.poc, low: s.poc, label: `${s.label} POC ${f(s.poc)}` });
    }
  if (t.mtf && snap)
    for (const r of snap.mtf) {
      if (!r.available || r.poc === null || r.timeframe === o.chartTf) continue;
      out.push({ id: `vp:mtf:${r.timeframe}`, kind: 'line', tone: 'prev', from: null, to: null, high: r.poc, low: r.poc, label: `${r.timeframe} POC ${f(r.poc)}`, dashed: true });
    }

  // Other engines — read-only, their published output only.
  const s = o.smc?.byTimeframe[o.chartTf];
  if (s && s.dataState !== 'NO_DATA') {
    const ref = s.price ?? price;
    if (t.liquidity && ref !== null)
      for (const q of s.liquidity.filter((x) => x.status === 'LIQUIDITY PRESENT').sort((a, b) => Math.abs(a.level - ref) - Math.abs(b.level - ref)).slice(0, 4))
        out.push({ id: `vp:lq:${q.id}`, kind: 'line', tone: 'liq', from: q.confirmedAt, to: null, high: q.level, low: q.level, label: `${q.kind} ${f(q.level)}`, dashed: true });
    if (t.sweeps)
      for (const w of s.sweeps.filter((x) => x.outcome !== 'accepted').slice(-6)) {
        const bt = snapToBar(o.barTimes, w.time + 1);
        if (bt !== null) markers.push({ time: bt, position: w.side === 'BSL' ? 'aboveBar' : 'belowBar', shape: 'square', color: BLUE, text: `${w.side} sweep` });
      }
    if (t.orderBlocks && ref !== null)
      for (const b of s.orderBlocks.filter((x) => x.live).sort((a, c) => Math.abs(a.mid - ref) - Math.abs(c.mid - ref)).slice(0, 4))
        out.push({ id: `vp:ob:${b.id}`, kind: 'zone', tone: b.direction === 'bullish' ? 'bull' : 'bear', from: b.originTime, to: null, high: b.high, low: b.low, label: `${b.direction === 'bullish' ? 'Bull' : 'Bear'} OB` });
    if (t.fvg)
      for (const g of s.fvgs.filter((x) => OPEN_FVG.has(x.state)).slice(-5))
        out.push({ id: `vp:fvg:${g.id}`, kind: 'zone', tone: g.direction === 'bullish' ? 'bull' : 'bear', from: g.originTime, to: null, high: g.upper, low: g.lower, label: `FVG ${Math.round(g.fillPct)}%`, dashed: true });
    if (t.bosChoch)
      for (const b of s.breaks.slice(-4))
        out.push({ id: `vp:brk:${b.id}`, kind: 'line', tone: b.direction === 'bullish' ? 'bull' : 'bear', from: b.originTime, to: b.confirmedAt, high: b.level, low: b.level, label: `${b.kind}`, dashed: b.kind === 'BOS', emphasis: b.kind === 'CHOCH' });
  }
  if (t.sr && o.srZones && price !== null)
    for (const z of o.srZones.filter((x) => x.status !== 'BROKEN' && x.status !== 'EXPIRED').sort((a, b) => Math.abs((a.zoneLow + a.zoneHigh) / 2 - price) - Math.abs((b.zoneLow + b.zoneHigh) / 2 - price)).slice(0, 4))
      out.push({ id: `vp:sr:${z.id}`, kind: 'zone', tone: 'sr', from: null, to: null, high: z.zoneHigh, low: z.zoneLow, label: `${z.role} ${z.timeframe}` });

  // VP engine events on the chart (only real, closed-candle events).
  if (snap)
    for (const e of snap.events.slice(-12)) {
      const m = EVENT_MARK[e.type];
      const bt = m ? snapToBar(o.barTimes, e.time) : null;
      if (m && bt !== null) markers.push({ time: bt, position: m.position, shape: m.shape, color: m.color, text: m.text });
    }
  markers.sort((a, b) => a.time - b.time);
  return { hist, drawables: out, markers };
}

/* ------------------------------- labels -------------------------------- */

export type VPViewState = 'LIVE' | 'STALE' | 'UNAVAILABLE' | 'VOLUME_UNAVAILABLE' | 'INSUFFICIENT_DATA' | 'REPLAY';
export const VP_VIEW_TITLE: Record<VPViewState, string> = { LIVE: 'LIVE', STALE: 'DATA STALE', UNAVAILABLE: 'DATA UNAVAILABLE', VOLUME_UNAVAILABLE: 'VOLUME DATA UNAVAILABLE', INSUFFICIENT_DATA: 'INSUFFICIENT DATA', REPLAY: 'REPLAY' };

export function vpViewState(o: { feed: 'LIVE' | 'STALE' | 'DISCONNECTED'; snapshot: VPSnapshot | null; profile: VolumeProfile | null; replay: boolean; hasProvider: boolean }): VPViewState {
  if (o.replay) return 'REPLAY';
  if (!o.hasProvider || o.feed === 'DISCONNECTED') return 'UNAVAILABLE';
  if (o.feed === 'STALE') return 'STALE';
  if (!o.snapshot || o.snapshot.knowledgeTime === null) return 'INSUFFICIENT_DATA';
  if (o.profile && o.profile.bars > 0 && o.profile.source.mode === 'NONE') return 'VOLUME_UNAVAILABLE';
  if (!o.profile || o.profile.poc === null) return 'INSUFFICIENT_DATA';
  return 'LIVE';
}

export const fmtUtc = (sec: number | null) => (sec === null ? '—' : `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
export const fmtHm = (sec: number | null) => (sec === null ? '—' : new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' '));
export function fmtVol(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString('en-US');
}
export const fmtAtr = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} ATR`);
export const locationTone = (l: PriceLocation | null | undefined) => (l === 'ABOVE VALUE' ? 'bull' : l === 'BELOW VALUE' ? 'bear' : l === 'NEAR POC' ? 'warn' : l ? 'muted' : 'dim');
export const acceptanceTone = (a: AcceptanceState | null | undefined) =>
  !a || a === 'NO CONFIRMATION' ? 'dim' : a === 'ACCEPTED ABOVE VAH' || a === 'REJECTED BELOW VAL' ? 'bull' : a === 'ACCEPTED BELOW VAL' || a === 'REJECTED ABOVE VAH' ? 'bear' : a === 'BREAKING FROM VALUE' ? 'warn' : 'muted';
export const eventTone = (e: VPEvent) => (e.type === 'DATA REVISED' ? 'warn' : e.type === 'VAL RECLAIMED' ? 'bull' : e.type === 'VAH REJECTED' ? 'bear' : e.type.includes('POC') ? 'poc' : 'muted');
export const tfSeconds = (tf: Timeframe) => VP_TF_SECONDS[tf];
/** Profile window label, e.g. "01-05 22:00 → 01-06 22:00". */
export const windowLabel = (p: VolumeProfile | null | undefined) => (p ? `${fmtHm(p.from)} → ${fmtHm(p.to)}` : '—');

/** Instrument-level volume label (never claims exchange volume for spot / CFD, never invents a source). */
export function volumeSourceText(o: { snapshot: VPSnapshot | null; profile: VolumeProfile | null; symbol: string; isFuture: boolean }): { label: string; unavailable: boolean } {
  if (o.snapshot?.unavailable) return { label: o.snapshot.unavailable, unavailable: true };
  const src = o.profile?.source ?? o.snapshot?.source ?? null;
  if (!src || src.mode === 'NONE') return { label: o.isFuture ? `${o.symbol} VOLUME DATA UNAVAILABLE` : 'VOLUME DATA UNAVAILABLE', unavailable: true };
  return { label: src.label, unavailable: false };
}

/** datetime-local (interpreted as UTC) ⇄ seconds. */
export const utcInputToSec = (v: string): number | null => {
  if (!v) return null;
  const ms = Date.parse(`${v.length === 16 ? `${v}:00` : v}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
export const secToUtcInput = (s: number) => new Date(s * 1000).toISOString().slice(0, 16);
