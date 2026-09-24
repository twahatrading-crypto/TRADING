/**
 * TEST FIXTURES ONLY. Deterministic synthetic candles for Liquidity engine tests.
 * Never imported by production code and never shown as market data.
 */
import type { Candle, Timeframe } from '../../../types/market';
import { LIQUIDITY_TF_SECONDS } from '../config';

export const T0 = Date.UTC(2026, 0, 5) / 1000; // Mon 2026-01-05 00:00Z

/** Seeded PRNG (mulberry32). */
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

/** Deterministic mean-reverting random walk. */
export function walk(n: number, o: { seed: number; start: number; vol: number; tf?: Timeframe; t0?: number }): Candle[] {
  const r = prng(o.seed);
  const step = LIQUIDITY_TF_SECONDS[o.tf ?? 'H1'];
  const out: Candle[] = [];
  let price = o.start;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    drift = 0.9 * drift + (r() - 0.5) * o.vol * 0.6;
    const open = price;
    const close = open + drift + (r() - 0.5) * o.vol + (o.start - open) * 0.02;
    out.push({ time: (o.t0 ?? T0) + i * step, open, high: Math.max(open, close) + r() * o.vol * 0.6, low: Math.min(open, close) - r() * o.vol * 0.6, close, volume: null });
    price = close;
  }
  return out;
}

/**
 * Bars from a close path with fixed wicks; `hl` overrides exact highs/lows per index
 * (so equal highs / sweeps can be placed precisely).
 */
export function bars(closes: readonly number[], o: { tf?: Timeframe; wick?: number; hl?: Record<number, { high?: number; low?: number; close?: number }> } = {}): Candle[] {
  const step = LIQUIDITY_TF_SECONDS[o.tf ?? 'H1'];
  const wick = o.wick ?? 0.5;
  return closes.map((c0, i) => {
    const ov = o.hl?.[i] ?? {};
    const close = ov.close ?? c0;
    const open = i === 0 ? close : (o.hl?.[i - 1]?.close ?? closes[i - 1]!);
    const high = Math.max(open, close, ov.high ?? Math.max(open, close) + wick);
    const low = Math.min(open, close, ov.low ?? Math.min(open, close) - wick);
    return { time: T0 + i * step, open, high, low, close, volume: null };
  });
}

/** Piecewise-linear closes: path(100, [110, 5]) = 100 → 110 in 5 bars. */
export function path(start: number, ...legs: [to: number, n: number][]): number[] {
  const out = [start];
  let from = start;
  for (const [to, n] of legs) {
    for (let k = 1; k <= n; k++) out.push(from + ((to - from) * k) / n);
    from = to;
  }
  return out;
}

/** Warm-up range (ATR ≈ 2.5 with 0.5 wicks and ~1.5/bar moves) so history requirements are met. */
export const warm = (base: number): [number, number][] => [
  [base + 6, 4], [base, 4], [base + 6, 4], [base, 4], [base + 6, 4], [base, 4], [base + 6, 4], [base, 4], [base + 6, 4], [base, 4], [base + 6, 4], [base, 4],
];

export const mirror = (c: readonly Candle[], axis: number): Candle[] =>
  c.map((b) => ({ ...b, open: 2 * axis - b.open, close: 2 * axis - b.close, high: 2 * axis - b.low, low: 2 * axis - b.high }));
