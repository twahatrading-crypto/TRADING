/**
 * TEST FIXTURES ONLY. Deterministic synthetic candles for engine tests and the
 * replay harness. Never imported by production code and never shown as market data.
 */
import type { Candle, Timeframe } from '../../../types/market';
import { TIMEFRAME_SECONDS } from '../settings';

export const FIXTURE_START = Date.UTC(2026, 0, 5) / 1000; // Mon 2026-01-05 00:00Z

/** Piecewise-linear closes: path(120, [100, 10], [115, 10]) = 120 → 100 in 10 bars → 115 in 10 bars. */
export function path(start: number, ...legs: [target: number, bars: number][]): number[] {
  const out = [start];
  let from = start;
  for (const [to, n] of legs) {
    for (let k = 1; k <= n; k++) out.push(from + ((to - from) * k) / n);
    from = to;
  }
  return out;
}

export interface BuildOptions {
  tf?: Timeframe;
  start?: number;
  /** Wick added beyond the body on both sides. */
  wick?: number;
  /** Per-bar OHLC overrides (by index). */
  overrides?: Record<number, Partial<Pick<Candle, 'open' | 'high' | 'low' | 'close'>>>;
}

/** Candles whose open = previous close, with symmetric wicks. */
export function fromCloses(closes: readonly number[], o: BuildOptions = {}): Candle[] {
  const tf = TIMEFRAME_SECONDS[o.tf ?? 'H1'];
  const start = o.start ?? FIXTURE_START;
  const wick = o.wick ?? 0.5;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    const base: Candle = {
      time: start + i * tf,
      open,
      close,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      volume: 100 + (i % 7) * 10,
    };
    const ov = o.overrides?.[i];
    if (!ov) return base;
    const c = { ...base, ...ov };
    c.high = Math.max(c.high, c.open, c.close);
    c.low = Math.min(c.low, c.open, c.close);
    return c;
  });
}

/** Mirror prices around `axis` (support scenario ↔ resistance scenario). */
export function mirror(candles: readonly Candle[], axis: number): Candle[] {
  return candles.map((c) => ({ ...c, open: 2 * axis - c.open, close: 2 * axis - c.close, high: 2 * axis - c.low, low: 2 * axis - c.high }));
}

/** Rescale prices (different instrument price scales). */
export function scale(candles: readonly Candle[], k: number): Candle[] {
  return candles.map((c) => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }));
}

/** Seeded PRNG (mulberry32) — deterministic across runs and machines. */
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

/** Deterministic mean-reverting random walk (for replay / anti-repaint tests). */
export function randomWalk(n: number, opts: { seed: number; start: number; vol: number; tf?: Timeframe; startTime?: number }): Candle[] {
  const r = prng(opts.seed);
  const tf = TIMEFRAME_SECONDS[opts.tf ?? 'H1'];
  const out: Candle[] = [];
  let price = opts.start;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    drift = 0.9 * drift + (r() - 0.5) * opts.vol * 0.6;
    const open = price;
    const close = open + drift + (r() - 0.5) * opts.vol + (opts.start - open) * 0.02;
    const high = Math.max(open, close) + r() * opts.vol * 0.6;
    const low = Math.min(open, close) - r() * opts.vol * 0.6;
    out.push({ time: (opts.startTime ?? FIXTURE_START) + i * tf, open, high, low, close, volume: Math.round(100 + r() * 900) });
    price = close;
  }
  return out;
}

/** Append explicit [open, high, low, close] bars after an existing series. */
export function appendBars(candles: readonly Candle[], bars: readonly [number, number, number, number][], tf: Timeframe = 'H1'): Candle[] {
  const step = TIMEFRAME_SECONDS[tf];
  const last = candles[candles.length - 1]!;
  return [
    ...candles,
    ...bars.map(([open, high, low, close], k) => ({ time: last.time + (k + 1) * step, open, high, low, close, volume: 100 })),
  ];
}
