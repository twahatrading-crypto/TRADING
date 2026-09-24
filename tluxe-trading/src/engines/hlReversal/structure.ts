import type { Candle } from '../../types/market';
import type { HLRBreak, HLRSwing } from './types';

type RtSwing = HLRSwing & { index: number; confirmedIndex: number; broken: boolean };

/**
 * One timeframe of CLOSED candles for the High / Low Reversal engine (its own code,
 * independent of the other engines): Wilder ATR, swings and structure breaks.
 *
 * SWING  high at c: high[c] > each of the `left` highs before it and ≥ each of the
 *        `right` highs after it; confirmed on the close of bar c + right. Lows mirror.
 * BREAK  a CLOSE beyond the most recent unbroken swing confirmed on an EARLIER bar.
 *        CHOCH when against the direction of the previous break, otherwise BOS.
 *        Evaluated before this bar's own swing confirmation. Wicks never break.
 */
export class Series {
  readonly bars: Candle[] = [];
  readonly atrs: number[] = [];
  readonly swings: RtSwing[] = [];
  readonly breaks: HLRBreak[] = [];
  trend: 'up' | 'down' | null = null;

  constructor(
    readonly tfSec: number,
    private readonly left: number,
    private readonly right: number,
    private readonly atrPeriod: number,
  ) {}

  get length(): number {
    return this.bars.length;
  }
  atr(): number | null {
    const a = this.atrs[this.atrs.length - 1];
    return a !== undefined && a > 0 ? a : null;
  }
  knownAt(i: number): number {
    return this.bars[i]!.time + this.tfSec;
  }

  /** Append one closed bar (caller guarantees strictly increasing time). Returns what it produced. */
  push(bar: Candle): { swings: HLRSwing[]; breaks: HLRBreak[] } {
    const i = this.bars.length;
    const prev = this.bars[i - 1];
    this.bars.push(bar);
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    const p = this.atrPeriod;
    let atr = Number.NaN;
    if (i === p - 1) {
      let sum = tr;
      for (let k = 1; k < p; k++) {
        const b = this.bars[i - k]!;
        const pb = this.bars[i - k - 1];
        sum += pb ? Math.max(b.high - b.low, Math.abs(b.high - pb.close), Math.abs(b.low - pb.close)) : b.high - b.low;
      }
      atr = sum / p;
    } else if (i >= p) atr = (this.atrs[i - 1]! * (p - 1) + tr) / p;
    this.atrs.push(atr);

    const breaks: HLRBreak[] = [];
    for (const dir of ['up', 'down'] as const) {
      const b = this.detectBreak(i, dir);
      if (b) breaks.push(b);
    }
    return { swings: this.detectSwings(i), breaks };
  }

  private detectBreak(i: number, dir: 'up' | 'down'): HLRBreak | null {
    const kind = dir === 'up' ? 'high' : 'low';
    let target: RtSwing | null = null;
    for (let k = this.swings.length - 1; k >= 0; k--) {
      const sw = this.swings[k]!;
      if (sw.kind === kind && !sw.broken && sw.confirmedIndex < i) {
        target = sw;
        break;
      }
    }
    if (!target) return null;
    const bar = this.bars[i]!;
    const s = dir === 'up' ? 1 : -1;
    if (!(s * bar.close > s * target.price)) return null;
    for (const sw of this.swings) if (sw.kind === kind && !sw.broken && sw.confirmedIndex < i && s * bar.close > s * sw.price) sw.broken = true;
    const brk: HLRBreak = {
      direction: dir,
      kind: this.trend !== null && this.trend !== dir ? 'CHOCH' : 'BOS',
      level: target.price,
      swingTime: target.time,
      time: bar.time,
      knownAt: bar.time + this.tfSec,
      close: bar.close,
    };
    this.trend = dir;
    this.breaks.push(brk);
    return brk;
  }

  private detectSwings(i: number): HLRSwing[] {
    const L = this.left;
    const R = this.right;
    const c = i - R;
    if (c - L < 0) return [];
    const b = this.bars;
    const pc = b[c]!;
    let hi = true;
    let lo = true;
    for (let j = c - L; j < c; j++) {
      if (!(pc.high > b[j]!.high)) hi = false;
      if (!(pc.low < b[j]!.low)) lo = false;
    }
    for (let j = c + 1; j <= c + R; j++) {
      if (!(pc.high >= b[j]!.high)) hi = false;
      if (!(pc.low <= b[j]!.low)) lo = false;
    }
    const out: HLRSwing[] = [];
    const base = { time: pc.time, confirmedAt: b[i]!.time + this.tfSec, index: c, confirmedIndex: i, broken: false };
    if (hi) {
      this.swings.push({ ...base, kind: 'high', price: pc.high });
      out.push({ kind: 'high', time: pc.time, price: pc.high, confirmedAt: base.confirmedAt });
    }
    if (lo) {
      this.swings.push({ ...base, kind: 'low', price: pc.low });
      out.push({ kind: 'low', time: pc.time, price: pc.low, confirmedAt: base.confirmedAt });
    }
    return out;
  }

  /** Confirmed swings of a kind that no close has broken yet. */
  unbroken(kind: 'high' | 'low'): HLRSwing[] {
    return this.swings.filter((s) => s.kind === kind && !s.broken).map((s) => ({ kind: s.kind, time: s.time, price: s.price, confirmedAt: s.confirmedAt }));
  }

  /** Last `n` confirmed swings of a kind (oldest first). */
  lastSwings(kind: 'high' | 'low', n: number): HLRSwing[] {
    const out: HLRSwing[] = [];
    for (let k = this.swings.length - 1; k >= 0 && out.length < n; k--) {
      const s = this.swings[k]!;
      if (s.kind === kind) out.unshift({ kind: s.kind, time: s.time, price: s.price, confirmedAt: s.confirmedAt });
    }
    return out;
  }
}
