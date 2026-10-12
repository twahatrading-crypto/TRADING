import { describe, expect, it } from 'vitest';
import { OfpEngine, offlineStatus } from './engine';
import { FootprintBuilder, imbalances, stackedImbalances } from './footprint';
import { cvdSeries, deltaSeries } from './metrics';
import type { SourceStatus, TradeEvent } from './types';

/* Phase 2D: UNKNOWN (unclassifiable / stale-quote) volume must never count as directional volume. */

const tr = (t: number, price: number, size: number, aggressor: TradeEvent['aggressor'], basis = aggressor === 'UNKNOWN' ? 'QUOTE_STALE' : 'AT_ASK'): TradeEvent => ({
  kind: 'trade',
  t,
  price,
  size,
  aggressor,
  method: 'QUOTE_RULE',
  inferred: true,
  basis,
  quoteAgeMs: aggressor === 'UNKNOWN' ? 5000 : 100,
  quoteSource: 'depth',
  bid: price - 0.1,
  ask: price,
});

const live = (): SourceStatus => ({
  ...offlineStatus('GC', 'LIVE', []),
  marketDataType: 'REALTIME',
  capabilities: { depth: 'AVAILABLE', trades: 'AVAILABLE', aggressor: 'AVAILABLE', historicalBars: 'AVAILABLE' },
});

describe('UNKNOWN volume is never directional', () => {
  it('delta and CVD ignore UNKNOWN volume (and flag the series PARTIAL)', () => {
    const b = new FootprintBuilder(60_000, 1);
    b.addTrade(tr(1_000, 100, 4, 'BUY'));
    b.addTrade(tr(2_000, 100, 1, 'SELL'));
    b.addTrade(tr(3_000, 100, 500, 'UNKNOWN'));
    const bar = b.list()[0]!;
    expect(bar).toMatchObject({ buy: 4, sell: 1, unknown: 500, delta: 3, volume: 505 });
    expect(deltaSeries([bar])).toEqual([{ t: 0, v: 3, partial: true }]);
    expect(cvdSeries([bar])).toEqual([{ t: 0, v: 3, partial: true }]);
  });

  it('footprint keeps UNKNOWN volume in its own bucket, never in bid / ask columns', () => {
    const b = new FootprintBuilder(60_000, 1);
    b.addTrade(tr(1_000, 100, 7, 'UNKNOWN'));
    expect(b.list()[0]!.levels.get(100)).toEqual({ buy: 0, sell: 0, unknown: 7 });
  });

  it('huge UNKNOWN volume creates no imbalance or stacked imbalance', () => {
    const b = new FootprintBuilder(60_000, 1);
    for (const p of [10, 11, 12, 13]) b.addTrade(tr(1_000, p, 900, 'UNKNOWN'));
    b.addTrade(tr(1_000, 9, 1, 'SELL'));
    const imb = imbalances(b.list()[0]!);
    expect(imb).toEqual([]);
    expect(stackedImbalances(imb)).toEqual([]);
  });

  it('a backend UNKNOWN print is never re-classified by the browser, even with a fresh browser-side quote', () => {
    const e = new OfpEngine('GC', live());
    e.apply({ root: 'GC', seq: 1, events: [{ kind: 'quote', t: 999, bid: 4195.3, ask: 4195.4, bidSize: 5, askSize: 5 }, tr(1_000, 4195.4, 9, 'UNKNOWN')] });
    const v = e.view('1m', 'ETH');
    expect(v.tape[0]).toMatchObject({ aggressor: 'UNKNOWN', basis: 'QUOTE_STALE', inferred: true });
    expect(v.bars[0]).toMatchObject({ buy: 0, sell: 0, unknown: 9, delta: 0 });
    expect(v.stats.unknownShare).toBe(1);
  });
});
