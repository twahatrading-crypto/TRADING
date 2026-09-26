import { SMC_TF_SECONDS } from '../../engines/smc/config';
import type { SmcFeed, SmcSnapshot, SmcTimeframeSnapshot } from '../../engines/smc/types';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';

/* Pure view helpers for the SMC page: turn ENGINE OUTPUT into chart drawables / labels.
 * Nothing here analyses the market — every shape corresponds to an engine object. */

export interface SmcDrawable {
  id: string;
  kind: 'zone' | 'line' | 'path';
  tone: 'bull' | 'bear' | 'fvgBull' | 'fvgBear' | 'structure' | 'liquidity' | 'premium' | 'discount' | 'eq' | 'gold' | 'muted';
  /** Time range (s); null `to` = extends to the right edge. */
  from: number | null;
  to: number | null;
  high: number;
  low: number;
  points?: { t: number; p: number }[];
  label: string;
  labelAt?: 'segment' | 'edge';
  dashed?: boolean;
  emphasis?: boolean;
}
export interface SmcMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text: string;
}

export type SmcToggleKey = 'structure' | 'hhll' | 'swings' | 'bos' | 'choch' | 'liquidity' | 'sweeps' | 'orderBlocks' | 'fvg' | 'displacement' | 'premiumDiscount' | 'inducement' | 'mtf';
export type SmcToggles = Record<SmcToggleKey, boolean>;
export const SMC_TOGGLE_LABELS: [SmcToggleKey, string][] = [
  ['structure', 'Market Structure'],
  ['hhll', 'HH / HL / LH / LL'],
  ['swings', 'Swing High / Low'],
  ['bos', 'BOS'],
  ['choch', 'CHOCH'],
  ['liquidity', 'Liquidity'],
  ['sweeps', 'Sweeps'],
  ['orderBlocks', 'Order Blocks'],
  ['fvg', 'FVG / Imbalance'],
  ['displacement', 'Displacement'],
  ['premiumDiscount', 'Premium / Discount'],
  ['inducement', 'Inducement'],
  ['mtf', 'MTF Confluence'],
];
export const DEFAULT_SMC_TOGGLES: SmcToggles = { structure: true, hhll: true, swings: true, bos: true, choch: true, liquidity: true, sweeps: true, orderBlocks: true, fvg: true, displacement: true, premiumDiscount: true, inducement: true, mtf: false };

const GREEN = '#3cc9a0';
const RED = '#ef5d5d';
const GOLD = '#d4a94f';
const BLUE = '#8ab4f8';
const OPEN_FVG = new Set(['FRESH', 'ACTIVE', 'PARTIALLY_FILLED']);
const HIGHER: Record<Timeframe, Timeframe[]> = { M1: ['H4', 'H1', 'M15'], M5: ['H4', 'H1', 'M15'], M15: ['H4', 'H1'], M30: ['H4', 'H1'], H1: ['D1', 'H4'], H4: ['D1'], D1: [] };

export function smcOverlays(o: { snapshot: SmcSnapshot | null; chartTf: Timeframe; toggles: SmcToggles; decimals: number }): { drawables: SmcDrawable[]; markers: SmcMarker[] } {
  const s = o.snapshot?.byTimeframe[o.chartTf];
  const out: SmcDrawable[] = [];
  const markers: SmcMarker[] = [];
  if (!s || s.dataState === 'NO_DATA') return { drawables: out, markers };
  const t = o.toggles;
  const f = (p: number) => formatPrice(p, o.decimals);
  const price = s.price;

  if (t.structure) {
    const pts = s.swings.slice(-40).sort((a, b) => a.originTime - b.originTime).map((w) => ({ t: w.originTime, p: w.price }));
    if (pts.length > 1) out.push({ id: 'smc:path', kind: 'path', tone: 'structure', from: null, to: null, high: pts[0]!.p, low: pts[0]!.p, points: pts, label: '' });
  }
  if (t.hhll)
    for (const w of s.swings.slice(-40))
      if (w.label) markers.push({ time: w.originTime, position: w.kind === 'high' ? 'aboveBar' : 'belowBar', shape: 'circle', color: w.label === 'HH' || w.label === 'HL' ? GREEN : w.label === 'LH' || w.label === 'LL' ? RED : '#9aa3b2', text: w.label });
  if (t.swings)
    for (const w of [s.refHigh, s.refLow])
      if (w) out.push({ id: `smc:ref:${w.id}`, kind: 'line', tone: 'muted', from: w.originTime, to: null, high: w.price, low: w.price, label: `Swing ${w.kind === 'high' ? 'High' : 'Low'} ${f(w.price)}`, dashed: true });
  for (const b of s.breaks.slice(-10)) {
    if (b.kind === 'BOS' && !t.bos) continue;
    if (b.kind === 'CHOCH' && !t.choch) continue;
    out.push({ id: `smc:brk:${b.id}`, kind: 'line', tone: b.direction === 'bullish' ? 'bull' : 'bear', from: b.originTime, to: b.confirmedAt, high: b.level, low: b.level, label: `${b.direction === 'bullish' ? 'Bullish' : 'Bearish'} ${b.kind}`, labelAt: 'segment', dashed: b.kind === 'BOS', emphasis: b.kind === 'CHOCH' });
  }
  if (t.liquidity && price !== null) {
    const pools = s.liquidity.filter((p) => p.status !== 'LIQUIDITY CONSUMED').sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price)).slice(0, 6);
    for (const p of pools) out.push({ id: `smc:lq:${p.id}`, kind: 'line', tone: 'liquidity', from: p.confirmedAt, to: p.status === 'LIQUIDITY SWEPT' ? p.lastSweepAt : null, high: p.level, low: p.level, label: `${p.kind}${p.status === 'LIQUIDITY SWEPT' ? ' swept' : ''} ${f(p.level)}`, dashed: p.status === 'LIQUIDITY SWEPT' });
  }
  // Accepted close-throughs are continuation (the Liquidity engine's own classification) — not drawn as sweeps.
  if (t.sweeps) for (const w of s.sweeps.filter((x) => x.outcome !== 'accepted').slice(-8)) markers.push({ time: w.time, position: w.side === 'BSL' ? 'aboveBar' : 'belowBar', shape: 'square', color: BLUE, text: `${w.side} sweep${w.reversalBreakId ? ' → CHOCH' : ''}` });
  if (t.orderBlocks && price !== null) {
    const obs = s.orderBlocks.filter((b) => b.live).sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price)).slice(0, 6);
    for (const b of obs) out.push({ id: `smc:ob:${b.id}`, kind: 'zone', tone: b.direction === 'bullish' ? 'bull' : 'bear', from: b.originTime, to: null, high: b.high, low: b.low, label: `${b.direction === 'bullish' ? 'Bullish' : 'Bearish'} OB (${b.timeframe})`, labelAt: 'segment', emphasis: b.fresh });
  }
  if (t.fvg)
    for (const g of s.fvgs.filter((x) => OPEN_FVG.has(x.state)).slice(-8))
      out.push({ id: `smc:fvg:${g.id}`, kind: 'zone', tone: g.direction === 'bullish' ? 'fvgBull' : 'fvgBear', from: g.originTime, to: null, high: g.upper, low: g.lower, label: `FVG ${Math.round(g.fillPct)}%`, labelAt: 'segment', dashed: g.state === 'PARTIALLY_FILLED' });
  if (t.displacement) for (const d of s.displacements.slice(-12)) markers.push({ time: d.confirmedAt, position: d.direction === 'bullish' ? 'belowBar' : 'aboveBar', shape: d.direction === 'bullish' ? 'arrowUp' : 'arrowDown', color: GOLD, text: 'Displacement' });
  if (t.premiumDiscount && s.range && s.location) {
    const r = s.range;
    out.push({ id: 'smc:pd:prem', kind: 'zone', tone: 'premium', from: r.originTime, to: null, high: r.high, low: r.eq, label: 'Premium', labelAt: 'edge' });
    out.push({ id: 'smc:pd:disc', kind: 'zone', tone: 'discount', from: r.originTime, to: null, high: r.eq, low: r.low, label: 'Discount', labelAt: 'edge' });
    out.push({ id: 'smc:pd:eq', kind: 'line', tone: 'eq', from: r.originTime, to: null, high: r.eq, low: r.eq, label: `Equilibrium 50% ${f(r.eq)}`, dashed: true });
  }
  if (t.inducement)
    for (const x of s.inducements.filter((i) => i.state !== 'VOID').slice(-3))
      out.push({ id: `smc:idm:${x.id}`, kind: 'line', tone: 'gold', from: x.originTime, to: x.takenAt, high: x.price, low: x.price, label: `Inducement candidate${x.state === 'TAKEN' ? ' (taken)' : ''}`, labelAt: 'segment', dashed: true });
  if (t.mtf && o.snapshot)
    for (const htf of HIGHER[o.chartTf]) {
      const h = o.snapshot.byTimeframe[htf];
      if (!h || h.dataState !== 'READY') continue;
      if (h.range && h.location) {
        out.push({ id: `smc:mtf:${htf}:hi`, kind: 'line', tone: 'gold', from: null, to: null, high: h.range.high, low: h.range.high, label: `${htf} range high ${f(h.range.high)}`, dashed: true });
        out.push({ id: `smc:mtf:${htf}:lo`, kind: 'line', tone: 'gold', from: null, to: null, high: h.range.low, low: h.range.low, label: `${htf} range low ${f(h.range.low)}`, dashed: true });
      }
      for (const w of [h.refHigh, h.refLow]) if (w) out.push({ id: `smc:mtf:${htf}:${w.id}`, kind: 'line', tone: 'gold', from: null, to: null, high: w.price, low: w.price, label: `${htf} swing ${w.kind} ${f(w.price)}` });
    }
  markers.sort((a, b) => a.time - b.time);
  return { drawables: out, markers };
}

/* ------------------------------- labels -------------------------------- */

export type SmcViewState = 'LIVE' | 'STALE' | 'UNAVAILABLE' | 'INSUFFICIENT_DATA' | 'REPLAY';
export const SMC_VIEW_TITLE: Record<SmcViewState, string> = { LIVE: 'LIVE', STALE: 'DATA STALE', UNAVAILABLE: 'DATA UNAVAILABLE', INSUFFICIENT_DATA: 'INSUFFICIENT DATA', REPLAY: 'REPLAY' };

/** Page state: LIVE only when the feed is actually live AND the chart timeframe has enough closed candles. */
export function smcViewState(o: { feed: SmcFeed; tf: SmcTimeframeSnapshot | null | undefined; replay: boolean; hasProvider: boolean }): SmcViewState {
  if (o.replay) return 'REPLAY';
  if (!o.hasProvider || o.feed === 'DISCONNECTED') return 'UNAVAILABLE';
  if (o.feed === 'STALE') return 'STALE';
  if (!o.tf || o.tf.dataState !== 'READY') return 'INSUFFICIENT_DATA';
  return 'LIVE';
}

export const fmtUtc = (sec: number | null) => (sec === null ? '—' : `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
export const fmtHm = (sec: number | null) => (sec === null ? '—' : new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' '));
export const stateTone = (s: string) => (s === 'BULLISH' || s.startsWith('BULLISH') ? 'bull' : s === 'BEARISH' || s.startsWith('BEARISH') ? 'bear' : s === 'RANGING' || s === 'WAIT' || s === 'MIXED' ? 'warn' : 'muted');
/** Chart timeframe buttons (lowest → highest). */
export const SMC_CHART_TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
export const tfSeconds = (tf: Timeframe) => SMC_TF_SECONDS[tf];
