import type { BookLevel, BookSide, DepthLevelIn, OrderBookView } from './types';

/**
 * Displayed order book keyed by INTEGER TICKS (price / tickSize, rounded), so float drift can
 * never split or merge levels. Holds exactly what the provider published — levels it has not
 * published do not exist (never interpolated or invented).
 */
export class OrderBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();

  constructor(readonly tickSize: number) {}

  tick(price: number): number {
    return Math.round(price / this.tickSize);
  }
  price(tick: number): number {
    // Round to the tick's decimals so 24368 × 0.1 prints as 2436.8, not 2436.7999999.
    const dec = Math.max(0, Math.ceil(-Math.log10(this.tickSize) - 1e-9));
    return Number((tick * this.tickSize).toFixed(dec));
  }
  side(s: BookSide): Map<number, number> {
    return s === 'bid' ? this.bids : this.asks;
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
  }

  load(bids: readonly DepthLevelIn[], asks: readonly DepthLevelIn[]): void {
    this.clear();
    for (const l of bids) if (l.size > 0) this.bids.set(this.tick(l.price), l.size);
    for (const l of asks) if (l.size > 0) this.asks.set(this.tick(l.price), l.size);
  }

  /** Sets the level's displayed size (0 removes it). Returns the previous size. */
  set(side: BookSide, tick: number, size: number): number {
    const m = this.side(side);
    const prev = m.get(tick) ?? 0;
    if (size > 0) m.set(tick, size);
    else m.delete(tick);
    return prev;
  }

  size(side: BookSide, tick: number): number {
    return this.side(side).get(tick) ?? 0;
  }

  bestBidTick(): number | null {
    let best: number | null = null;
    for (const t of this.bids.keys()) if (best === null || t > best) best = t;
    return best;
  }
  bestAskTick(): number | null {
    let best: number | null = null;
    for (const t of this.asks.keys()) if (best === null || t < best) best = t;
    return best;
  }

  /** Book view: bids high→low, asks low→high (up to `levels` per side when given). */
  view(valid: boolean, levels?: number): OrderBookView {
    const bidTicks = [...this.bids.keys()].sort((a, b) => b - a);
    const askTicks = [...this.asks.keys()].sort((a, b) => a - b);
    const take = (ts: number[], m: Map<number, number>): BookLevel[] => (levels ? ts.slice(0, levels) : ts).map((t) => ({ price: this.price(t), size: m.get(t)! }));
    const bb = bidTicks[0] ?? null;
    const ba = askTicks[0] ?? null;
    let totalBid = 0;
    let totalAsk = 0;
    for (const v of this.bids.values()) totalBid += v;
    for (const v of this.asks.values()) totalAsk += v;
    return {
      bids: take(bidTicks, this.bids),
      asks: take(askTicks, this.asks),
      bestBid: bb === null ? null : this.price(bb),
      bestAsk: ba === null ? null : this.price(ba),
      spread: bb === null || ba === null ? null : this.price(ba - bb),
      totalBid,
      totalAsk,
      valid,
      crossed: bb !== null && ba !== null && ba <= bb,
    };
  }

  /** Compact copy for the heatmap column: parallel arrays of ticks and sizes. */
  compact(side: BookSide): { ticks: Int32Array; sizes: Float64Array } {
    const m = this.side(side);
    const ticks = new Int32Array(m.size);
    const sizes = new Float64Array(m.size);
    let i = 0;
    for (const [t, s] of m) {
      ticks[i] = t;
      sizes[i] = s;
      i += 1;
    }
    return { ticks, sizes };
  }
}
