/**
 * Vertical label de-overlap for chart / axis tags: keeps the input order by y, enforces a minimum gap, and keeps
 * every label inside [top, bottom]. Returns the adjusted y for each input (same order as given).
 */
export function spreadLabels(ys: readonly number[], gap: number, top: number, bottom: number): number[] {
  const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = idx.map((o) => Math.min(bottom, Math.max(top, o.y)));
  for (let k = 1; k < out.length; k++) out[k] = Math.max(out[k]!, out[k - 1]! + gap);
  if (out.length && out[out.length - 1]! > bottom) {
    out[out.length - 1] = bottom;
    for (let k = out.length - 2; k >= 0; k--) out[k] = Math.min(out[k]!, out[k + 1]! - gap);
  }
  const res = new Array<number>(ys.length);
  idx.forEach((o, k) => (res[o.i] = out[k]!));
  return res;
}

/**
 * Label slots for the liquidity lane: as many labels as fit between top and bottom at `gap` spacing, chosen in the
 * given priority order (first = most important); the kept labels are de-overlapped with spreadLabels. Labels that
 * do not fit get null (never drawn on top of another one).
 */
export function laneLabelSlots(ys: readonly number[], gap: number, top: number, bottom: number): Array<number | null> {
  const cap = bottom >= top ? Math.floor((bottom - top) / gap) + 1 : 0;
  const keep = ys.slice(0, cap);
  const placed = spreadLabels(keep, gap, top, bottom);
  return ys.map((_, i) => (i < keep.length ? placed[i]! : null));
}

/** Compact duration: 45 s · 4m 10s · 1h 05m. */
export function fmtRest(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Contracts: whole numbers as is, averages with one decimal. */
export const fmtQty = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Pick the K largest values' threshold so at most `k` items pass (adaptive bubble density). */
export function topKThreshold(values: readonly number[], k: number): number {
  if (k <= 0 || !values.length) return Infinity;
  if (values.length <= k) return Math.min(...values);
  const s = [...values].sort((a, b) => b - a);
  return s[k - 1]!;
}
