import type { IntensityScale } from '../../engines/orderFlowPro/config';
import type { Side } from '../../engines/orderFlowPro/types';

/* ============================================================================
 * Order Flow Pro liquidity heatmap - tiers and colours (presentation only).
 *
 * Tiers use the SAME instrument-specific reference as the STRONG / MEDIUM classifier (liquidityClass.ts: the
 * time-weighted average displayed size of every recorded price/side 15 s cell over the last 30 min):
 *   VERY STRONG >= p97 (bright yellow) · STRONG >= p90 (gold) · MEDIUM >= p75 (cyan) · WEAK < p75 (dark blue)
 *   no observation -> nothing drawn (transparent)
 * These are RELATIVE to this instrument's own recent book - not an absolute measure of significance. Sizes are IBKR
 * displayed aggregate contracts per price level (time-weighted per cell), never an order count.
 * ========================================================================== */

export type HeatTier = 'VERY_STRONG' | 'STRONG' | 'MEDIUM' | 'WEAK';

export interface HeatTiers {
  medium: number;
  strong: number;
  veryStrong: number;
}

export const TIER_LABEL: Record<HeatTier, string> = { VERY_STRONG: 'VERY STRONG', STRONG: 'STRONG', MEDIUM: 'MEDIUM', WEAK: 'WEAK' };

/** Colour anchors (r, g, b): weak dark blue -> medium cyan -> strong gold -> very strong bright yellow -> white core. */
export const HEAT_RGB = {
  WEAK: [30, 63, 143],
  MEDIUM: [20, 184, 230],
  STRONG: [242, 178, 27],
  VERY_STRONG: [255, 225, 74],
  CORE: [255, 250, 220],
} as const;

export function heatTier(avg: number, t: HeatTiers): HeatTier {
  return avg >= t.veryStrong ? 'VERY_STRONG' : avg >= t.strong ? 'STRONG' : avg >= t.medium ? 'MEDIUM' : 'WEAK';
}

const shape = (f: number, scale: IntensityScale) => (scale === 'sqrt' ? Math.sqrt(f) : scale === 'log' ? Math.log1p(f * 9) / Math.log(10) : f);
const mix = (a: readonly number[], b: readonly number[], f: number) => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * f)) as [number, number, number];

/**
 * Colour + alpha for a cell. `gain` (intensity slider) scales the displayed size before mapping, so it brightens or
 * dims the picture; the TIER of a cell (hover / filters) is always computed from the unscaled size.
 * Smooth: colours interpolate between the anchors; alpha rises with strength (weak cells stay faint).
 */
export function heatColor(avg: number, t: HeatTiers, gain = 1, scale: IntensityScale = 'linear'): { rgb: [number, number, number]; alpha: number } {
  const v = Math.max(0, avg * gain);
  const seg = (lo: number, hi: number) => shape(Math.max(0, Math.min(1, (v - lo) / Math.max(1e-9, hi - lo))), scale);
  if (v < t.medium) {
    const f = seg(0, t.medium);
    return { rgb: mix([12, 24, 70], HEAT_RGB.WEAK, f), alpha: 0.18 + 0.32 * f };
  }
  if (v < t.strong) return { rgb: mix(HEAT_RGB.MEDIUM, mix(HEAT_RGB.MEDIUM, HEAT_RGB.STRONG, 0.35), seg(t.medium, t.strong)), alpha: 0.55 + 0.15 * seg(t.medium, t.strong) };
  if (v < t.veryStrong) return { rgb: mix(HEAT_RGB.STRONG, HEAT_RGB.VERY_STRONG, seg(t.strong, t.veryStrong)), alpha: 0.75 + 0.15 * seg(t.strong, t.veryStrong) };
  return { rgb: mix(HEAT_RGB.VERY_STRONG, HEAT_RGB.CORE, seg(t.veryStrong, t.veryStrong * 2)), alpha: 0.92 };
}

/** One observed cell: a price/side over [t, t + dt) with its time-weighted average displayed contracts. */
export interface HeatCell {
  tick: number;
  side: Side;
  avg: number;
}

/** One time column of observed cells (recorded history or the page's live recorder), covered for `validMs`. */
export interface HeatColumn {
  t: number;
  dt: number;
  validMs: number;
  cells: HeatCell[];
  source: 'RECORDED' | 'LIVE';
}

export interface HeatFilters {
  bid: boolean;
  ask: boolean;
  strongOnly: boolean;
  history: boolean;
}

export const DEFAULT_HEAT_FILTERS: HeatFilters = { bid: true, ask: true, strongOnly: false, history: true };

export const cellVisible = (c: HeatCell, f: HeatFilters, t: HeatTiers) => (c.side === 'BID' ? f.bid : f.ask) && (!f.strongOnly || c.avg >= t.strong);

/** Hover: the cell(s) at (time, tick) and how long that price/side was observed consecutively (never across a gap). */
export interface HeatHover {
  tick: number;
  cells: Array<{ side: Side; avg: number; tier: HeatTier }>;
  t: number;
  dt: number;
  source: 'RECORDED' | 'LIVE';
  /** Consecutive observed time of this price/side around the hovered column (bucket granularity). */
  observedMs: number;
}

/** Binary search: index of the column covering `t` in `cols` (sorted by t), or -1. */
export function columnAt(cols: readonly HeatColumn[], t: number): number {
  let lo = 0;
  let hi = cols.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const c = cols[m]!;
    if (t < c.t) hi = m - 1;
    else if (t >= c.t + c.dt) lo = m + 1;
    else return m;
  }
  return -1;
}

const MAX_RUN = 2000;

export function hoverAt(cols: readonly HeatColumn[], t: number, tick: number, tiers: HeatTiers, f: HeatFilters): HeatHover | null {
  const i = columnAt(cols, t);
  if (i < 0) return null;
  const col = cols[i]!;
  const here = col.cells.filter((c) => c.tick === tick && cellVisible(c, f, tiers));
  if (!here.length) return null;
  // observed duration of the strongest side at this price: walk adjacent, contiguous columns (a gap ends the run)
  const side = here.reduce((a, b) => (b.avg > a.avg ? b : a)).side;
  const has = (c: HeatColumn) => c.cells.some((x) => x.tick === tick && x.side === side);
  let a = i;
  let b = i;
  while (a > 0 && i - a < MAX_RUN && cols[a - 1]!.t + cols[a - 1]!.dt === cols[a]!.t && has(cols[a - 1]!)) a--;
  while (b < cols.length - 1 && b - i < MAX_RUN && cols[b]!.t + cols[b]!.dt === cols[b + 1]!.t && has(cols[b + 1]!)) b++;
  return {
    tick,
    cells: here.map((c) => ({ side: c.side, avg: c.avg, tier: heatTier(c.avg, tiers) })),
    t: col.t,
    dt: col.dt,
    source: col.source,
    observedMs: cols[b]!.t + cols[b]!.dt - cols[a]!.t,
  };
}
