import { describe, expect, it } from 'vitest';
import { DEFAULT_FP_SETTINGS, FP_MAX_CANDLES, type FootprintSettings } from './config';
import { FootprintEngine } from './engine';
import { analyzeFootprintAt, auditFootprint, fpKnowledgeTimes, type FPDataset } from './replay';
import { FULL_FP_CAPS, T0_MS as T, capsMsg, generatedStream, hb, tr } from './testing/stream';
import type { Aggressor, FootprintMsg, FPCandle } from './types';

/* TEST DATA ONLY — hand-built and seeded synthetic trade streams. */

const S = (o: Partial<FootprintSettings> = {}): FootprintSettings => ({ ...DEFAULT_FP_SETTINGS, ...o });
function run(msgs: FootprintMsg[], o: Partial<FootprintSettings> = {}, caps = FULL_FP_CAPS) {
  const e = new FootprintEngine({ instrumentId: 'GC', tickSize: 0.1, settings: S(o) });
  e.processAll([capsMsg(caps), ...msgs]);
  return e;
}
/** Trades at the given (price, size, side) list inside the first M1 candle, then a heartbeat that closes it. */
let seqN = 0;
function candle(rows: [number, number, Aggressor][], startMs = T, close = true): FootprintMsg[] {
  const out: FootprintMsg[] = rows.map(([p, v, a], k) => tr(++seqN, startMs + 100 + k * 50, p, v, a));
  if (close) out.push(hb(startMs + 60_000));
  return out;
}
const m1 = (e: FootprintEngine, i = 0): FPCandle => e.candles('M1')[i]!;
const row = (c: FPCandle, p: number) => c.rows.find((r) => r.price === p)!;

describe('Volume Footprint — aggregation & definitions', () => {
  it('Bid × Ask per price, delta = ask − bid, totals, delta %, candle POC', () => {
    const e = run(candle([[2400, 10, 'BUY'], [2400, 4, 'SELL'], [2400.1, 5, 'BUY']]));
    const c = m1(e);
    expect(c.closed).toBe(true);
    expect(row(c, 2400)).toMatchObject({ bid: 4, ask: 10, delta: 6, total: 14 });
    expect(row(c, 2400.1)).toMatchObject({ bid: 0, ask: 5, delta: 5 });
    expect(c).toMatchObject({ bid: 4, ask: 15, delta: 11, volume: 19, poc: 2400, pocVolume: 14, open: 2400, high: 2400.1, low: 2400, close: 2400.1 });
    expect(c.deltaPct).toBeCloseTo((11 / 19) * 100);
    expect(c.rows.map((r) => r.price)).toEqual([2400.1, 2400]); // descending
  });

  it('UNKNOWN aggressor stays UNKNOWN — never split into bid / ask, excluded from delta', () => {
    const e = run(candle([[2400, 10, 'BUY'], [2400, 7, 'UNKNOWN']]));
    const c = m1(e);
    expect(row(c, 2400)).toMatchObject({ ask: 10, bid: 0, unknown: 7, delta: 10, total: 17 });
    expect(c.delta).toBe(10);
    expect(c.volume).toBe(17);
    expect(e.snapshot().cvdAvailability).toBe('PARTIAL');
    // A provider without an aggressor source: a BUY flag on the wire is NOT trusted.
    const n = run(candle([[2400, 10, 'BUY']]), {}, { ...FULL_FP_CAPS, aggressor: 'NONE' });
    expect(m1(n)).toMatchObject({ ask: 0, bid: 0, unknown: 10, delta: 0, deltaPct: null });
    expect(n.snapshot().status).toBe('UNCLASSIFIED');
    expect(n.snapshot().statusReason).toMatch(/aggressor side/);
    expect(n.snapshot().cvdAvailability).toBe('UNAVAILABLE');
  });

  it('cumulative delta = running sum of classified trade delta; session delta resets at 18:00 New York', () => {
    const e = run([...candle([[2400, 10, 'BUY'], [2400, 3, 'SELL']]), ...candle([[2400, 2, 'BUY'], [2400, 20, 'SELL']], T + 60_000)]);
    expect(e.snapshot().cvd).toBe(7 - 18);
    expect(e.snapshot().sessionDelta).toBe(-11);
    const s = Date.UTC(2026, 0, 6, 23, 0); // 18:00 New York (EST)
    const f = run([...candle([[2400, 10, 'BUY']], s - 120_000), ...candle([[2400, 4, 'SELL']], s)]);
    expect(f.snapshot().cvd).toBe(6);
    expect(f.snapshot().sessionDelta).toBe(-4);
    expect(f.snapshot().sessionStart).toBe(s / 1000);
  });

  it('candle POC tie → the row nearer the candle middle', () => {
    const c = m1(run(candle([[2400, 10, 'BUY'], [2400.1, 3, 'BUY'], [2400.2, 10, 'SELL'], [2400.3, 3, 'SELL'], [2400.4, 10, 'BUY']])));
    expect(c.poc).toBe(2400.2);
  });

  it('price aggregation groups ticks into rows (row = lower edge)', () => {
    const c = m1(run(candle([[2400, 1, 'BUY'], [2400.4, 2, 'BUY'], [2400.5, 3, 'SELL']]), { rowTicks: 5 }));
    expect(c.rows.map((r) => [r.price, r.ask, r.bid])).toEqual([[2400.5, 0, 3], [2400, 3, 0]]);
  });

  it('M1 · M5 · … are aggregated independently from the same trades', () => {
    const msgs: FootprintMsg[] = [];
    for (let k = 0; k < 5; k++) msgs.push(...candle([[2400 + k * 0.1, 10 + k, 'BUY']], T + k * 60_000, false));
    msgs.push(hb(T + 300_000));
    const e = run(msgs);
    expect(e.candles('M1')).toHaveLength(5);
    const m5 = e.candles('M5');
    expect(m5).toHaveLength(1);
    expect(m5[0]!.volume).toBe(e.candles('M1').reduce((s, c) => s + c.volume, 0));
    expect(m5[0]!.rows).toHaveLength(5);
  });
});

describe('Volume Footprint — imbalance detection', () => {
  it('diagonal BUY imbalance keeps the numbers that produced it; threshold respected', () => {
    const e = run(candle([[2400, 10, 'SELL'], [2400, 1, 'BUY'], [2400.1, 40, 'BUY'], [2400.1, 2, 'SELL']]));
    const c = m1(e);
    expect(row(c, 2400.1)).toMatchObject({ buyImb: true, buyRatio: 4 });
    const imb = e.imbalances('M1').find((x) => x.side === 'BUY')!;
    expect(imb).toMatchObject({ price: 2400.1, ask: 40, bid: 10, comparedPrice: 2400, ratio: 4, side: 'BUY' });
    const below = run(candle([[2400, 10, 'SELL'], [2400.1, 29, 'BUY']]));
    expect(m1(below).buyImbalances).toBe(0);
    const at = run(candle([[2400, 10, 'SELL'], [2400.1, 30, 'BUY']]));
    expect(m1(at).buyImbalances).toBe(1);
  });

  it('SELL imbalance: bid(p) vs ask(p + 1 row); horizontal mode compares the same row', () => {
    const e = run(candle([[2400, 45, 'SELL'], [2400.1, 5, 'BUY']]));
    expect(row(m1(e), 2400)).toMatchObject({ sellImb: true, sellRatio: 9 });
    const h = run(candle([[2400, 45, 'SELL'], [2400, 5, 'BUY'], [2400.1, 50, 'BUY']]), { imbalanceMode: 'horizontal' });
    expect(row(m1(h), 2400)).toMatchObject({ sellImb: true, sellRatio: 9 });
    expect(row(m1(h), 2400.1)).toMatchObject({ buyImb: true, buyRatio: null }); // same-row bid 0 → ∞
  });

  it('minimum volume and edge rows: no diagonal partner → never labelled', () => {
    const e = run(candle([[2400, 40, 'BUY'], [2400.1, 3, 'BUY']]), { minVolume: 10 });
    const c = m1(e);
    expect(c.buyImbalances).toBe(0); // 2400.0 has no row below; 2400.1 ask 3 < minVolume
  });

  it('STACKED BUY IMBALANCE: ≥ 3 consecutive rows, range / levels / ratios / candle id stored', () => {
    const rows: [number, number, Aggressor][] = [];
    for (let k = 0; k < 5; k++) rows.push([2400 + k * 0.1, 50, 'BUY'], [2400 + k * 0.1, 5, 'SELL']);
    const e = run(candle(rows));
    const st = e.stacks('M1');
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ side: 'BUY', low: 2400.1, high: 2400.4, levels: 4, ratios: [10, 10, 10, 10], candleId: m1(e).id, state: 'ACTIVE' });
    const ev = e.events('M1').find((x) => x.type === 'STACKED BUY IMBALANCE')!;
    expect(ev.evidence).toMatch(/4 consecutive BUY imbalance rows 2400.1–2400.4/);
    expect(ev.evidence).toMatch(/300%/);
    expect(run(candle(rows), { stackedLevels: 5 }).stacks('M1')).toHaveLength(0);
    expect(e.imbalances('M1').filter((x) => x.stacked)).toHaveLength(4);
  });

  it('stack lifecycle moves forward only: TESTED on a revisit, CONSUMED on a close through it', () => {
    const rows: [number, number, Aggressor][] = [];
    for (let k = 0; k < 5; k++) rows.push([2400 + k * 0.1, 50, 'BUY'], [2400 + k * 0.1, 5, 'SELL']);
    const e = run([...candle(rows), ...candle([[2400.3, 5, 'SELL'], [2400.6, 5, 'BUY']], T + 60_000), ...candle([[2400.3, 5, 'SELL'], [2399.8, 5, 'SELL']], T + 120_000)]);
    const s = e.stacks('M1')[0]!;
    expect(s.state).toBe('CONSUMED');
    expect(s.testedAt).toBe((T + 120_000) / 1000);
    expect(s.consumedAt).toBe((T + 180_000) / 1000);
  });
});

describe('Volume Footprint — candidates (evidence only)', () => {
  it('ABSORPTION CANDIDATE at the high: heavy aggressive buying at the extreme, close well below', () => {
    const rows: [number, number, Aggressor][] = [];
    for (let k = 0; k <= 10; k++) rows.push([2400 + k * 0.1, 4, 'BUY']);
    rows.push([2401, 40, 'BUY'], [2400.9, 20, 'BUY'], [2400.2, 3, 'SELL']);
    const e = run(candle(rows));
    const a = e.events('M1').find((x) => x.type === 'ABSORPTION CANDIDATE')!;
    expect(a.price).toBe(2401);
    expect(a.evidence).toMatch(/Ask 68 in top 2 rows/);
    expect(a.evidence).toMatch(/8 rows below the high/);
    // Continuation (close at the high) → no candidate.
    const cont = run(candle([...rows.slice(0, -1), [2401, 1, 'BUY']]));
    expect(cont.events('M1').some((x) => x.type === 'ABSORPTION CANDIDATE')).toBe(false);
  });

  it('EXHAUSTION CANDIDATE: new high with volume tapering into the extreme', () => {
    const prev = candle([[2400, 5, 'BUY'], [2400.5, 5, 'BUY']]);
    const vols = [50, 60, 40, 20, 8, 4, 1];
    const cur = candle(vols.map((v, k) => [2400 + k * 0.1, v, k % 2 ? 'BUY' : 'SELL'] as [number, number, Aggressor]), T + 60_000);
    const e = run([...prev, ...cur]);
    const x = e.events('M1').find((y) => y.type === 'EXHAUSTION CANDIDATE')!;
    expect(x.price).toBe(2400.6);
    expect(x.evidence).toMatch(/8 → 4 → 1/);
    expect(m1(e, 1).exhaustion).toBe(1);
    // No new high → none.
    const e2 = run([...candle([[2400, 5, 'BUY'], [2401, 5, 'BUY']]), ...cur]);
    expect(e2.events('M1').some((y) => y.type === 'EXHAUSTION CANDIDATE' && y.price === 2400.6)).toBe(false);
  });

  it('DELTA DIVERGENCE CANDIDATE: new high while delta weakens (and new low while delta strengthens)', () => {
    const msgs: FootprintMsg[] = [];
    for (let k = 0; k < 5; k++) msgs.push(...candle([[2400 + k * 0.1, 20, 'BUY'], [2400, 5, 'SELL']], T + k * 60_000));
    msgs.push(...candle([[2401, 5, 'BUY'], [2400.9, 30, 'SELL']], T + 5 * 60_000));
    const e = run(msgs);
    const d = e.events('M1').find((x) => x.type === 'DELTA DIVERGENCE CANDIDATE')!;
    expect(d.price).toBe(2401);
    expect(d.delta).toBe(-25);
    expect(d.evidence).toMatch(/delta weakened: -25 vs 15/);
    const up: FootprintMsg[] = [];
    for (let k = 0; k < 5; k++) up.push(...candle([[2400 - k * 0.1, 20, 'SELL'], [2400, 5, 'BUY']], T + k * 60_000));
    up.push(...candle([[2399, 30, 'BUY'], [2399.1, 5, 'SELL']], T + 5 * 60_000));
    expect(run(up).events('M1').some((x) => x.type === 'DELTA DIVERGENCE CANDIDATE' && x.price === 2399)).toBe(true);
  });

  it('UNFINISHED AUCTION CANDIDATE only when the extreme row traded on both sides (no UNKNOWN)', () => {
    const e = run(candle([[2400.5, 3, 'SELL'], [2400.5, 2, 'BUY'], [2400, 6, 'SELL'], [2400.2, 4, 'BUY']]));
    const ua = e.events('M1').filter((x) => x.type === 'UNFINISHED AUCTION CANDIDATE');
    expect(ua.map((x) => x.price)).toEqual([2400.5]);
    expect(ua[0]!.evidence).toMatch(/3 × 2/);
    const unk = run(candle([[2400.5, 3, 'SELL'], [2400.5, 2, 'UNKNOWN'], [2400.5, 2, 'BUY'], [2400, 6, 'SELL']]));
    expect(unk.events('M1').some((x) => x.type === 'UNFINISHED AUCTION CANDIDATE')).toBe(false);
  });

  it('never emits trade signals', () => {
    const e = run(generatedStream({ minutes: 60, seed: 3 }));
    for (const tf of ['M1', 'M5'] as const) for (const x of e.events(tf)) expect(`${x.type} ${x.evidence}`).not.toMatch(/\b(BUY SIGNAL|SELL SIGNAL|ENTRY|STOP LOSS|TAKE PROFIT)\b/);
  });
});

describe('Volume Footprint — data integrity', () => {
  it('duplicate trades are dropped and counted (by trade id)', () => {
    const a = tr(1, T + 100, 2400, 10, 'BUY');
    const e = run([a, { ...a, recvTime: a.recvTime + 5 }, hb(T + 60_000)]);
    expect(m1(e).volume).toBe(10);
    expect(e.integrity().duplicates).toBe(1);
    expect(e.integrity().accepted).toBe(1);
  });

  it('sequence gap: counted, candle flagged GAP, nothing filled; integrity DEGRADED', () => {
    const e = run([tr(1, T + 100, 2400, 1, 'BUY'), tr(2, T + 200, 2400, 1, 'BUY'), tr(5, T + 300, 2400, 1, 'SELL'), hb(T + 60_000)]);
    const i = e.integrity();
    expect(i).toMatchObject({ gaps: 1, missing: 2, state: 'DEGRADED' });
    expect(m1(e)).toMatchObject({ gap: true, volume: 3 });
    expect(e.events('M1').find((x) => x.type === 'SEQUENCE GAP')!.evidence).toMatch(/2 → 5: 2 trade\(s\) missing/);
  });

  it('out-of-order trade inside the open candle is applied and counted', () => {
    const e = run([tr(1, T + 100, 2400, 1, 'BUY'), tr(3, T + 300, 2400, 1, 'BUY'), tr(2, T + 200, 2400, 1, 'SELL'), hb(T + 60_000)]);
    expect(e.integrity().outOfOrder).toBe(1);
    expect(m1(e)).toMatchObject({ volume: 3, bid: 1, ask: 2 });
  });

  it('late trade for an already-closed candle is EXCLUDED — history never repaints', () => {
    const base = [tr(1, T + 100, 2400, 5, 'BUY'), hb(T + 60_000)];
    const e = run(base);
    const before = JSON.stringify(m1(e));
    e.process(tr(2, T + 500, 2400, 99, 'SELL'));
    expect(JSON.stringify(m1(e))).toBe(before);
    expect(e.integrity()).toMatchObject({ late: 1, state: 'DEGRADED' });
    expect(e.events('M1').some((x) => x.type === 'LATE TRADE EXCLUDED')).toBe(true);
  });

  it('disconnect → UNAVAILABLE + open candle INTERRUPTED; reconnect is logged (DEGRADED window)', () => {
    const e = run([tr(1, T + 100, 2400, 5, 'BUY'), { type: 'status', instrumentId: 'GC', recvTime: T + 1000, status: 'DISCONNECTED', detail: 'socket closed' }]);
    expect(e.integrity().state).toBe('UNAVAILABLE');
    expect(e.candles('M1')[0]!.interrupted).toBe(true);
    e.process({ type: 'status', instrumentId: 'GC', recvTime: T + 5000, status: 'RECONNECTED', detail: null });
    e.process(tr(2, T + 6000, 2400, 1, 'BUY'));
    expect(e.integrity()).toMatchObject({ disconnects: 1, reconnects: 1, feed: 'LIVE', state: 'DEGRADED' });
    expect(e.events('M1').map((x) => x.type)).toEqual(expect.arrayContaining(['FEED DISCONNECTED', 'FEED RECONNECTED']));
  });

  it('contract switch starts a new footprint — contracts are never combined', () => {
    const e = run([tr(1, T + 100, 2400, 5, 'BUY'), hb(T + 60_000), tr(1, T + 61_000, 2410, 7, 'SELL', { contract: 'GCG7' }), hb(T + 120_000)]);
    const s = e.snapshot();
    expect(s.contract).toBe('GCG7');
    expect(s.previousContracts).toEqual(['GCZ6']);
    expect(e.candles('M1')).toHaveLength(1);
    expect(m1(e)).toMatchObject({ contract: 'GCG7', volume: 7 });
    expect(m1(e).id).toMatch(/^GCG7:M1:/);
    expect(s.cvd).toBe(-7);
    expect(e.events('M1').some((x) => x.type === 'CONTRACT CHANGED')).toBe(true);
  });

  it('no provider capability → FOOTPRINT DATA UNAVAILABLE (trades refused, nothing built)', () => {
    const e = new FootprintEngine({ instrumentId: 'GC', tickSize: 0.1 });
    e.processAll(candle([[2400, 10, 'BUY']]));
    const s = e.snapshot();
    expect(s.status).toBe('UNAVAILABLE');
    expect(s.statusReason).toMatch(/individual exchange trades/);
    expect(s.integrity.state).toBe('UNAVAILABLE');
    expect(e.candles('M1')).toHaveLength(0);
  });

  it('unsequenced feed → DEGRADED (gaps undetectable), never GOOD', () => {
    const e = run(candle([[2400, 1, 'BUY']]), {}, { ...FULL_FP_CAPS, sequenced: false });
    expect(e.integrity().state).toBe('DEGRADED');
    expect(e.integrity().reasons.join(' ')).toMatch(/not sequenced/);
  });

  it('bounded buffers: closed history is capped per timeframe with stable ids', () => {
    const msgs: FootprintMsg[] = [];
    for (let k = 0; k < FP_MAX_CANDLES.M1 + 30; k++) msgs.push(tr(k + 1, T + k * 60_000 + 10, 2400, 1, 'BUY'));
    const e = run(msgs);
    expect(e.closedCount('M1')).toBe(FP_MAX_CANDLES.M1);
    expect(e.candles('M1').at(-2)!.id).toBe(`GCZ6:M1:${(T + (FP_MAX_CANDLES.M1 + 28) * 60_000) / 1000}`);
  });
});

describe('Volume Footprint — replay, parity, anti-repaint', () => {
  const ds: FPDataset = { instrumentId: 'GC', tickSize: 0.1, settings: S(), messages: generatedStream({ minutes: 90, seed: 7 }) };

  it('the same input stream always reproduces the same footprint', () => {
    const a = new FootprintEngine({ instrumentId: 'GC', tickSize: 0.1 });
    const b = new FootprintEngine({ instrumentId: 'GC', tickSize: 0.1 });
    a.processAll(ds.messages);
    b.processAll(ds.messages);
    expect(JSON.stringify(a.fullState())).toBe(JSON.stringify(b.fullState()));
    expect(a.candles('M1').length).toBeGreaterThan(80);
    expect(a.stacks('M1').length + a.imbalances('M1').length).toBeGreaterThan(0);
  });

  it('incremental == clean recomputation at every checkpoint; no leaks; closed candles / events never change', () => {
    const r = auditFootprint(ds, { stride: 40 });
    expect(r.checks).toBeGreaterThan(40);
    expect(r.mismatches).toEqual([]);
    expect(r.leaks).toEqual([]);
    expect(r.mutations).toEqual([]);
  }, 120_000);

  it('anti-lookahead: at T only trades received by T exist; a look-ahead engine is detected', () => {
    const times = fpKnowledgeTimes(ds.messages);
    const K = times[Math.floor(times.length / 2)]!;
    const e = analyzeFootprintAt(ds, K);
    const known = ds.messages.filter((m) => m.type === 'trade' && m.recvTime <= K).length;
    expect(e.integrity().accepted + e.integrity().duplicates + e.integrity().late).toBe(known);
    expect(e.snapshot().knowledgeTime).toBeLessThanOrEqual(K);
    const cheat = new FootprintEngine({ instrumentId: 'GC', tickSize: 0.1 });
    cheat.processAll(ds.messages.filter((m) => m.recvTime <= K + 30_000));
    expect(JSON.stringify(cheat.fullState())).not.toBe(JSON.stringify(e.fullState()));
  });

  it('a stream with a gap, duplicate, late trade, disconnect and contract roll still replays deterministically', () => {
    const base = generatedStream({ minutes: 20, seed: 9 });
    const msgs = [...base];
    const k = Math.floor(msgs.length / 3);
    const t = msgs[k]! as Extract<FootprintMsg, { type: 'trade' }>;
    msgs.splice(k + 1, 0, { ...t, recvTime: t.recvTime }); // duplicate
    msgs.splice(k + 5, 2); // gap
    const last = msgs[msgs.length - 1]!;
    msgs.push({ type: 'status', instrumentId: 'GC', recvTime: last.recvTime + 10, status: 'DISCONNECTED', detail: null }, { type: 'status', instrumentId: 'GC', recvTime: last.recvTime + 20, status: 'RECONNECTED', detail: null });
    msgs.push(...generatedStream({ minutes: 10, seed: 10, t0: last.recvTime + 60_000, contract: 'GCG7' }).slice(2));
    const r = auditFootprint({ ...ds, messages: msgs }, { stride: 25 });
    expect(r.mismatches).toEqual([]);
    expect(r.leaks).toEqual([]);
    expect(r.mutations).toEqual([]);
  }, 120_000);
});
