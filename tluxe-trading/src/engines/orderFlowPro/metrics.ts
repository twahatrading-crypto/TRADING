import type { FootprintBar } from './footprint';
import type { QuoteEvent } from './types';

export interface SeriesPoint {
  t: number;
  v: number;
  /** True when part of the value could not be computed (UNKNOWN-side prints excluded / bars without prints). */
  partial: boolean;
}

/** Per-bar executed volume (prints + historical bar volume). */
export const volumeSeries = (bars: readonly FootprintBar[]): SeriesPoint[] => bars.map((b) => ({ t: b.t, v: b.volume, partial: b.source !== 'TRADES' }));

/** Per-bar delta of CLASSIFIED prints; bars without prints are skipped (never estimated from OHLC). */
export const deltaSeries = (bars: readonly FootprintBar[]): SeriesPoint[] =>
  bars.filter((b) => b.delta !== null).map((b) => ({ t: b.t, v: b.delta!, partial: b.unknown > 0 || b.source !== 'TRADES' }));

/** Cumulative delta across the given bars (bars without prints keep the running value and mark it partial). */
export function cvdSeries(bars: readonly FootprintBar[]): SeriesPoint[] {
  let run = 0;
  let partial = false;
  const out: SeriesPoint[] = [];
  for (const b of bars) {
    if (b.delta === null) {
      partial = true;
      continue;
    }
    run += b.delta;
    if (b.unknown > 0 || b.source !== 'TRADES') partial = true;
    out.push({ t: b.t, v: run, partial });
  }
  return out;
}

/**
 * Top-of-book order-flow imbalance (Cont, Kukanov & Stoikov 2014) from consecutive IBKR quotes:
 *   e = 1[bid >= bid'] * bidSize - 1[bid <= bid'] * bidSize' - 1[ask <= ask'] * askSize + 1[ask >= ask'] * askSize'
 * (primes = previous quote). Positive = net buying pressure on the displayed best levels. Quote-based, independent
 * of trade classification.
 */
export class OfiTracker {
  private prev: QuoteEvent | null = null;

  add(q: QuoteEvent): number | null {
    const p = this.prev;
    if (q.bid == null || q.ask == null || q.bidSize == null || q.askSize == null) {
      this.prev = null;
      return null;
    }
    this.prev = q;
    if (!p || p.bid == null || p.ask == null || p.bidSize == null || p.askSize == null) return null;
    let e = 0;
    if (q.bid >= p.bid) e += q.bidSize;
    if (q.bid <= p.bid) e -= p.bidSize;
    if (q.ask <= p.ask) e -= q.askSize;
    if (q.ask >= p.ask) e += p.askSize;
    return e;
  }

  reset() {
    this.prev = null;
  }
}
