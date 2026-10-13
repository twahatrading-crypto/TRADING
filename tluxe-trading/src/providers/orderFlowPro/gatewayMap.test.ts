import { describe, expect, it } from 'vitest';
import {
  checkSequence,
  contractInfo,
  contractLabel,
  onTick,
  parseBook,
  parseCandles,
  parseDatabentoHealth,
  parseHeatmap,
  parseLocalSymbol,
  parseTradesPage,
  parseUpdates,
  toTradeEvent,
  topOfBook,
} from './gatewayMap';
import rec from './testing/gatewayRecorded.json';

/** RECORDED fixture: real gateway responses captured read-only on 2026-10-12 - deterministic, never LIVE. */
const R = rec as unknown as Record<string, Record<string, unknown>>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('recorded fixture is labelled', () => {
  it('declares itself RECORDED, not live', () => {
    expect(R._fixture!.kind).toBe('RECORDED');
    expect(String(R._fixture!.note)).toMatch(/NOT live data/);
  });
});

describe('contracts: exact COMEX outright mapping', () => {
  it('maps GC / SI month + year exactly', () => {
    const gc = parseLocalSymbol('GCZ6', 'GC', 2026)!;
    expect([gc.month, gc.year]).toEqual([12, 2026]);
    expect(contractLabel(gc)).toBe('GCZ6 (Dec 2026)');
    const si = parseLocalSymbol('SIZ6', 'SI', 2026)!;
    expect([si.month, si.year]).toEqual([12, 2026]);
    expect(parseLocalSymbol('GCG7', 'GC', 2026)!.year).toBe(2027);
    expect(parseLocalSymbol('GCZ26', 'GC', 2026)!.year).toBe(2026);
    // a December contract near year end resolves to the nearest year, not a decade away
    expect(parseLocalSymbol('GCZ5', 'GC', 2026)!.year).toBe(2025);
    const ci = contractInfo(gc, true);
    expect(ci).toMatchObject({ root: 'GC', localSymbol: 'GCZ6', exchange: 'COMEX', tradingClass: 'GC', multiplier: '100', expiry: '202612', verified: true });
    expect(contractInfo(si, false).multiplier).toBe('5000');
  });
  it('rejects other roots, micro / spread / spot symbols and cross-root contamination', () => {
    for (const bad of ['XAUUSD', 'XAGUSD', 'MGCZ6', 'SILZ6', 'GCZ6-GCG7', 'GC', 'GCZ', 'GCA6', 'gcz6', 'GCZ666', null, 6]) {
      expect(parseLocalSymbol(bad, 'GC', 2026), String(bad)).toBeNull();
    }
    expect(parseLocalSymbol('SIZ6', 'GC', 2026)).toBeNull();
    expect(parseLocalSymbol('GCZ6', 'SI', 2026)).toBeNull();
  });
  it('tick grid: GC 0.1, SI 0.005', () => {
    expect(onTick(4202.3, 'GC')).toBe(true);
    expect(onTick(4202.35, 'GC')).toBe(false);
    expect(onTick(60.985, 'SI')).toBe(true);
    expect(onTick(60.987, 'SI')).toBe(false);
    expect(onTick(0, 'GC')).toBe(false);
  });
});

describe('trades: schema + exchange aggressor', () => {
  it('accepts every recorded GC and SI print with exchange time and exchange side', () => {
    for (const root of ['GC', 'SI'] as const) {
      const body = R[`trades${root}`]!;
      const p = parseTradesPage(body, root)!;
      expect(p.contract).toBe(root === 'GC' ? 'GCZ6' : 'SIZ6');
      expect(p.trades.length).toBe((body.trades as unknown[]).length);
      expect(p.rejected).toEqual({});
      for (const t of p.trades) {
        expect(t.tRecv).toBeGreaterThanOrEqual(t.t);
        const ev = toTradeEvent(t, p.contract!);
        expect(ev.method).toBe('EXCHANGE');
        expect(ev.inferred).toBe(false);
        expect(ev.aggressor).toBe(t.side === 'B' ? 'BUY' : t.side === 'A' ? 'SELL' : 'UNKNOWN');
        expect(ev.id).toBe(`${p.contract}:${t.i}`);
      }
    }
  });
  it('N (not reported) stays UNKNOWN, labelled as such', () => {
    const body = clone(R.tradesGC!) as { trades: Array<Record<string, unknown>> };
    body.trades[0]!.side = 'N';
    body.trades[0]!.aggressor = 'UNKNOWN';
    const p = parseTradesPage(body, 'GC')!;
    const ev = toTradeEvent(p.trades[0]!, 'GCZ6');
    expect(ev.aggressor).toBe('UNKNOWN');
    expect(ev.basis).toBe('EXCHANGE_SIDE_NOT_REPORTED');
  });
  it('rejects malformed records per reason and never repairs them', () => {
    const body = clone(R.tradesGC!) as { trades: Array<Record<string, unknown>> };
    body.trades[0]!.side = 'X';
    body.trades[1]!.aggressor = 'SELL'; // side B but SELL
    body.trades[1]!.side = 'B';
    body.trades[2]!.price = 4202.35; // off tick
    body.trades[3]!.size = 0;
    body.trades[4]!.contract = 'GCG7'; // cross-contract record
    delete body.trades[5]!.tsEventNs;
    body.trades[6]!.tsRecvNs = (body.trades[6]!.tsEventNs as number) - 5e9; // received before it happened
    const p = parseTradesPage(body, 'GC')!;
    expect(p.rejected).toEqual({ SIDE: 1, AGGRESSOR_MISMATCH: 1, PRICE_OFF_TICK: 1, SIZE: 1, CONTRACT: 1, SCHEMA: 1, TIME: 1 });
    expect(p.trades.length).toBe(body.trades.length - 7);
  });
  it('rejects an envelope for the wrong root or with a broken shape', () => {
    expect(parseTradesPage(R.tradesGC, 'SI')).toBeNull();
    expect(parseTradesPage({ ...clone(R.tradesGC!), trades: 'x' }, 'GC')).toBeNull();
    expect(parseTradesPage({ ...clone(R.tradesGC!), lastIndex: '5' }, 'GC')).toBeNull();
    expect(parseTradesPage(null, 'GC')).toBeNull();
  });
});

describe('depth: IBKR price-level book + updates', () => {
  it('accepts the recorded book with its contract and ordering', () => {
    for (const root of ['GC', 'SI'] as const) {
      const b = parseBook(R[`book${root}`], root)!;
      expect(b.problem).toBeNull();
      expect(b.valid).toBe(true);
      expect(b.contract).toBe(root === 'GC' ? 'GCZ6' : 'SIZ6');
      expect(b.exchange).toBe('COMEX');
      expect(b.bids[0]![0]).toBeLessThan(b.asks[0]![0]);
      expect(b.rows).toBe(10);
      const q = topOfBook(1, new Map(b.bids), new Map(b.asks))!;
      expect([q.bid, q.ask]).toEqual([b.bids[0]![0], b.asks[0]![0]]);
    }
  });
  it('refuses MBO-claimed / non price-level books and flags crossed or unordered levels', () => {
    expect(parseBook({ ...clone(R.bookGC!), mbo: true }, 'GC')).toBeNull();
    expect(parseBook({ ...clone(R.bookGC!), depthType: 'MBO' }, 'GC')).toBeNull();
    const crossed = clone(R.bookGC!) as { bids: number[][]; asks: number[][] };
    crossed.bids[0]![0] = crossed.asks[0]![0]! + 0.5;
    crossed.bids.sort((a, b) => b[0]! - a[0]!);
    const c = parseBook(crossed, 'GC')!;
    expect(c.valid).toBe(false);
    expect(c.problem).toMatch(/crossed|ordered/);
    const unordered = clone(R.bookGC!) as { bids: number[][] };
    unordered.bids.reverse();
    expect(parseBook(unordered, 'GC')!.problem).toMatch(/ordered/);
  });
  it('recorded updates are contiguous; a skipped sequence is a gap', () => {
    const u = parseUpdates(R.updatesGC, 'GC')!;
    expect(u.rejected).toBe(0);
    const after = u.changes[0]!.seq - 1;
    expect(checkSequence(u.changes, after)).toEqual({ ok: u.changes, gapAt: null });
    const holed = u.changes.filter((_, i) => i !== 3);
    const r = checkSequence(holed, after);
    expect(r.gapAt).toBe(u.changes[3]!.seq);
    expect(r.ok.length).toBe(3);
    // overlap (already applied) is dropped exactly, not re-applied
    expect(checkSequence(u.changes, u.changes[5]!.seq).ok[0]!.seq).toBe(u.changes[6]!.seq);
  });
  it('malformed changes are counted, not applied', () => {
    const body = clone(R.updatesGC!) as { changes: unknown[][] };
    body.changes[0] = [1, 'mid', 1, 1, 1];
    body.changes[1]![2] = 4202.33;
    const u = parseUpdates(body, 'GC')!;
    expect(u.rejected).toBe(2);
  });
});

describe('bars / health / recorded depth', () => {
  it('closed Databento bars only (the forming bar is never presented as closed)', () => {
    const c = parseCandles(R.candlesM1GC, 'GC', '1m')!;
    const raw = (R.candlesM1GC!.bars as Array<{ isClosed: boolean }>);
    expect(c.bars.length).toBe(raw.filter((b) => b.isClosed).length);
    expect(c.contract).toBe('GCZ6');
    expect(parseCandles(R.candlesM1GC, 'GC', '5m')).toBeNull(); // timeframe must match the request
    const bad = clone(R.candlesM1GC!) as { bars: Array<Record<string, unknown>> };
    bad.bars[0]!.high = 1; // high below open / close
    expect(parseCandles(bad, 'GC', '1m')!.rejected).toBe(1);
  });
  it('Databento health per root', () => {
    const h = parseDatabentoHealth(R.dbHealth, 'GC')!;
    expect(h).toMatchObject({ state: 'LIVE', freshness: 'LIVE', contract: 'GCZ6', connection: 'CONNECTED' });
    expect(h.lastEventMs).toBeGreaterThan(1.7e12);
    expect(h.serverMs).toBeGreaterThan(1.7e12); // bridge clock: used instead of the browser clock
    expect(parseDatabentoHealth({ instruments: {} }, 'GC')).toBeNull();
  });
  it('recorded depth columns keep coverage and contract', () => {
    const h = parseHeatmap(R.heatmapGC, 'GC')!;
    expect(h.contract).toBe('GCZ6');
    expect(h.columns.length).toBeGreaterThan(0);
    for (const c of h.columns) expect(c.coverage).toBeGreaterThanOrEqual(0);
    expect(parseHeatmap({ ...clone(R.heatmapGC!), mbo: true }, 'GC')).toBeNull();
  });
});
