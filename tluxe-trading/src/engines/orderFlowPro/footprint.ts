import { IMBALANCE_RATIO, MAX_BARS, STACKED_MIN } from './config';
import { toTick } from './classify';
import type { BarEvent, TradeEvent } from './types';

export interface LevelVolume {
  buy: number;
  sell: number;
  unknown: number;
}

export interface Imbalance {
  tick: number;
  side: 'BUY' | 'SELL';
  ratio: number;
}

export interface StackedImbalance {
  fromTick: number;
  toTick: number;
  side: 'BUY' | 'SELL';
}

/**
 * One candle. `source`:
 *   TRADES      - built only from eligible prints (footprint valid);
 *   BARS_ONLY   - an IBKR historical OHLCV bar, no prints -> NO footprint, delta or imbalance (never fabricated);
 *   MIXED       - a historical bar later covered partly by prints -> footprint is PARTIAL (prints only).
 */
export interface FootprintBar {
  t: number;
  ms: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  buy: number;
  sell: number;
  unknown: number;
  /** buy - sell of CLASSIFIED prints only; null when the bar has no prints. */
  delta: number | null;
  trades: number;
  levels: Map<number, LevelVolume>;
  source: 'TRADES' | 'BARS_ONLY' | 'MIXED';
  closed: boolean;
}

const newBar = (t: number, ms: number, price: number): FootprintBar => ({
  t, ms, o: price, h: price, l: price, c: price, volume: 0, buy: 0, sell: 0, unknown: 0, delta: null, trades: 0, levels: new Map(), source: 'TRADES', closed: false,
});

/** Incremental candle + footprint builder for one timeframe. Late prints for closed bars are excluded (no repaint). */
export class FootprintBuilder {
  private bars = new Map<number, FootprintBar>();
  private order: number[] = [];
  lateExcluded = 0;

  constructor(readonly ms: number, readonly tick: number, private readonly maxBars = MAX_BARS) {}

  private slot(t: number) {
    return Math.floor(t / this.ms) * this.ms;
  }

  private insert(bar: FootprintBar) {
    this.bars.set(bar.t, bar);
    // keep `order` sorted (appends are the normal case)
    if (!this.order.length || bar.t > this.order[this.order.length - 1]!) this.order.push(bar.t);
    else {
      this.order.push(bar.t);
      this.order.sort((a, b) => a - b);
    }
    while (this.order.length > this.maxBars) this.bars.delete(this.order.shift()!);
  }

  addBar(b: BarEvent) {
    const t = this.slot(b.t);
    const ex = this.bars.get(t);
    if (ex) {
      if (ex.source === 'TRADES' && ex.trades > 0) {
        ex.source = 'MIXED';
        ex.o = b.o;
        ex.h = Math.max(ex.h, b.h);
        ex.l = Math.min(ex.l, b.l);
      }
      return;
    }
    this.insert({ t, ms: this.ms, o: b.o, h: b.h, l: b.l, c: b.c, volume: b.v, buy: 0, sell: 0, unknown: 0, delta: null, trades: 0, levels: new Map(), source: 'BARS_ONLY', closed: true });
  }

  addTrade(tr: TradeEvent) {
    const t = this.slot(tr.t);
    let bar = this.bars.get(t);
    if (bar?.closed && bar.source !== 'BARS_ONLY') {
      this.lateExcluded++;
      return;
    }
    if (!bar) {
      const last = this.order[this.order.length - 1];
      if (last !== undefined && t < last) {
        this.lateExcluded++;
        return;
      }
      bar = newBar(t, this.ms, tr.price);
      this.insert(bar);
    } else if (bar.source === 'BARS_ONLY') {
      // A historical bar now receives prints: OHLC stays the bar's, the footprint holds only the prints seen.
      bar.source = 'MIXED';
      bar.closed = false;
      bar.volume = 0;
    }
    if (bar.trades === 0 && bar.source === 'TRADES') bar.o = tr.price;
    bar.h = Math.max(bar.h, tr.price);
    bar.l = Math.min(bar.l, tr.price);
    bar.c = tr.price;
    bar.volume += tr.size;
    bar.trades++;
    const k = toTick(tr.price, this.tick);
    let lv = bar.levels.get(k);
    if (!lv) bar.levels.set(k, (lv = { buy: 0, sell: 0, unknown: 0 }));
    if (tr.aggressor === 'BUY') {
      lv.buy += tr.size;
      bar.buy += tr.size;
    } else if (tr.aggressor === 'SELL') {
      lv.sell += tr.size;
      bar.sell += tr.size;
    } else {
      lv.unknown += tr.size;
      bar.unknown += tr.size;
    }
    bar.delta = bar.buy - bar.sell;
  }

  /** Close every bar that ended before `now`. */
  closeUpTo(now: number) {
    for (const t of this.order) {
      const b = this.bars.get(t)!;
      if (!b.closed && t + this.ms <= now) b.closed = true;
    }
  }

  list(): FootprintBar[] {
    return this.order.map((t) => this.bars.get(t)!);
  }

  clear() {
    this.bars.clear();
    this.order = [];
    this.lateExcluded = 0;
  }
}

/** Point of control of one bar (highest total volume; ties -> the lower price). */
export function barPoc(bar: FootprintBar): number | null {
  let best: number | null = null;
  let bestV = -1;
  for (const [k, lv] of bar.levels) {
    const v = lv.buy + lv.sell + lv.unknown;
    if (v > bestV || (v === bestV && best !== null && k < best)) {
      best = k;
      bestV = v;
    }
  }
  return best;
}

/**
 * Diagonal imbalances: BUY at p when buy(p) >= ratio x sell(p - 1 tick); SELL at p when sell(p) >= ratio x buy(p + 1 tick).
 * A zero opposite side counts only when this side has at least `minVolume`. UNKNOWN volume is never used.
 */
export function imbalances(bar: FootprintBar, ratio = IMBALANCE_RATIO, minVolume = 2): Imbalance[] {
  const out: Imbalance[] = [];
  for (const [k, lv] of bar.levels) {
    const below = bar.levels.get(k - 1);
    const above = bar.levels.get(k + 1);
    const sellBelow = below?.sell ?? 0;
    const buyAbove = above?.buy ?? 0;
    if (lv.buy >= minVolume && lv.buy >= ratio * sellBelow) out.push({ tick: k, side: 'BUY', ratio: sellBelow ? lv.buy / sellBelow : Infinity });
    if (lv.sell >= minVolume && lv.sell >= ratio * buyAbove) out.push({ tick: k, side: 'SELL', ratio: buyAbove ? lv.sell / buyAbove : Infinity });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

/** Runs of >= `min` same-side imbalances on consecutive ticks. */
export function stackedImbalances(list: readonly Imbalance[], min = STACKED_MIN): StackedImbalance[] {
  const out: StackedImbalance[] = [];
  for (const side of ['BUY', 'SELL'] as const) {
    const ticks = list.filter((i) => i.side === side).map((i) => i.tick).sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= ticks.length; i++) {
      if (i < ticks.length && ticks[i] === ticks[i - 1]! + 1) continue;
      if (i - start >= min) out.push({ fromTick: ticks[start]!, toTick: ticks[i - 1]!, side });
      start = i;
    }
  }
  return out;
}
