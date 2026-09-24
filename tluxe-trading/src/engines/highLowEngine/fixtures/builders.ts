/**
 * TEST FIXTURES ONLY. Deterministic synthetic candles for High / Low Engine tests.
 * Never imported by production code and never shown as market data.
 * Higher timeframes are AGGREGATED from the lower ones, so every timeframe agrees
 * (as real data does); H1/H4 may start earlier than M1 (as real MT5 history does).
 */
import type { Candle } from '../../../types/market';
import type { HLEInput } from '../engine';

/** Monday 2026-01-05 00:00 UTC — aligned to every timeframe boundary. */
export const T0 = Date.UTC(2026, 0, 5) / 1000;

export function path(start: number, ...legs: [to: number, n: number][]): number[] {
  const out = [start];
  let from = start;
  for (const [to, n] of legs) {
    for (let k = 1; k <= n; k++) out.push(from + ((to - from) * k) / n);
    from = to;
  }
  return out;
}

/** Candles from closes (open = previous close, fixed wicks); `ov` overrides OHLC by index. */
export function fromCloses(closes: readonly number[], t0: number, step: number, wick: number, ov: Record<number, Partial<Candle>> = {}): Candle[] {
  const out: Candle[] = [];
  closes.forEach((c0, i) => {
    const o = ov[i] ?? {};
    const close = o.close ?? c0;
    const open = o.open ?? (i === 0 ? close : out[i - 1]!.close);
    out.push({ time: t0 + i * step, open, high: Math.max(open, close, o.high ?? Math.max(open, close) + wick), low: Math.min(open, close, o.low ?? Math.min(open, close) - wick), close, volume: null });
  });
  return out;
}

/** Aggregate to a higher timeframe; only COMPLETE groups are emitted. */
export function aggregate(bars: readonly Candle[], srcSec: number, dstSec: number): Candle[] {
  const per = dstSec / srcSec;
  const groups = new Map<number, Candle[]>();
  for (const b of bars) {
    const k = Math.floor(b.time / dstSec) * dstSec;
    const g = groups.get(k);
    if (g) g.push(b);
    else groups.set(k, [b]);
  }
  const out: Candle[] = [];
  for (const [time, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (g.length !== per) continue;
    out.push({ time, open: g[0]!.open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[g.length - 1]!.close, volume: null });
  }
  return out;
}

/** Full five-timeframe input: coarse H1 history, then an M1 segment from which M5/M15/H1 are built. */
export function dataset(coarseH1: readonly Candle[], m1: readonly Candle[]): HLEInput {
  const h1 = [...coarseH1, ...aggregate(m1, 60, 3600)];
  return { H4: aggregate(h1, 3600, 14400), H1: h1, M15: aggregate(m1, 60, 900), M5: aggregate(m1, 60, 300), M1: [...m1] };
}

export const mirrorCandles = (c: readonly Candle[], axis: number): Candle[] =>
  c.map((b) => ({ ...b, open: 2 * axis - b.open, close: 2 * axis - b.close, high: 2 * axis - b.low, low: 2 * axis - b.high }));

export function mirrorInput(input: HLEInput, axis: number): HLEInput {
  const out: HLEInput = {};
  for (const [tf, c] of Object.entries(input) as [keyof HLEInput, Candle[]][]) out[tf] = mirrorCandles(c, axis);
  return out;
}
