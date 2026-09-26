import type { Candle } from '../../types/market';
import type { ProfileRow } from './types';

/*
 * VOLUME AT PRICE from OHLC bars. A bar has no intra-bar price×volume, so its volume is ALLOCATED
 * over the rows its [low, high] range touches in proportion to the overlap (a zero-range bar puts all
 * of it in its row). Total volume is conserved exactly; nothing is added or invented.
 * Row size: niceStep(firstOpen × bp / 10 000) rounded up to a whole number of ticks — fixed for the
 * whole profile (from its first bar), so rows never re-bin as the profile grows.
 */
export function niceStep(x: number): number {
  if (!(x > 0)) return 0;
  const k = 10 ** Math.floor(Math.log10(x));
  const m = x / k;
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return n * k;
}
export function rowSize(refPrice: number, bp: number, tick: number): number {
  const s = niceStep((Math.abs(refPrice) * bp) / 10_000);
  if (!(tick > 0)) return s || 1;
  return Math.max(tick, Math.ceil(s / tick - 1e-9) * tick);
}

/** Accumulate bars into a Map<rowIndex, volume>. */
export function accumulate(hist: Map<number, number>, bar: Candle, volume: number, size: number): void {
  const lo = Math.floor(bar.low / size + 1e-9);
  const hi = Math.floor(bar.high / size + 1e-9);
  const range = bar.high - bar.low;
  if (lo === hi || !(range > 0)) {
    hist.set(lo, (hist.get(lo) ?? 0) + volume);
    return;
  }
  for (let i = lo; i <= hi; i++) {
    const overlap = Math.min(bar.high, (i + 1) * size) - Math.max(bar.low, i * size);
    if (overlap > 0) hist.set(i, (hist.get(i) ?? 0) + (volume * overlap) / range);
  }
}

export function rowsOf(hist: Map<number, number>, size: number): ProfileRow[] {
  const keys = [...hist.keys()].sort((a, b) => a - b);
  if (!keys.length) return [];
  const out: ProfileRow[] = [];
  // Dense rows (zeros included) between the lowest and highest traded rows — LVN detection needs them.
  for (let i = keys[0]!; i <= keys[keys.length - 1]!; i++) out.push({ price: round(i * size), volume: hist.get(i) ?? 0 });
  return out;
}
const round = (x: number) => Number(x.toFixed(10));

/*
 * POC: the row with the most volume; ties → the row nearest the profile's mid-range, then the lower row.
 * VALUE AREA (CME two-row method): start at the POC; repeatedly compare the volume of the next two
 * rows above with the next two rows below and add the larger pair (ties → above); a side with no rows
 * left contributes 0; stop when VA volume ≥ target × total. VAH = top edge of the highest VA row,
 * VAL = bottom edge of the lowest VA row, POC price = centre of the POC row.
 */
export function valueArea(rows: readonly ProfileRow[], size: number, target: number) {
  const total = rows.reduce((a, r) => a + r.volume, 0);
  if (!rows.length || !(total > 0)) return null;
  const mid = (rows.length - 1) / 2;
  let p = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i]!.volume;
    const b = rows[p]!.volume;
    if (a > b + 1e-12 || (Math.abs(a - b) <= 1e-12 && Math.abs(i - mid) < Math.abs(p - mid))) p = i;
  }
  let lo = p;
  let hi = p;
  let va = rows[p]!.volume;
  while (va < target * total - 1e-9 && (lo > 0 || hi < rows.length - 1)) {
    const up = (rows[hi + 1]?.volume ?? 0) + (rows[hi + 2]?.volume ?? 0);
    const dn = (rows[lo - 1]?.volume ?? 0) + (rows[lo - 2]?.volume ?? 0);
    const upAvail = hi < rows.length - 1;
    const dnAvail = lo > 0;
    if (upAvail && (!dnAvail || up >= dn)) {
      const n = Math.min(2, rows.length - 1 - hi);
      for (let k = 1; k <= n; k++) va += rows[hi + k]!.volume;
      hi += n;
    } else {
      const n = Math.min(2, lo);
      for (let k = 1; k <= n; k++) va += rows[lo - k]!.volume;
      lo -= n;
    }
  }
  return {
    pocIndex: p,
    poc: round(rows[p]!.price + size / 2),
    pocVolume: rows[p]!.volume,
    vah: round(rows[hi]!.price + size),
    val: round(rows[lo]!.price),
    vaVolume: va,
    total,
  };
}
