import { describe, expect, it } from 'vitest';
import { OFP_TFS } from '../../engines/orderFlowPro/config';
import { OfpEngine } from '../../engines/orderFlowPro/engine';
import type { BarEvent, OfpRoot, OfpTf, TradeEvent } from '../../engines/orderFlowPro/types';
import { parseTradesPage, toTradeEvent } from './gatewayMap';
import rec from './testing/gatewayRecordedMinutes.json';

/* RECORDED fixture: complete real prints of 8 minutes around an hour boundary + Databento's own OHLCV-1m bars of
 * those minutes, captured read-only from the production gateway. Deterministic; never LIVE. */

type RecTrade = Record<string, unknown> & { tsEventNs: number; size: number; side: string };
const R = rec as unknown as { _fixture: { kind: string; note: string; hourBoundaryMs: number; fromMs: number; toMs: number } } & Record<OfpRoot, { contract: string; trades: RecTrade[]; ohlcv1m: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number; isClosed: boolean }> }>;
const H = R._fixture.hourBoundaryMs;

function events(root: OfpRoot): TradeEvent[] {
  const d = R[root];
  const last = d.trades[d.trades.length - 1]!.i as number;
  const page = parseTradesPage({ root, contract: d.contract, instrumentId: 1, trades: d.trades, complete: true, lastIndex: last }, root)!;
  expect(page.rejected).toEqual({});
  return page.trades.map((t) => toTradeEvent(t, d.contract));
}

function build(root: OfpRoot, apply: (e: OfpEngine) => void): OfpEngine {
  const e = new OfpEngine(root);
  apply(e);
  e.advance(R._fixture.toMs + 60_000);
  return e;
}
const frame = (root: OfpRoot, seq: number, evs: TradeEvent[] | BarEvent[]) => ({ root, seq, events: evs });

function snapshot(e: OfpEngine, tf: OfpTf) {
  const v = e.view(tf, 'ETH');
  return {
    bars: v.bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, volume: b.volume, buy: b.buy, sell: b.sell, unknown: b.unknown, delta: b.delta, trades: b.trades, levels: [...b.levels.entries()].sort((a, c) => a[0] - c[0]) })),
    stats: { volume: v.stats.volume, buy: v.stats.buy, sell: v.stats.sell, unknown: v.stats.unknown, delta: v.stats.delta, trades: v.stats.trades, poc: v.stats.profile.poc, vah: v.stats.profile.vah, val: v.stats.profile.val },
    cvd: v.cvd.map((p) => [p.t, p.v]),
  };
}

describe('recorded fixture', () => {
  it('is labelled RECORDED and covers an hour boundary', () => {
    expect(R._fixture.kind).toBe('RECORDED');
    expect(R._fixture.note).toMatch(/NOT live data/);
    expect(R._fixture.fromMs).toBeLessThan(H);
    expect(R._fixture.toMs).toBeGreaterThan(H);
  });
});

for (const root of ['GC', 'SI'] as const) {
  describe(`${root}: closed-minute reconciliation against Databento OHLCV-1m (recorded)`, () => {
    const evs = events(root);
    const e = build(root, (x) => x.apply(frame(root, 1, evs)));

    it('exact contract identity and exchange-time ordering', () => {
      expect(R[root].contract).toMatch(new RegExp(`^${root}[FGHJKMNQUVXZ]\\d$`));
      for (let i = 1; i < evs.length; i++) expect(evs[i]!.t).toBeGreaterThanOrEqual(evs[i - 1]!.t);
      for (const t of evs) expect(t.tRecv!).toBeGreaterThanOrEqual(t.t);
    });

    it('every closed minute: footprint volume == Databento OHLCV volume; buy + sell + unknown == volume; delta == buy - sell', () => {
      const bars = e.view('1m', 'ETH').bars;
      for (const o of R[root].ohlcv1m) {
        const b = bars.find((x) => x.t === o.time * 1000)!;
        expect(b, `${root} ${o.time}`).toBeDefined();
        expect(b.closed).toBe(true);
        expect(b.volume).toBe(o.volume);
        expect(b.buy + b.sell + b.unknown).toBe(b.volume);
        expect(b.delta).toBe(b.buy - b.sell);
        expect([b.h, b.l]).toEqual([o.high, o.low]);
        expect(b.c).toBe(o.close);
        const perLevel = [...b.levels.values()].reduce((a, l) => a + l.buy + l.sell + l.unknown, 0);
        expect(perLevel).toBe(o.volume);
      }
      expect(e.view('1m', 'ETH').stats.lateExcluded).toBe(0);
    });

    it('cumulative delta = running sum of per-minute delta; higher timeframes sum exactly', () => {
      const v1 = e.view('1m', 'ETH');
      let run = 0;
      const want = v1.bars.map((b) => [b.t, (run += b.delta ?? 0)]);
      expect(v1.cvd.map((p) => [p.t, p.v])).toEqual(want);
      const total = R[root].ohlcv1m.reduce((a, o) => a + o.volume, 0);
      for (const tf of OFP_TFS) expect(e.view(tf, 'ETH').bars.reduce((a, b) => a + b.volume, 0)).toBe(total);
    });

    it('history merge (prints after the hour first, earlier prints merged on demand) == loading everything in order', () => {
      const live = evs.filter((t) => t.t >= H);
      const earlier = evs.filter((t) => t.t < H).map((t) => ({ ...t, history: true }));
      const merged = build(root, (x) => {
        x.apply(frame(root, 1, live));
        x.advance(live[live.length - 1]!.t);
        x.apply(frame(root, 1 + live.length, earlier));
      });
      for (const tf of OFP_TFS) expect(snapshot(merged, tf)).toEqual(snapshot(e, tf));
      // the tape and last price are the live ones: earlier prints never pose as the newest
      const vm = merged.view('1m', 'ETH');
      expect(vm.last).toBe(e.view('1m', 'ETH').last);
      expect(vm.tape[0]).toEqual(e.view('1m', 'ETH').tape[0]);
      expect(vm.tape.every((t) => !t.history)).toBe(true);
    });

    it('history merge over OHLCV-only bars: bars become MIXED with the exact OHLCV volume and OHLC', () => {
      const live = evs.filter((t) => t.t >= H);
      const earlier = evs.filter((t) => t.t < H).map((t) => ({ ...t, history: true }));
      const ohlcv: BarEvent[] = R[root].ohlcv1m.filter((o) => o.time * 1000 < H).map((o) => ({ kind: 'bar', t: o.time * 1000, tf: '1m', o: o.open, h: o.high, l: o.low, c: o.close, v: o.volume }));
      const m = build(root, (x) => {
        x.apply(frame(root, 1, live));
        x.apply(frame(root, 1 + live.length, ohlcv));
        x.apply(frame(root, 1 + live.length + ohlcv.length, earlier));
      });
      const bars = m.view('1m', 'ETH').bars;
      for (const o of R[root].ohlcv1m.filter((x) => x.time * 1000 < H)) {
        const b = bars.find((x) => x.t === o.time * 1000)!;
        expect(b.source).toBe('MIXED');
        expect(b.volume).toBe(o.volume);
        expect([b.o, b.h, b.l, b.c]).toEqual([o.open, o.high, o.low, o.close]);
        expect(b.delta).toBe(b.buy - b.sell);
      }
    });
  });
}

describe('unknown sides (recorded prints, side withdrawn by the exchange)', () => {
  it('N prints stay UNKNOWN: in volume, excluded from delta / CVD, never re-classified', () => {
    const evs = events('GC');
    const k = evs.findIndex((t) => t.t >= H);
    const raw = R.GC.trades.map((t, i) => (i === k ? { ...t, side: 'N', aggressor: 'UNKNOWN' } : t));
    const page = parseTradesPage({ root: 'GC', contract: R.GC.contract, instrumentId: 1, trades: raw, complete: true, lastIndex: raw[raw.length - 1]!.i }, 'GC')!;
    const e = build('GC', (x) => x.apply(frame('GC', 1, page.trades.map((t) => toTradeEvent(t, R.GC.contract)))));
    const t = page.trades[k]!;
    const bar = e.view('1m', 'ETH').bars.find((b) => b.t === Math.floor(t.t / 60_000) * 60_000)!;
    const o = R.GC.ohlcv1m.find((x) => x.time * 1000 === bar.t)!;
    expect(bar.unknown).toBe(t.size);
    expect(bar.volume).toBe(o.volume);
    expect(bar.delta).toBe(bar.buy - bar.sell);
  });
});
