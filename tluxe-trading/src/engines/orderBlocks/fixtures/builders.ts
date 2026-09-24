/**
 * TEST FIXTURES ONLY. Deterministic synthetic candles for Order Block engine tests.
 * Never imported by production code and never shown as market data.
 */
import type { Candle, Timeframe } from '../../../types/market';
import { OB_TF_SECONDS } from '../config';

export const T0 = Date.UTC(2026, 0, 5) / 1000;

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function walk(n: number, o: { seed: number; start: number; vol: number; tf?: Timeframe }): Candle[] {
  const r = prng(o.seed);
  const step = OB_TF_SECONDS[o.tf ?? 'H1'];
  const out: Candle[] = [];
  let price = o.start;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    drift = 0.9 * drift + (r() - 0.5) * o.vol * 0.6;
    const open = price;
    const close = open + drift + (r() - 0.5) * o.vol + (o.start - open) * 0.02;
    out.push({ time: T0 + i * step, open, high: Math.max(open, close) + r() * o.vol * 0.6, low: Math.min(open, close) - r() * o.vol * 0.6, close, volume: null });
    price = close;
  }
  return out;
}

export function path(start: number, ...legs: [to: number, n: number][]): number[] {
  const out = [start];
  let from = start;
  for (const [to, n] of legs) {
    for (let k = 1; k <= n; k++) out.push(from + ((to - from) * k) / n);
    from = to;
  }
  return out;
}

/** Candles from closes (open = previous close, 0.5 wicks); `ov` overrides OHLC per index. */
export function bars(closes: readonly number[], o: { tf?: Timeframe; wick?: number; ov?: Record<number, Partial<Pick<Candle, 'open' | 'high' | 'low' | 'close'>>> } = {}): Candle[] {
  const step = OB_TF_SECONDS[o.tf ?? 'H1'];
  const wick = o.wick ?? 0.5;
  const out: Candle[] = [];
  closes.forEach((c0, i) => {
    const ov = o.ov?.[i] ?? {};
    const close = ov.close ?? c0;
    const open = ov.open ?? (i === 0 ? close : out[i - 1]!.close);
    const high = Math.max(open, close, ov.high ?? Math.max(open, close) + wick);
    const low = Math.min(open, close, ov.low ?? Math.min(open, close) - wick);
    out.push({ time: T0 + i * step, open, high, low, close, volume: null });
  });
  return out;
}

export const mirror = (c: readonly Candle[], axis: number): Candle[] =>
  c.map((b) => ({ ...b, open: 2 * axis - b.open, close: 2 * axis - b.close, high: 2 * axis - b.low, low: 2 * axis - b.high }));

/** Warm-up range 100–106 (ATR ≈ 2, history requirement met). */
export const warm = (): [number, number][] => [
  [106, 4], [100, 4], [106, 4], [100, 4], [106, 4], [100, 4], [106, 4], [100, 4], [106, 4], [100, 4], [106, 4], [100, 4],
];
