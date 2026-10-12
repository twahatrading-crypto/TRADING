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

/** Pick the K largest values' threshold so at most `k` items pass (adaptive bubble density). */
export function topKThreshold(values: readonly number[], k: number): number {
  if (k <= 0 || !values.length) return Infinity;
  if (values.length <= k) return Math.min(...values);
  const s = [...values].sort((a, b) => b - a);
  return s[k - 1]!;
}
