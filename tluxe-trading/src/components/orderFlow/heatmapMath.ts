import type { HeatmapViewSettings } from '../../engines/orderFlow/config';
import type { HeatmapColumn } from '../../engines/orderFlow/engine';

/**
 * Pure render-time maths for the liquidity heatmap (unit-tested). Nothing here touches engine
 * state: it only turns displayed sizes into colours for the visible window.
 */

export interface Viewport {
  /** Visible exchange-time range (ms). */
  t0: number;
  t1: number;
  /** Visible price range in TICKS (p0 < p1). */
  p0: number;
  p1: number;
}

/** q-th percentile (0–100) of positive values; 0 when there are none. */
export function percentile(values: Float64Array | number[], q: number): number {
  const v = Array.from(values).filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const idx = Math.min(v.length - 1, Math.max(0, Math.round((q / 100) * (v.length - 1))));
  return v[idx]!;
}

/** Displayed size → 0..1 intensity: cut-offs, then contrast (x^contrast). Below min depth = 0. */
export function intensity(v: number, lo: number, hi: number, contrast: number, minDepth: number): number {
  if (!(v > 0) || v < minDepth) return 0;
  if (hi <= lo) return v >= hi ? 1 : 0;
  const x = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return Math.pow(x, Math.max(0.1, contrast));
}

type Stop = [number, number, number, number];
const SCHEMES: Record<HeatmapViewSettings['colorScheme'], Stop[]> = {
  'blue-red': [
    [0, 8, 14, 32],
    [0.25, 22, 58, 138],
    [0.5, 14, 165, 233],
    [0.72, 250, 204, 21],
    [0.88, 249, 115, 22],
    [1, 239, 68, 68],
  ].map((s) => [s[0]!, s[1]!, s[2]!, s[3]!] as Stop),
  mono: [
    [0, 8, 12, 20],
    [1, 235, 238, 245],
  ],
  thermal: [
    [0, 6, 6, 12],
    [0.35, 88, 28, 135],
    [0.65, 234, 88, 12],
    [1, 253, 224, 71],
  ],
};

/** 0..1 → RGB for the scheme (x = 0 is the background colour). */
export function colorAt(x: number, scheme: HeatmapViewSettings['colorScheme']): [number, number, number] {
  const st = SCHEMES[scheme];
  const v = Math.max(0, Math.min(1, x));
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1]!;
    const b = st[i]!;
    if (v <= b[0]) {
      const f = (v - a[0]) / (b[0] - a[0] || 1);
      return [Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f), Math.round(a[3] + (b[3] - a[3]) * f)];
    }
  }
  const l = st[st.length - 1]!;
  return [l[1], l[2], l[3]];
}

/** Displayed size (bid + ask) per price row for one column; row r covers ticks [p0 + r·agg, p0 + (r+1)·agg). */
export function columnRows(c: HeatmapColumn, p0: number, rows: number, agg: number): Float64Array {
  const out = new Float64Array(rows);
  const put = (ticks: Int32Array, sizes: Float64Array) => {
    for (let i = 0; i < ticks.length; i++) {
      const r = Math.floor((ticks[i]! - p0) / agg);
      if (r >= 0 && r < rows) out[r] = out[r]! + sizes[i]!;
    }
  };
  put(c.bidTicks, c.bidSizes);
  put(c.askTicks, c.askSizes);
  return out;
}

/** Vertical box smoothing (radius in rows). Radius 0 returns the input. */
export function smooth(rowsV: Float64Array, radius: number): Float64Array {
  if (radius <= 0) return rowsV;
  const out = new Float64Array(rowsV.length);
  for (let i = 0; i < rowsV.length; i++) {
    let s = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= rowsV.length) continue;
      s += rowsV[j]!;
      n += 1;
    }
    out[i] = s / n;
  }
  return out;
}

/** Normalisation bounds for the visible window (auto) or the whole retained history (fixed). */
export function bounds(cols: readonly HeatmapColumn[], view: HeatmapViewSettings, visible: readonly HeatmapColumn[]): { lo: number; hi: number } {
  const src = view.autoNormalize ? visible : cols;
  const vals: number[] = [];
  for (const c of src) {
    if (!c.valid) continue;
    for (const v of c.bidSizes) vals.push(v);
    for (const v of c.askSizes) vals.push(v);
  }
  return { lo: percentile(vals, view.lowerCutoff), hi: percentile(vals, view.upperCutoff) };
}
