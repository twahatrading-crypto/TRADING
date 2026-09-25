import type { Candle } from '../../types/market';
import type { HLESwing, RawBias, StructureContext } from './types';

/** Confirmed pivot: index into its series, known once bar index + k has closed. */
export interface Pivot {
  index: number;
  time: number;
  price: number;
}

/**
 * One timeframe of CLOSED candles (High / Low Engine only). Keeps, at every index:
 *  ATR    Wilder ATR (TR = max(h−l, |h−prevClose|, |l−prevClose|)), so a past bar is judged
 *         by the ATR that existed at that bar (handoff A2);
 *  PIVOTS VPR.swings semantics: a pivot at i needs k bars STRICTLY lower (highs) / higher
 *         (lows) on BOTH sides — an equal neighbour disqualifies — and exists only once bar
 *         i + k has closed (handoff §3, A3).
 */
export class Tf {
  readonly bars: Candle[] = [];
  readonly atr: number[] = [];
  readonly highs: Pivot[] = [];
  readonly lows: Pivot[] = [];

  constructor(
    readonly sec: number,
    readonly k: number,
    private readonly atrLen: number,
  ) {}

  get length(): number {
    return this.bars.length;
  }
  closeAt(i: number): number {
    return this.bars[i]!.time + this.sec;
  }
  /** ATR at bar i (null before it exists). */
  atrAt(i: number): number | null {
    const a = this.atr[i];
    return a !== undefined && a > 0 ? a : null;
  }
  lastAtr(): number | null {
    return this.length ? this.atrAt(this.length - 1) : null;
  }

  push(bar: Candle): void {
    const i = this.bars.length;
    const prev = this.bars[i - 1];
    this.bars.push(bar);
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    const n = this.atrLen;
    let a = Number.NaN;
    if (i === n - 1) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const b = this.bars[j]!;
        const pb = this.bars[j - 1];
        sum += pb ? Math.max(b.high - b.low, Math.abs(b.high - pb.close), Math.abs(b.low - pb.close)) : b.high - b.low;
      }
      a = sum / n;
    } else if (i >= n) a = (this.atr[i - 1]! * (n - 1) + tr) / n;
    this.atr.push(a);

    const p = i - this.k;
    if (p < this.k) return;
    const c = this.bars[p]!;
    let isH = true;
    let isL = true;
    for (let j = p - this.k; j <= p + this.k; j++) {
      if (j === p) continue;
      if (this.bars[j]!.high >= c.high) isH = false;
      if (this.bars[j]!.low <= c.low) isL = false;
    }
    if (isH) this.highs.push({ index: p, time: c.time, price: c.high });
    if (isL) this.lows.push({ index: p, time: c.time, price: c.low });
  }

  /** First index whose bar OPENS at or after t (−1 if none). */
  firstFrom(t: number): number {
    let lo = 0;
    let hi = this.bars.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.bars[m]!.time < t) lo = m + 1;
      else hi = m;
    }
    return lo < this.bars.length ? lo : -1;
  }
  /** Last index whose bar has CLOSED by K (−1 if none). */
  lastClosedBy(K: number): number {
    let lo = 0;
    let hi = this.bars.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.bars[m]!.time + this.sec <= K) lo = m + 1;
      else hi = m;
    }
    return lo - 1;
  }
  /** Pivots with index ≥ from that are confirmed within the first `len` bars (VPR.swings(bars[0..len), k, from)). */
  pivots(kind: 'high' | 'low', from: number, len: number): Pivot[] {
    const src = kind === 'high' ? this.highs : this.lows;
    const lo = Math.max(this.k, from);
    const out: Pivot[] = [];
    for (let j = src.length - 1; j >= 0; j--) {
      const p = src[j]!;
      if (p.index < lo) break;
      if (p.index + this.k <= len - 1) out.push(p);
    }
    return out.reverse();
  }
  swing(p: Pivot, kind: 'high' | 'low'): HLESwing {
    return { kind, time: p.time, price: p.price, confirmedAt: this.closeAt(p.index + this.k) };
  }
}

/** VPR.structureBias over the first `len` bars: the last two confirmed swing highs and lows. */
export function structureBias(tf: Tf, len: number, scan: number, minBars = 60): { dir: -1 | 0 | 1; label: RawBias; reason: string; highs: Pivot[]; lows: Pivot[] } {
  const from = Math.max(0, len - scan);
  const highs = tf.pivots('high', from, len);
  const lows = tf.pivots('low', from, len);
  if (len < minBars) return { dir: 0, label: 'UNKNOWN', reason: 'insufficient history', highs, lows };
  const hs = highs.slice(-2);
  const ls = lows.slice(-2);
  if (hs.length < 2 || ls.length < 2) return { dir: 0, label: 'UNCLEAR', reason: 'not enough confirmed swings', highs, lows };
  const hh = hs[1]!.price > hs[0]!.price;
  const hl = ls[1]!.price > ls[0]!.price;
  const lh = hs[1]!.price < hs[0]!.price;
  const ll = ls[1]!.price < ls[0]!.price;
  if (hh && hl) return { dir: 1, label: 'BULLISH', reason: 'higher high and higher low', highs, lows };
  if (lh && ll) return { dir: -1, label: 'BEARISH', reason: 'lower high and lower low', highs, lows };
  return { dir: 0, label: 'RANGING', reason: 'mixed swing sequence', highs, lows };
}

/** H4 direction / H1 bias (handoff §3). Context only: never a gate. */
export function directionOf(tf: Tf, minBars: number, scan: number): StructureContext {
  const len = tf.length;
  const sb = structureBias(tf, len, scan, minBars);
  const at = (a: Pivot[], k: number, kind: 'high' | 'low') => {
    const p = a[a.length - k];
    return p ? tf.swing(p, kind) : null;
  };
  const base = {
    raw: sb.label,
    dir: sb.dir,
    reason: sb.reason,
    lastSwingHigh: at(sb.highs, 1, 'high'),
    prevSwingHigh: at(sb.highs, 2, 'high'),
    lastSwingLow: at(sb.lows, 1, 'low'),
    prevSwingLow: at(sb.lows, 2, 'low'),
    bars: len,
    required: minBars,
  };
  if (len < minBars) return { ...base, bias: 'INSUFFICIENT_DATA', structure: `Waiting for data — need ${minBars} closed candles, have ${len}`, strength: null };
  let strength: StructureContext['strength'] = null;
  if (sb.dir !== 0) {
    let agree = 0;
    let total = 0;
    for (const arr of [sb.highs, sb.lows])
      for (let i = Math.max(1, arr.length - 4); i < arr.length; i++) {
        total += 1;
        if (sb.dir > 0 ? arr[i]!.price > arr[i - 1]!.price : arr[i]!.price < arr[i - 1]!.price) agree += 1;
      }
    strength = { value: total ? agree / total : 0, agree, total };
  }
  const structure =
    sb.dir > 0 ? 'Higher High + Higher Low (last two swings)' : sb.dir < 0 ? 'Lower High + Lower Low (last two swings)' : sb.label === 'RANGING' ? 'Mixed swing sequence' : sb.reason;
  return { ...base, bias: sb.dir > 0 ? 'BULLISH' : sb.dir < 0 ? 'BEARISH' : 'NEUTRAL', structure, strength };
}

/** Asia/Tokyo 09:00–18:00 local, weekdays (Tokyo observes no DST: UTC+9 all year). */
export function inAsia(t: number, start: number, end: number): boolean {
  const local = t + 9 * 3600;
  const day = Math.floor(local / 86400);
  const dow = (day + 4) % 7; // 1970-01-01 was a Thursday
  if (dow === 0 || dow === 6) return false;
  const h = Math.floor((local - day * 86400) / 3600);
  return h >= start && h < end;
}
