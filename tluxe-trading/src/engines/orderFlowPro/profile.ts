import { VALUE_AREA } from './config';

export interface ProfileRow {
  tick: number;
  volume: number;
  buy: number;
  sell: number;
  unknown: number;
}

export interface VolumeProfileResult {
  rows: ProfileRow[]; // ascending tick
  total: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  high: number | null;
  low: number | null;
}

/** Accumulates EXECUTED volume at price (prints only - never resting size, never OHLC estimates). */
export class ProfileAccumulator {
  private rows = new Map<number, ProfileRow>();

  add(tick: number, size: number, side: 'BUY' | 'SELL' | 'UNKNOWN') {
    let r = this.rows.get(tick);
    if (!r) this.rows.set(tick, (r = { tick, volume: 0, buy: 0, sell: 0, unknown: 0 }));
    r.volume += size;
    if (side === 'BUY') r.buy += size;
    else if (side === 'SELL') r.sell += size;
    else r.unknown += size;
  }

  clear() {
    this.rows.clear();
  }

  result(va = VALUE_AREA): VolumeProfileResult {
    return computeProfile([...this.rows.values()], va);
  }
}

/**
 * POC / VAH / VAL. POC = highest-volume price (ties -> the one nearest the profile's middle, then the lower).
 * Value area: the CME two-row method - from the POC, repeatedly add whichever adjacent PAIR of rows (above / below)
 * has more volume, until >= `va` of total volume is inside.
 */
export function computeProfile(input: readonly ProfileRow[], va = VALUE_AREA): VolumeProfileResult {
  const rows = [...input].filter((r) => r.volume > 0).sort((a, b) => a.tick - b.tick);
  const total = rows.reduce((s, r) => s + r.volume, 0);
  if (!rows.length || total <= 0) return { rows, total: 0, poc: null, vah: null, val: null, high: null, low: null };
  const mid = (rows[0]!.tick + rows[rows.length - 1]!.tick) / 2;
  let pi = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i]!;
    const b = rows[pi]!;
    if (a.volume > b.volume || (a.volume === b.volume && Math.abs(a.tick - mid) < Math.abs(b.tick - mid))) pi = i;
  }
  let lo = pi;
  let hi = pi;
  let inside = rows[pi]!.volume;
  const target = total * va;
  while (inside < target && (lo > 0 || hi < rows.length - 1)) {
    const up = (hi + 1 < rows.length ? rows[hi + 1]!.volume : 0) + (hi + 2 < rows.length ? rows[hi + 2]!.volume : 0);
    const dn = (lo - 1 >= 0 ? rows[lo - 1]!.volume : 0) + (lo - 2 >= 0 ? rows[lo - 2]!.volume : 0);
    if (up >= dn && hi < rows.length - 1) {
      const n = Math.min(2, rows.length - 1 - hi);
      for (let k = 0; k < n; k++) inside += rows[++hi]!.volume;
    } else {
      const n = Math.min(2, lo);
      for (let k = 0; k < n; k++) inside += rows[--lo]!.volume;
    }
  }
  return { rows, total, poc: rows[pi]!.tick, vah: rows[hi]!.tick, val: rows[lo]!.tick, high: rows[rows.length - 1]!.tick, low: rows[0]!.tick };
}
