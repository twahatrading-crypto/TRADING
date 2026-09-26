/**
 * TEST DATA ONLY — deterministic synthetic candles with synthetic tick volume for Volume Profile tests
 * and the bannered dev harness. Never imported by production code; never shown as market data.
 */
import type { Candle, Timeframe } from '../../../types/market';
import { VP_TF_SECONDS } from '../config';

export const T0 = Date.UTC(2026, 0, 5, 0, 0) / 1000; // Mon 2026-01-05 00:00Z

export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const bar = (time: number, o: number, h: number, l: number, c: number, tick: number | null, extra: Partial<Candle> = {}): Candle => ({ time, open: o, high: h, low: l, close: c, volume: null, tickVolume: tick, realVolume: null, source: 'mt5', ...extra });

/** Mean-reverting M5 walk (weekday trading only, like a real feed) — TEST DATA. */
export function m5Walk(days: number, o: { seed: number; start?: number; vol?: number; t0?: number; center?: (dayIndex: number) => number } = { seed: 1 }): Candle[] {
  const r = prng(o.seed);
  const vol = o.vol ?? 0.6;
  let c = o.start ?? 2400;
  const out: Candle[] = [];
  const t0 = o.t0 ?? T0;
  for (let i = 0; i < days * 288; i++) {
    const t = t0 + i * 300;
    const wd = new Date(t * 1000).getUTCDay();
    if (wd === 6 || (wd === 0 && new Date(t * 1000).getUTCHours() < 22) || (wd === 5 && new Date(t * 1000).getUTCHours() >= 22)) continue;
    const center = o.center ? o.center(Math.floor(i / 288)) : (o.start ?? 2400);
    const open = c;
    c = Number((open + (r() - 0.5) * 2 * vol + (center - open) * 0.02).toFixed(2));
    const hi = Number((Math.max(open, c) + r() * vol * 0.5).toFixed(2));
    const lo = Number((Math.min(open, c) - r() * vol * 0.5).toFixed(2));
    out.push(bar(t, open, hi, lo, c, 20 + Math.round(r() * 80)));
  }
  return out;
}

/** Aggregate bars into a higher timeframe (aligned buckets; volume fields summed; last bucket may be partial). */
export function aggregate(src: readonly Candle[], tf: Timeframe): Candle[] {
  const sec = VP_TF_SECONDS[tf];
  const out: Candle[] = [];
  for (const b of src) {
    const t = Math.floor(b.time / sec) * sec;
    const last = out[out.length - 1];
    const add = (a: number | null | undefined, x: number | null | undefined) => (a === null || a === undefined || x === null || x === undefined ? null : a + x);
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.tickVolume = add(last.tickVolume, b.tickVolume);
      last.realVolume = add(last.realVolume, b.realVolume);
      last.volume = add(last.volume, b.volume);
    } else out.push({ ...b, time: t });
  }
  return out;
}

/** A consistent multi-timeframe dataset (TEST DATA): M5 walk aggregated upwards; incomplete last buckets dropped. */
export function dataset(days: number, seed: number, o: { start?: number; vol?: number; center?: (d: number) => number } = {}) {
  const m5 = m5Walk(days, { seed, ...o });
  const end = m5[m5.length - 1]!.time + 300;
  const up = (tf: Timeframe) => aggregate(m5, tf).filter((c) => c.time + VP_TF_SECONDS[tf] <= end);
  return { M5: m5, M15: up('M15'), M30: up('M30'), H1: up('H1'), H4: up('H4'), D1: up('D1') };
}
