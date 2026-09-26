import { FP_TF_SECONDS } from '../../engines/volumeFootprint/config';
import type { FPCandle, FPEvent, FPEventType, FPStack, FPTimeframe, FootprintSnapshot } from '../../engines/volumeFootprint/types';
import type { SmcSnapshot } from '../../engines/smc/types';
import type { SRZone } from '../../engines/sr/types';
import type { VPSnapshot } from '../../engines/volumeProfile/types';
import type { FPState } from '../../services/volumeFootprint/VolumeFootprintService';
import type { Candle } from '../../types/market';

/* Pure view helpers for the Volume Footprint page. Display settings NEVER touch the engine's evidence. */

export type FPMode = 'BID_ASK' | 'DELTA' | 'TOTAL' | 'IMBALANCE' | 'VOLUME' | 'DELTA_IMBALANCE';
export const FP_MODES: [FPMode, string][] = [
  ['BID_ASK', 'Bid × Ask'],
  ['DELTA', 'Delta'],
  ['TOTAL', 'Total Volume'],
  ['IMBALANCE', 'Imbalance'],
  ['VOLUME', 'Volume'],
  ['DELTA_IMBALANCE', 'Delta + Imbalance'],
];
export type FPDensity = 'AUTO' | 'LOW' | 'HIGH';
export interface FPViewSettings {
  mode: FPMode;
  density: FPDensity;
  cellScale: 'LINEAR' | 'SQRT';
  autoScale: boolean;
  showZero: boolean;
  showUnknown: boolean;
  deltaHighlight: number;
}
export const DEFAULT_FP_VIEW: FPViewSettings = { mode: 'BID_ASK', density: 'AUTO', cellScale: 'SQRT', autoScale: true, showZero: false, showUnknown: true, deltaHighlight: 100 };

export type FPToggleKey = 'bidAsk' | 'delta' | 'poc' | 'buyImb' | 'sellImb' | 'stacked' | 'absorption' | 'exhaustion' | 'divergence' | 'cvd' | 'volumeProfile' | 'liquidity' | 'sr' | 'orderBlocks' | 'fvg' | 'bosChoch';
export type FPToggles = Record<FPToggleKey, boolean>;
export const FP_TOGGLE_LABELS: [FPToggleKey, string][] = [
  ['bidAsk', 'Bid × Ask'],
  ['delta', 'Delta'],
  ['poc', 'POC'],
  ['buyImb', 'Buy Imbalance'],
  ['sellImb', 'Sell Imbalance'],
  ['stacked', 'Stacked Imbalance'],
  ['absorption', 'Absorption Candidate'],
  ['exhaustion', 'Exhaustion Candidate'],
  ['divergence', 'Delta Divergence'],
  ['cvd', 'Cumulative Delta'],
  ['volumeProfile', 'Volume Profile'],
  ['liquidity', 'Liquidity Levels'],
  ['sr', 'Support & Resistance'],
  ['orderBlocks', 'Order Blocks'],
  ['fvg', 'FVG'],
  ['bosChoch', 'BOS / CHOCH'],
];
export const DEFAULT_FP_TOGGLES: FPToggles = { bidAsk: true, delta: true, poc: true, buyImb: true, sellImb: true, stacked: true, absorption: true, exhaustion: true, divergence: true, cvd: false, volumeProfile: false, liquidity: false, sr: false, orderBlocks: false, fvg: false, bosChoch: false };
export const FP_CHART_TFS: FPTimeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1'];

/** What the chart primitive draws (engine output + view settings; nothing computed from prices here). */
export interface FPOverlayLine {
  id: string;
  kind: 'line' | 'zone';
  high: number;
  low: number;
  label: string;
  color: string;
  dashed?: boolean;
}
export interface FPRenderData {
  candles: readonly FPCandle[];
  rowSize: number;
  decimals: number;
  view: FPViewSettings;
  toggles: FPToggles;
  stacks: readonly FPStack[];
  lines: FPOverlayLine[];
  cvd: { time: number; value: number }[];
  selected: number | null;
}
export interface FPMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text: string;
}

/** Chart candles from footprint candles (stable objects for closed candles → cheap chart updates). */
const chartCache = new WeakMap<FPCandle, Candle>();
export function chartCandle(c: FPCandle): Candle {
  let x = chartCache.get(c);
  if (!x) {
    x = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, isClosed: c.closed, source: 'exchange-trades' };
    chartCache.set(c, x);
  }
  return x;
}

const MARK: Partial<Record<FPEventType, { key: FPToggleKey; color: string; text: string }>> = {
  'ABSORPTION CANDIDATE': { key: 'absorption', color: '#d4a94f', text: 'ABS' },
  'EXHAUSTION CANDIDATE': { key: 'exhaustion', color: '#a78bfa', text: 'EXH' },
  'DELTA DIVERGENCE CANDIDATE': { key: 'divergence', color: '#8ab4f8', text: 'DIV' },
  'STACKED BUY IMBALANCE': { key: 'stacked', color: '#3cc9a0', text: 'STACK' },
  'STACKED SELL IMBALANCE': { key: 'stacked', color: '#ef5d5d', text: 'STACK' },
};
/** Candidate markers on the candle that produced them (candle events carry the close time). */
export function fpMarkers(events: readonly FPEvent[], tf: FPTimeframe, toggles: FPToggles, candles: readonly FPCandle[]): FPMarker[] {
  const byId = new Map(candles.map((c) => [c.id, c]));
  const out: FPMarker[] = [];
  for (const e of events) {
    const m = MARK[e.type];
    if (!m || !toggles[m.key] || e.tf !== tf || !e.candleId) continue;
    const c = byId.get(e.candleId);
    if (!c) continue;
    const high = e.price !== null && e.price >= (c.high + c.low) / 2;
    out.push({ time: c.time, position: high ? 'aboveBar' : 'belowBar', shape: high ? 'arrowDown' : 'arrowUp', color: m.color, text: m.text });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Read-only overlays from OTHER engines' published output (never re-detected here). */
export function crossEngineLines(o: { toggles: FPToggles; tf: FPTimeframe; vp: VPSnapshot | null; smc: SmcSnapshot | null; sr: readonly SRZone[] | null; price: number | null }): FPOverlayLine[] {
  const t = o.toggles;
  const out: FPOverlayLine[] = [];
  const ref = o.price;
  const near = <T>(xs: T[], f: (x: T) => number, n: number) => (ref === null ? xs.slice(-n) : [...xs].sort((a, b) => Math.abs(f(a) - ref) - Math.abs(f(b) - ref)).slice(0, n));
  if (t.volumeProfile && o.vp) {
    const p = o.vp.profiles.CURRENT_SESSION ?? o.vp.profiles.DAILY;
    if (p && p.poc !== null) {
      out.push({ id: 'vp:poc', kind: 'line', high: p.poc, low: p.poc, label: `VP POC (Volume Profile engine)`, color: '#ef5d5d', dashed: true });
      if (p.vah !== null) out.push({ id: 'vp:vah', kind: 'line', high: p.vah, low: p.vah, label: 'VP VAH', color: '#5b8cff', dashed: true });
      if (p.val !== null) out.push({ id: 'vp:val', kind: 'line', high: p.val, low: p.val, label: 'VP VAL', color: '#5b8cff', dashed: true });
    }
  }
  const s = o.smc?.byTimeframe[o.tf];
  if (s && s.dataState !== 'NO_DATA') {
    if (t.liquidity) for (const q of near(s.liquidity.filter((x) => x.status === 'LIQUIDITY PRESENT'), (x) => x.level, 4)) out.push({ id: `lq:${q.id}`, kind: 'line', high: q.level, low: q.level, label: `${q.kind} (Liquidity engine)`, color: '#8ab4f8', dashed: true });
    if (t.orderBlocks) for (const b of near(s.orderBlocks.filter((x) => x.live), (x) => x.mid, 4)) out.push({ id: `ob:${b.id}`, kind: 'zone', high: b.high, low: b.low, label: `${b.direction === 'bullish' ? 'Bull' : 'Bear'} OB (Order Block engine)`, color: b.direction === 'bullish' ? '#3cc9a0' : '#ef5d5d' });
    if (t.fvg) for (const g of s.fvgs.filter((x) => x.state === 'FRESH' || x.state === 'ACTIVE' || x.state === 'PARTIALLY_FILLED').slice(-4)) out.push({ id: `fvg:${g.id}`, kind: 'zone', high: g.upper, low: g.lower, label: 'FVG (SMC engine)', color: g.direction === 'bullish' ? '#3cc9a0' : '#ef5d5d', dashed: true });
    if (t.bosChoch) for (const b of s.breaks.slice(-3)) out.push({ id: `brk:${b.id}`, kind: 'line', high: b.level, low: b.level, label: `${b.kind} (SMC engine)`, color: b.direction === 'bullish' ? '#3cc9a0' : '#ef5d5d', dashed: b.kind === 'BOS' });
  }
  if (t.sr && o.sr) for (const z of near(o.sr.filter((x) => x.status !== 'BROKEN' && x.status !== 'EXPIRED'), (x) => (x.zoneLow + x.zoneHigh) / 2, 4)) out.push({ id: `sr:${z.id}`, kind: 'zone', high: z.zoneHigh, low: z.zoneLow, label: `${z.role} ${z.timeframe} (S&R engine)`, color: '#d4a94f' });
  return out;
}

/** CVD per candle close (running sum of candle deltas of the visible history; classified volume only). */
export function cvdSeries(candles: readonly FPCandle[]): { time: number; value: number }[] {
  let s = 0;
  return candles.map((c) => ({ time: c.time, value: (s += c.delta) }));
}

/* ------------------------------- labels -------------------------------- */

export type FPViewState = 'LIVE' | 'STALE' | 'UNAVAILABLE' | 'UNCLASSIFIED' | 'REPLAY';
export const FP_VIEW_TITLE: Record<FPViewState, string> = { LIVE: 'LIVE', STALE: 'DATA STALE', UNAVAILABLE: 'FOOTPRINT DATA UNAVAILABLE', UNCLASSIFIED: 'FOOTPRINT DATA UNAVAILABLE', REPLAY: 'REPLAY' };

export function fpViewState(s: FPState, replay: boolean): FPViewState {
  if (replay) return 'REPLAY';
  const snap = s.snapshot;
  if (!s.supported || !s.provider || !snap || snap.status === 'UNAVAILABLE' || snap.integrity.feed === 'DISCONNECTED') return 'UNAVAILABLE';
  if (snap.status === 'UNCLASSIFIED') return 'UNCLASSIFIED';
  if (s.stale) return 'STALE';
  return 'LIVE';
}

/** Which capability is missing, in plain words (never hidden behind a populated chart). */
export function missingCapability(s: FPState, snap: FootprintSnapshot | null): string | null {
  if (s.reason) return s.reason;
  if (!snap) return 'Waiting for the trade provider.';
  if (snap.integrity.feed === 'DISCONNECTED') return 'Trade feed disconnected — no trades are being received.';
  return snap.statusReason;
}

export const fmtVol = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : Math.round(v).toLocaleString('en-US'));
export const fmtDelta = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`);
export const deltaTone = (v: number | null | undefined) => (!v ? 'muted' : v > 0 ? 'bull' : 'bear');
export const fmtRatio = (r: number | null) => (r === null ? '∞' : `${r.toFixed(1)} : 1`);
export const fmtHms = (sec: number | null) => (sec === null ? '—' : new Date(sec * 1000).toISOString().slice(11, 19));
export const fmtUtc = (ms: number | null) => (ms === null ? '—' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
export const candleWindow = (c: FPCandle) => `${fmtHms(c.time).slice(0, 5)} – ${fmtHms(c.time + FP_TF_SECONDS[c.tf]).slice(0, 5)}`;
export const eventTone = (e: FPEvent) =>
  e.type.includes('BUY') || (e.delta !== null && e.delta > 0 && e.type === 'LARGE TRADE') ? 'bull' : e.type.includes('SELL') || (e.delta !== null && e.delta < 0 && e.type === 'LARGE TRADE') ? 'bear' : e.type.includes('GAP') || e.type.includes('LATE') || e.type.includes('DISCONNECT') || e.type.includes('CONTRACT') ? 'warn' : 'muted';
