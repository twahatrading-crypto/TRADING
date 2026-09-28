import { describe, expect, it } from 'vitest';
import { OrderFlowEngine } from '../../engines/orderFlow/engine';
import { FULL_CAPS, TEST_TICK } from '../../engines/orderFlow/testing/scenarios';
import type { Aggressor, OrderFlowMsg } from '../../engines/orderFlow/types';
import { panelsOf } from '../../services/orderFlow/view';
import {
  DOT_BUCKETS_MS,
  MAX_DOTS_PER_BUCKET,
  TradeTape,
  aggregateDots,
  catchUpFrom,
  CATCH_UP_LAG_MS,
  autoBucketMs,
  bandTicksFor,
  dominance,
  dotRadius,
  latestTrade,
  PRICE_MAX_HOLD_MS,
  priceBars,
  PRICE_MIN_BUCKET_PX,
  PRICE_MIN_CANDLES,
  PRICE_TARGET_CANDLES,
  autoPriceWindow,
  priceBucketFor,
  quantileTotal,
  stepTrace,
  type DisplayTrade,
} from './tradeDots';

/* TEST DATA ONLY. Display aggregation reads trades; it never changes them or anything the engine computes. */

let id = 0;
const trade = (t: number, price: number, size: number, aggressor: Aggressor): OrderFlowMsg => ({ type: 'trade', instrumentId: 'GC', seq: null, exchTime: t, recvTime: t + 5, price, size, aggressor, tradeId: `x${id++}` });

/** A dense tape shaped like the production problem: same-ms sweeps + an older backlog delivered after newer trades. */
function denseTape(): OrderFlowMsg[] {
  const live: OrderFlowMsg[] = [];
  const backlog: OrderFlowMsg[] = [];
  const sides: Aggressor[] = ['BUY', 'SELL', 'UNKNOWN', 'BUY', 'SELL', 'BUY'];
  for (let i = 0; i < 400; i++) live.push(trade(100_000 + i * 150, 2400 + (i % 7) * 0.1, 1 + (i % 9), sides[i % sides.length]!));
  for (let k = 0; k < 12; k++) live.push(trade(130_000, 2401 + k * 0.1, 3 + k, 'BUY')); // one sweep, same millisecond, 12 ticks
  for (let i = 0; i < 300; i++) backlog.push(trade(10_000 + i * 200, 2390 + (i % 5) * 0.1, 2 + (i % 4), sides[(i + 1) % sides.length]!));
  return [...live, ...backlog];
}

const sum = (xs: readonly { buy: number; sell: number; unknown: number; total?: number }[]) =>
  xs.reduce((a, x) => ({ buy: a.buy + x.buy, sell: a.sell + x.sell, unknown: a.unknown + x.unknown }), { buy: 0, sell: 0, unknown: 0 });

describe('display aggregation of executed trades (display only)', () => {
  it('many trades at the same timestamp collapse into display buckets (same time + price band)', () => {
    const tr: DisplayTrade[] = [];
    for (let k = 0; k < 40; k++) tr.push({ t: 5000, tick: 24000 + (k % 4), size: 1, side: 'BUY' });
    const oneTick = aggregateDots(tr, 1000, 1, 0, tr.length, Infinity);
    expect(oneTick).toHaveLength(4); // 40 prints -> 4 bubbles (one per price)
    expect(oneTick.every((b) => b.count === 10 && b.total === 10)).toBe(true);
    const capped = aggregateDots(tr, 1000, 1); // default: at most MAX_DOTS_PER_BUCKET per time bucket
    expect(capped.length).toBeLessThanOrEqual(MAX_DOTS_PER_BUCKET);
    expect(capped.reduce((a, b) => a + b.total, 0)).toBe(40);
    const sweep: DisplayTrade[] = Array.from({ length: 15 }, (_, k) => ({ t: 7000, tick: 500 + k, size: 2, side: 'SELL' as const }));
    const sw = aggregateDots(sweep, 1000, 1);
    expect(sw).toHaveLength(3); // a same-ms sweep through 15 ticks -> 3 bubbles, not a column of 15
    expect(sw.map((b) => [b.band, b.bandTicks, b.count])).toEqual([[500, 5, 5], [505, 5, 5], [510, 5, 5]]);
    const banded = aggregateDots(tr, 1000, 4);
    expect(banded).toHaveLength(1); // a whole same-ms sweep -> ONE bubble, no vertical wall
    expect(banded[0]).toMatchObject({ t: 5000, band: 24000, bandTicks: 4, count: 40, total: 40, first: 5000, last: 5000 });
    expect(banded[0]!.vwapTick).toBeCloseTo(24001.5);
  });

  it('same price / time aggregation keeps buy / sell / unknown exact; total = raw; unknown never becomes a side', () => {
    const tape = new TradeTape(TEST_TICK);
    const msgs = denseTape();
    const tr = tape.sync({ msgs, count: msgs.length });
    const raw = { buy: 0, sell: 0, unknown: 0 };
    for (const m of msgs) if (m.type === 'trade') raw[m.aggressor === 'BUY' ? 'buy' : m.aggressor === 'SELL' ? 'sell' : 'unknown'] += m.size;
    for (const ms of DOT_BUCKETS_MS)
      for (const band of [1, 3, 10]) {
        const dots = aggregateDots(tr, ms, band);
        expect(sum(dots)).toEqual(raw);
        expect(dots.reduce((a, b) => a + b.total, 0)).toBe(raw.buy + raw.sell + raw.unknown);
        expect(dots.reduce((a, b) => a + b.count, 0)).toBe(tr.length);
      }
    const onlyUnknown = aggregateDots([{ t: 0, tick: 1, size: 7, side: 'UNKNOWN' }], 1000, 1)[0]!;
    expect([onlyUnknown.buy, onlyUnknown.sell, onlyUnknown.unknown]).toEqual([0, 0, 7]);
    expect(dominance(onlyUnknown)).toBe('UNKNOWN');
    expect(dominance({ buy: 10, sell: 9, unknown: 0 })).toBe('MIXED');
    expect(dominance({ buy: 10, sell: 2, unknown: 1 })).toBe('BUY');
    expect(dominance({ buy: 1, sell: 10, unknown: 3 })).toBe('SELL');
    expect(dominance({ buy: 3, sell: 1, unknown: 4 })).toBe('UNKNOWN');
  });

  it('late-delivered trades are placed at their own exchange time (stable), raw messages never mutated', () => {
    const msgs = denseTape().map((m) => Object.freeze({ ...m }));
    Object.freeze(msgs);
    const before = JSON.stringify(msgs);
    const tape = new TradeTape(TEST_TICK);
    const tr = tape.sync({ msgs, count: msgs.length });
    for (let i = 1; i < tr.length; i++) expect(tr[i]!.t).toBeGreaterThanOrEqual(tr[i - 1]!.t);
    expect(tr[0]!.t).toBe(10_000); // the backlog (delivered last) comes first in time
    aggregateDots(tr, 250, 2);
    priceBars(tr, 250);
    expect(JSON.stringify(msgs)).toBe(before);
    // Incremental: appending keeps the order; a shorter count (replay rewind) rebuilds.
    const more = [...msgs, trade(5_000, 2388, 1, 'SELL')];
    expect(tape.sync({ msgs: more, count: more.length })[0]!.t).toBe(5_000);
    expect(tape.sync({ msgs: more, count: 10 })).toHaveLength(10);
    // The current price is the latest EXCHANGE time, not the last delivered message.
    expect(latestTrade({ msgs, count: msgs.length })!.time).toBe(100_000 + 399 * 150); // not the backlog trade delivered last
  });

  it('bubble radius: sqrt below the robust norm, log above it, min / max clamped to the cell', () => {
    const cell = 12;
    const r = (v: number) => dotRadius(v, 100, cell);
    expect(r(0)).toBeCloseTo(1.4);
    expect(r(100)).toBeCloseTo(Math.min(4.5, cell * 0.4));
    expect(r(25) - r(0)).toBeCloseTo((r(100) - r(0)) * 0.5); // sqrt: a quarter of the norm -> half the radius range
    expect(r(200)).toBeGreaterThan(r(100)); // a big print is visibly bigger...
    expect(r(1_000_000)).toBeLessThanOrEqual(Math.min(13, cell * 1.2)); // ...but capped
    expect(r(1_000_000)).toBe(r(1600)); // log growth saturates (16x norm)
    expect(dotRadius(1e9, 1, 1000)).toBe(13); // absolute cap: never covers the chart
    expect(dotRadius(50, 100, 2)).toBeLessThanOrEqual(2.4); // dense zoom -> small bubbles
    expect(quantileTotal([], 0.95)).toBe(0);
  });

  it('AUTO bucket: from viewport width, visible range and trade density; band sized to the bucket', () => {
    const sparse: DisplayTrade[] = Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, tick: 1, size: 1, side: 'BUY' as const }));
    expect(autoBucketMs(30_000, 1000, sparse)).toBe(500); // 30 s over 1000 px: smallest bucket >= 10 px wide
    expect(autoBucketMs(180_000, 1000, sparse)).toBe(2000); // wider window -> coarser
    expect(autoBucketMs(180_000, 3000, sparse)).toBe(1000); // wider screen -> finer
    const dense: DisplayTrade[] = Array.from({ length: 6000 }, (_, i) => ({ t: i * 10, tick: 1, size: 1, side: 'SELL' as const }));
    expect(autoBucketMs(60_000, 300, dense)).toBeGreaterThanOrEqual(2000); // density caps the filled buckets per px
    expect(autoBucketMs(1, 1000, [])).toBe(100);
    expect(bandTicksFor(12, 3)).toBe(4);
    expect(bandTicksFor(1, 50)).toBe(1);
  });

  it('price trace: OHLC of the real trade prices per display bucket', () => {
    const tr: DisplayTrade[] = [
      { t: 0, tick: 10, size: 1, side: 'BUY' },
      { t: 100, tick: 14, size: 1, side: 'BUY' },
      { t: 200, tick: 8, size: 1, side: 'SELL' },
      { t: 900, tick: 11, size: 1, side: 'SELL' },
      { t: 1000, tick: 12, size: 1, side: 'UNKNOWN' },
    ];
    expect(priceBars(tr, 1000)).toEqual([
      { t: 0, o: 10, h: 14, l: 8, c: 11 },
      { t: 1000, o: 12, h: 12, l: 12, c: 12 },
    ]);
  });

  it('CVD / SVP / events are unchanged by display aggregation (the engine never sees it)', () => {
    const msgs = denseTape();
    const run = (aggregate: boolean) => {
      const e = new OrderFlowEngine({ instrumentId: 'GC', tickSize: TEST_TICK, capabilities: { ...FULL_CAPS, depth: 'NONE' } });
      e.processAll(msgs);
      if (aggregate) {
        const tape = new TradeTape(TEST_TICK);
        const tr = tape.sync({ msgs, count: msgs.length });
        for (const ms of [100, 250, 1000]) aggregateDots(tr, ms, 2);
      }
      const p = panelsOf(e);
      return JSON.stringify({ digest: e.digest(), totals: p.totals, cvd: p.cvd, profile: p.profile, events: p.events });
    };
    expect(run(true)).toBe(run(false));
  });

  it('price layer: resolution from the viewport only; step trace is continuous, never diagonal, never invents a price', () => {
    const msgs = denseTape();
    const tr = new TradeTape(TEST_TICK).sync({ msgs, count: msgs.length });
    const ms = priceBucketFor(tr, 100_000, 160_000, 1000);
    const bars = priceBars(tr, ms);
    const traded = new Set(tr.map((x) => x.tick));
    const runs = stepTrace(bars, ms, 200_000);
    const pts = runs.flat();
    expect(pts.length).toBeGreaterThan(bars.length); // dense and continuous
    for (const run of runs)
      for (let i = 1; i < run.length; i++) {
        const [t0, k0] = run[i - 1]!;
        const [t1, k1] = run[i]!;
        expect(t0 === t1 || k0 === k1).toBe(true); // only horizontal holds and vertical steps
        expect(t1).toBeGreaterThanOrEqual(t0); // chronological
      }
    for (const [, k] of pts) expect(traded.has(k)).toBe(true); // every price level is a real traded price
    // A silence longer than PRICE_MAX_HOLD_MS breaks the trace (no flat line across a closed market).
    const gap = stepTrace([{ t: 0, o: 1, h: 1, l: 1, c: 1 }, { t: PRICE_MAX_HOLD_MS + 5000, o: 2, h: 2, l: 2, c: 2 }], 1000);
    expect(gap).toHaveLength(2);
    // The price layer does not depend on the dot aggregation at all.
    const before = JSON.stringify(stepTrace(priceBars(tr, ms), ms, 200_000));
    for (const agg of [100, 250, 500, 1000]) aggregateDots(tr, agg, 2);
    expect(JSON.stringify(stepTrace(priceBars(tr, ms), ms, 200_000))).toBe(before);
  });

  it('catch-up note: only when the newest trade trails the feed clock (a quiet market is not flagged)', () => {
    expect(catchUpFrom(1_000, 1_000 + CATCH_UP_LAG_MS + 1)).toBe(1_000); // history still arriving
    expect(catchUpFrom(1_000, 1_000 + 5_000)).toBeNull(); // caught up
    expect(catchUpFrom(1_000, 1_000)).toBeNull(); // quiet market: clock and newest trade move together
    expect(catchUpFrom(null, 5)).toBeNull();
    expect(catchUpFrom(5, null)).toBeNull();
  });

  it('micro-OHLC: open = first, high = max, low = min, close = last REAL trade; empty buckets make no candle', () => {
    // Deterministic pseudo-random tape with gaps (TEST DATA).
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tr: DisplayTrade[] = [];
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      t += rnd() < 0.05 ? 5000 + Math.floor(rnd() * 20_000) : Math.floor(rnd() * 400);
      tr.push({ t, tick: 40000 + Math.floor(rnd() * 12), size: 1 + Math.floor(rnd() * 5), side: rnd() < 0.5 ? 'BUY' : 'SELL' });
    }
    const frozen = JSON.stringify(tr);
    for (const ms of [100, 250, 500, 1000, 2000, 5000]) {
      const bars = priceBars(tr, ms);
      // brute force per bucket
      const groups = new Map<number, DisplayTrade[]>();
      for (const x of tr) {
        const b = Math.floor(x.t / ms) * ms;
        groups.set(b, [...(groups.get(b) ?? []), x]);
      }
      expect(bars.map((b) => b.t)).toEqual([...groups.keys()]); // one candle per NON-empty bucket only
      for (const b of bars) {
        const g = groups.get(b.t)!;
        expect(b.o).toBe(g[0]!.tick);
        expect(b.c).toBe(g[g.length - 1]!.tick);
        expect(b.h).toBe(Math.max(...g.map((x) => x.tick)));
        expect(b.l).toBe(Math.min(...g.map((x) => x.tick)));
      }
      const ticks = new Set(tr.map((x) => x.tick));
      for (const b of bars) for (const k of [b.o, b.h, b.l, b.c]) expect(ticks.has(k)).toBe(true); // never interpolated
    }
    expect(JSON.stringify(tr)).toBe(frozen); // raw trades unchanged
  });

  it('AUTO price window: dense tape -> fine candles with real OHLC range; quiet tape -> fewer candles, honestly', () => {
    const dense: DisplayTrade[] = Array.from({ length: 20_000 }, (_, i) => ({ t: i * 50, tick: 1000 + (i % 3), size: 1, side: 'BUY' as const }));
    const d = autoPriceWindow(dense, 20_000 * 50, 1030);
    expect(d.candles).toBeGreaterThanOrEqual(PRICE_MIN_CANDLES);
    expect(d.candles).toBeLessThanOrEqual(PRICE_TARGET_CANDLES);
    expect(d.ms).toBe(250); // 100 ms would hold only 2 trades per candle; 250 ms holds 5
    expect((1030 * d.ms) / d.span).toBeGreaterThanOrEqual(PRICE_MIN_BUCKET_PX);
    const quiet: DisplayTrade[] = Array.from({ length: 300 }, (_, i) => ({ t: i * 7000, tick: 1000 + (i % 2), size: 1, side: 'SELL' as const }));
    const q = autoPriceWindow(quiet, 300 * 7000, 1030);
    expect(q.ms).toBe(5000); // no size reaches 3 trades per candle: the coarsest AUTO size, honestly
    expect(q.span).toBeLessThanOrEqual(15 * 60_000); // no stale backlog pulled in to fill space
    const inWin = quiet.filter((x) => x.t > 300 * 7000 - q.span).length;
    expect(q.candles).toBeLessThanOrEqual(inWin); // every candle is a real trade - never padded
    // Nothing near the end (history still catching up): an empty recent window, not the old backlog.
    const stale = autoPriceWindow(quiet, 300 * 7000 + 3_600_000, 1030);
    expect(stale.candles).toBe(0);
  });
});
