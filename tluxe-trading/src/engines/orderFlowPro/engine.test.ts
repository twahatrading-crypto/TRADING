import { describe, expect, it } from 'vitest';
import { classifyQuoteRule, toTick } from './classify';
import { DepthRecorder } from './depthRecorder';
import { OfpEngine, isLiveFeed, offlineStatus } from './engine';
import { barPoc, FootprintBuilder, imbalances, stackedImbalances, type FootprintBar } from './footprint';
import { cvdSeries, OfiTracker } from './metrics';
import { nyParts, sessionWindow } from './nyTime';
import { computeProfile } from './profile';
import { detectReversals } from './reversal';
import { demoHistory, demoStatus, DemoStream } from './testing/demoFixture';
import type { SourceStatus, TradeEvent } from './types';

const T = 0.1;
const q = (bid: number | null, ask: number | null, t = 1000) => ({ bid, ask, t });
const trade = (t: number, price: number, size: number, aggressor: TradeEvent['aggressor']): TradeEvent => ({ kind: 'trade', t, price, size, aggressor, method: 'QUOTE_RULE', bid: null, ask: null });

describe('quote-rule aggressor inference', () => {
  it('BUY at/above ask, SELL at/below bid, UNKNOWN inside the spread', () => {
    expect(classifyQuoteRule(100.2, q(100.1, 100.2), 1000, T, 2000)).toBe('BUY');
    expect(classifyQuoteRule(100.3, q(100.1, 100.2), 1000, T, 2000)).toBe('BUY');
    expect(classifyQuoteRule(100.1, q(100.1, 100.3), 1000, T, 2000)).toBe('SELL');
    expect(classifyQuoteRule(100.0, q(100.1, 100.3), 1000, T, 2000)).toBe('SELL');
    expect(classifyQuoteRule(100.2, q(100.1, 100.3), 1000, T, 2000)).toBe('UNKNOWN');
  });
  it('missing, stale, locked or crossed quotes are UNKNOWN (never guessed)', () => {
    expect(classifyQuoteRule(100.2, null, 1000, T, 2000)).toBe('UNKNOWN');
    expect(classifyQuoteRule(100.2, q(null, 100.2), 1000, T, 2000)).toBe('UNKNOWN');
    expect(classifyQuoteRule(100.2, q(100.1, 100.2, 0), 5000, T, 2000)).toBe('UNKNOWN');
    expect(classifyQuoteRule(100.2, q(100.2, 100.2), 1000, T, 2000)).toBe('UNKNOWN');
    expect(classifyQuoteRule(100.2, q(100.3, 100.2), 1000, T, 2000)).toBe('UNKNOWN');
  });
});

describe('footprint', () => {
  it('builds volume at price; UNKNOWN volume is kept apart and excluded from delta', () => {
    const b = new FootprintBuilder(60_000, T);
    b.addTrade(trade(1_000, 100.0, 5, 'BUY'));
    b.addTrade(trade(2_000, 100.1, 3, 'SELL'));
    b.addTrade(trade(3_000, 100.1, 4, 'UNKNOWN'));
    const [bar] = b.list();
    expect(bar).toMatchObject({ o: 100.0, h: 100.1, l: 100.0, c: 100.1, volume: 12, buy: 5, sell: 3, unknown: 4, delta: 2, source: 'TRADES' });
    expect(bar!.levels.get(toTick(100.1, T))).toEqual({ buy: 0, sell: 3, unknown: 4 });
    expect(barPoc(bar!)).toBe(toTick(100.1, T));
  });
  it('closed bars never repaint: late prints are excluded and counted', () => {
    const b = new FootprintBuilder(60_000, T);
    b.addTrade(trade(1_000, 100, 1, 'BUY'));
    b.closeUpTo(60_000);
    b.addTrade(trade(59_000, 101, 9, 'BUY'));
    expect(b.list()[0]!.volume).toBe(1);
    expect(b.lateExcluded).toBe(1);
  });
  it('historical OHLCV bars carry NO footprint or delta (never fabricated from OHLC)', () => {
    const b = new FootprintBuilder(60_000, T);
    b.addBar({ kind: 'bar', t: 0, tf: '1m', o: 1, h: 2, l: 0.5, c: 1.5, v: 300 });
    expect(b.list()[0]).toMatchObject({ source: 'BARS_ONLY', delta: null, trades: 0, volume: 300 });
    expect(b.list()[0]!.levels.size).toBe(0);
  });
  it('diagonal and stacked imbalances', () => {
    const b = new FootprintBuilder(60_000, 1);
    // ticks 10..13 aggressively bought, almost nothing sold one tick below
    for (const p of [10, 11, 12, 13]) b.addTrade(trade(1000, p, 9, 'BUY'));
    b.addTrade(trade(1000, 9, 1, 'SELL'));
    const imb = imbalances(b.list()[0]!);
    expect(imb.filter((i) => i.side === 'BUY').map((i) => i.tick)).toEqual([10, 11, 12, 13]);
    expect(stackedImbalances(imb)).toEqual([{ fromTick: 10, toTick: 13, side: 'BUY' }]);
  });
});

describe('volume profile', () => {
  it('POC and a value area holding >= 70 % of volume (CME two-row method)', () => {
    const vols = [5, 10, 20, 40, 100, 35, 15, 10, 5];
    const rows = vols.map((v, i) => ({ tick: i, volume: v, buy: 0, sell: 0, unknown: v }));
    const p = computeProfile(rows);
    expect(p.poc).toBe(4);
    const inside = rows.filter((r) => r.tick >= p.val! && r.tick <= p.vah!).reduce((s, r) => s + r.volume, 0);
    expect(inside / p.total).toBeGreaterThanOrEqual(0.7);
    expect(p.val).toBe(2); // POC 4 -> pair below (3,2: 60) beats pair above (5,6: 50) -> then (5,6) -> 210 / 240
    expect(p.vah).toBe(6);
  });
  it('empty input has no levels', () => {
    expect(computeProfile([])).toMatchObject({ poc: null, vah: null, val: null, total: 0 });
  });
});

describe('depth recorder (resting liquidity only)', () => {
  it('paints nothing before the first snapshot and nothing after a gap until a resync', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applyLevel({ kind: 'depth', t: 0, side: 'BID', price: 10, size: 5 });
    expect(r.ignoredWhileInvalid).toBe(1);
    r.applySnapshot({ kind: 'book', t: 0, bids: [[10, 4]], asks: [[11, 8]] });
    r.integrate(10_000);
    const [c] = r.columnsIn(0, 10_000);
    expect(c!.validMs).toBe(10_000);
    expect(c!.cells.get(10 * 2)!.sizeMs / c!.validMs).toBe(4);
    r.applyGap({ kind: 'gap', from: 10_000, to: 30_000, reason: 'test' });
    r.integrate(40_000);
    expect(r.columnsIn(10_000, 40_000).reduce((s, x) => s + (x.t >= 10_000 ? x.validMs : 0), 0)).toBe(0);
    expect(r.currentBook()).toEqual({ bids: [], asks: [] });
  });
  it('time-weights displayed size and records additions / reductions', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applySnapshot({ kind: 'book', t: 0, bids: [[10, 10]], asks: [] });
    r.applyLevel({ kind: 'depth', t: 5_000, side: 'BID', price: 10, size: 30 });
    r.applyLevel({ kind: 'depth', t: 7_500, side: 'BID', price: 10, size: 6 });
    r.integrate(10_000);
    const cell = r.columnsIn(0, 0)[0]!.cells.get(20)!;
    expect(cell.sizeMs / 10_000).toBe((10 * 5 + 30 * 2.5 + 6 * 2.5) / 10);
    expect(cell).toMatchObject({ adds: 20, reductions: 24, maxSize: 30 });
  });
  it('a periodic snapshot of a valid book keeps resting time; a snapshot after a gap starts fresh', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applySnapshot({ kind: 'book', t: 0, bids: [[10, 5]], asks: [[11, 5]] });
    r.applySnapshot({ kind: 'book', t: 300_000, bids: [[10, 5]], asks: [[12, 5]] });
    const at = (side: string, price: number) => r.levelStats(400_000).find((s) => s.side === side && s.price === price)!.persistMs;
    expect(at('BID', 10)).toBe(400_000);
    expect(at('ASK', 12)).toBe(100_000);
    r.applyGap({ kind: 'gap', from: 400_000, to: 410_000, reason: 'test' });
    r.applySnapshot({ kind: 'book', t: 410_000, bids: [[10, 5]], asks: [] });
    expect(r.levelStats(420_000)[0]!.persistMs).toBe(10_000);
  });

  it('strong levels need relative size AND persistence', () => {
    const r = new DepthRecorder(1, 10_000);
    r.applySnapshot({ kind: 'book', t: 0, bids: [[10, 5], [9, 6], [8, 90]], asks: [[11, 5], [12, 4], [13, 7]] });
    expect(r.strongLevels(30_000, { minRelative: 2.5, minPersistMs: 60_000, lookbackMs: 60_000 })).toEqual([]);
    const s = r.strongLevels(120_000, { minRelative: 2.5, minPersistMs: 60_000, lookbackMs: 60_000 });
    expect(s.map((x) => [x.side, x.price])).toEqual([['BID', 8]]);
  });
});

describe('metrics', () => {
  it('top-of-book OFI follows Cont-Kukanov-Stoikov', () => {
    const o = new OfiTracker();
    const qe = (bid: number, ask: number, bs: number, as: number) => ({ kind: 'quote' as const, t: 0, bid, ask, bidSize: bs, askSize: as });
    expect(o.add(qe(10, 11, 5, 5))).toBeNull();
    expect(o.add(qe(10, 11, 8, 5))).toBe(3); // bid size grew
    expect(o.add(qe(10, 11, 8, 2))).toBe(3); // ask size shrank
    expect(o.add(qe(11, 12, 4, 6))).toBe(4 + 2); // bid stepped up (+4), ask stepped up (+prev ask 2)
  });
  it('CVD is marked partial once unknown-side volume is excluded', () => {
    const bars = [
      { t: 0, delta: 3, unknown: 0, source: 'TRADES' },
      { t: 1, delta: -1, unknown: 2, source: 'TRADES' },
    ] as unknown as FootprintBar[];
    expect(cvdSeries(bars)).toEqual([{ t: 0, v: 3, partial: false }, { t: 1, v: 2, partial: true }]);
  });
});

function bar(i: number, o: number, h: number, l: number, c: number, closed = true): FootprintBar {
  return { t: i * 60_000, ms: 60_000, o, h, l, c, volume: 10, buy: 5, sell: 5, unknown: 0, delta: 0, trades: 10, levels: new Map(), source: 'TRADES', closed };
}

describe('reversal detector (research only)', () => {
  const downThenSweep = () => [
    bar(0, 110, 111, 108, 109), bar(1, 109, 110, 107, 108), bar(2, 108, 109, 104, 105), // swing low 104 at i=2
    bar(3, 105, 107, 105, 106), bar(4, 106, 108, 105, 107), bar(5, 107, 107, 105, 105.5),
    bar(6, 105.5, 106, 102, 105.8), // sweeps 104, reclaims, long lower wick
    bar(7, 105.8, 111, 105.5, 110.5), // closes above the prior 5-bar high (110) -> structure shift
  ];

  it('bullish liquidity sweep: evidence listed, score is additive evidence (not a probability)', () => {
    const sig = detectReversals({ bars: downThenSweep(), cvdAt: new Map(), ofiAt: new Map(), tick: 0.1, classified: false });
    const s = sig.find((x) => x.direction === 'BULLISH')!;
    expect(s.setup).toBe('Liquidity Sweep');
    expect(s.sweptLevel).toBe(104);
    expect(s.knownAt).toBe(7 * 60_000);
    const st = Object.fromEntries(s.evidence.map((e) => [e.key, e.state]));
    expect(st).toMatchObject({ sweep: 'PRESENT', reclaim: 'PRESENT', rejection: 'PRESENT', absorption: 'UNAVAILABLE', deltaDivergence: 'UNAVAILABLE', ofi: 'UNAVAILABLE', structureShift: 'PRESENT' });
    expect(s.scoreAtSignal).toBe(20 + 15 + 10);
    expect(s.status).toBe('CONFIRMED');
    expect(s.maxScore).toBe(100 - 15 - 15 - 10);
  });

  it('the forming (unclosed) bar never creates a signal', () => {
    const bars = downThenSweep().slice(0, 7);
    bars[6] = { ...bars[6]!, closed: false };
    expect(detectReversals({ bars, cvdAt: new Map(), ofiAt: new Map(), tick: 0.1, classified: false })).toEqual([]);
  });

  it('bearish = the mirrored rules', () => {
    const m = downThenSweep().map((b) => ({ ...b, o: -b.o, h: -b.l, l: -b.h, c: -b.c }));
    const s = detectReversals({ bars: m, cvdAt: new Map(), ofiAt: new Map(), tick: 0.1, classified: false });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ direction: 'BEARISH', sweptLevel: -104, invalidation: -102, scoreAtSignal: 45 });
  });

  it('a later trade beyond the signal extreme invalidates it', () => {
    const bars = [...downThenSweep().slice(0, 7), bar(7, 105.8, 106, 101, 101.5)];
    const s = detectReversals({ bars, cvdAt: new Map(), ofiAt: new Map(), tick: 0.1, classified: false });
    expect(s.find((x) => x.direction === 'BULLISH')!.status).toBe('INVALIDATED');
  });
});

describe('session windows (America/New_York, DST-correct)', () => {
  it('RTH starts 08:20 ET in summer and winter', () => {
    const summer = sessionWindow(Date.UTC(2026, 6, 15, 15, 0), 'RTH');
    const winter = sessionWindow(Date.UTC(2026, 0, 15, 15, 0), 'RTH');
    expect(nyParts(summer.start)).toMatchObject({ h: 8, mi: 20 });
    expect(nyParts(winter.start)).toMatchObject({ h: 8, mi: 20 });
    expect(summer.end - summer.start).toBe(310 * 60_000);
  });
  it('ETH starts at the previous 18:00 ET', () => {
    const w = sessionWindow(Date.UTC(2026, 6, 15, 15, 0), 'ETH');
    expect(nyParts(w.start)).toMatchObject({ d: 14, h: 18, mi: 0 });
  });
});

describe('engine', () => {
  const live = (sym: string): SourceStatus => ({ ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME', contract: { root: 'GC', localSymbol: sym, conId: 1, expiry: '20261229', exchange: 'COMEX', tradingClass: 'GC', multiplier: '100', verified: true } });

  it('DEMO is never LIVE; only LIVE + REALTIME is', () => {
    expect(isLiveFeed(demoStatus('GC', 1))).toBe(false);
    expect(isLiveFeed({ ...live('GCZ6'), marketDataType: 'DELAYED' })).toBe(false);
    expect(isLiveFeed(live('GCZ6'))).toBe(true);
  });

  it('a contract change clears all state (contracts never combined)', () => {
    const e = new OfpEngine('GC');
    e.setStatus(live('GCZ6'), 0);
    e.apply({ root: 'GC', seq: 1, events: [trade(1000, 4000, 2, 'BUY')] });
    expect(e.view('1m', 'ETH').bars).toHaveLength(1);
    e.setStatus(live('GCG7'), 2000);
    expect(e.view('1m', 'ETH').bars).toHaveLength(0);
  });

  it('a sequence gap is recorded and invalidates the book', () => {
    const e = new OfpEngine('GC');
    e.apply({ root: 'GC', seq: 1, events: [{ kind: 'book', t: 1000, bids: [[4000, 5]], asks: [[4000.1, 5]] }] });
    expect(e.view('1m', 'ETH').bookValid).toBe(true);
    e.apply({ root: 'GC', seq: 5, events: [{ kind: 'depth', t: 2000, side: 'BID', price: 4000, size: 9 }] });
    const v = e.view('1m', 'ETH');
    expect(v.gaps[0]!.reason).toMatch(/Sequence gap 1/);
    expect(v.bookValid).toBe(false);
  });

  it('ignores frames for the other root', () => {
    const e = new OfpEngine('SI');
    e.apply({ root: 'GC', seq: 1, events: [trade(1000, 4000, 2, 'BUY')] });
    expect(e.view('1m', 'ETH').tape).toHaveLength(0);
  });

  it('the demo fixture is deterministic and runs end-to-end through the same engine', () => {
    const a = demoHistory('GC', Date.UTC(2026, 9, 9, 12), 900, 3);
    const b = demoHistory('GC', Date.UTC(2026, 9, 9, 12), 900, 3);
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
    const e = new OfpEngine('GC', demoStatus('GC', null));
    for (const f of a.frames) e.apply(f);
    e.advance(a.stream.t);
    const v = e.view('1m', 'ETH');
    expect(v.bars.length).toBeGreaterThanOrEqual(14);
    expect(v.book.bids.length).toBe(10);
    expect(v.stats.unknown).toBeGreaterThan(0); // inside-spread prints stay UNKNOWN
    expect(v.stats.buy + v.stats.sell).toBeGreaterThan(v.stats.unknown);
    expect(v.status.feed).toBe('DEMO');
  });

  it('demo gaps stop the heatmap until the resync snapshot', () => {
    const s = new DemoStream('GC', 0, 1, 10, 120);
    const e = new OfpEngine('GC', demoStatus('GC', null));
    for (let i = 0; i < 300; i++) e.apply(s.frame(s.step()));
    expect(e.view('1m', 'ETH').gaps.length).toBeGreaterThan(0);
  });
});
