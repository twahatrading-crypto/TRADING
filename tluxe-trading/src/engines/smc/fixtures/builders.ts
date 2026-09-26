/**
 * TEST DATA ONLY — deterministic synthetic candles for SMC unit tests and the dev harness.
 * Never imported by production code; never shown as market data.
 */
import type { Candle, Timeframe } from '../../../types/market';
import { SMC_TF_SECONDS } from '../config';

export const T0 = Date.UTC(2026, 0, 5) / 1000; // Mon 2026-01-05 00:00Z

/** Piecewise-linear close path: start, then [target, bars] legs. */
export function path(start: number, ...legs: [to: number, n: number][]): number[] {
  const out: number[] = [];
  let cur = start;
  for (const [to, n] of legs) {
    for (let k = 1; k <= n; k++) out.push(Number((cur + ((to - cur) * k) / n).toFixed(5)));
    cur = to;
  }
  return out;
}

/** Candles from closes: open = previous close, wick `w` beyond the body; per-index overrides. */
export function candles(closes: readonly number[], o: { tf?: Timeframe; w?: number; t0?: number; start?: number; ov?: Record<number, Partial<Candle>> } = {}): Candle[] {
  const tf = SMC_TF_SECONDS[o.tf ?? 'M15'];
  const w = o.w ?? 0.3;
  let prev = o.start ?? closes[0]!;
  return closes.map((c, i) => {
    const open = prev;
    prev = c;
    const base: Candle = { time: (o.t0 ?? T0) + i * tf, open, high: Math.max(open, c) + w, low: Math.min(open, c) - w, close: c, volume: null };
    return { ...base, ...(o.ov?.[i] ?? {}) };
  });
}

/** Seeded PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random-walk candles (fuzz). */
export function walk(n: number, o: { seed: number; start?: number; vol?: number; tf?: Timeframe; t0?: number }): Candle[] {
  const r = prng(o.seed);
  const tf = SMC_TF_SECONDS[o.tf ?? 'M15'];
  const vol = o.vol ?? 1;
  let c = o.start ?? 100;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = c;
    c = Number((c + (r() - 0.5) * 2 * vol + (r() < 0.03 ? (r() - 0.5) * 8 * vol : 0)).toFixed(4));
    const hi = Math.max(open, c) + r() * vol * 0.6;
    const lo = Math.min(open, c) - r() * vol * 0.6;
    out.push({ time: (o.t0 ?? T0) + i * tf, open, high: Number(hi.toFixed(4)), low: Number(lo.toFixed(4)), close: c, volume: null });
  }
  return out;
}

/** Aggregate lower-TF candles into a higher TF (aligned buckets). */
export function aggregate(bars: readonly Candle[], dst: Timeframe): Candle[] {
  const sec = SMC_TF_SECONDS[dst];
  const out: Candle[] = [];
  for (const b of bars) {
    const t = Math.floor(b.time / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
    } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: null });
  }
  return out;
}

export const mirror = (c: readonly Candle[], axis: number): Candle[] => c.map((x) => ({ ...x, open: 2 * axis - x.open, close: 2 * axis - x.close, high: 2 * axis - x.low, low: 2 * axis - x.high }));
