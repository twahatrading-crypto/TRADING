import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { DEFAULT_HLE_SETTINGS, HLE_SCORE_WEIGHTS } from './config';
import { analyzeHighLow, HighLowEngine, mandatoryGates, type HLEInput } from './engine';
import { aggregate, fromCloses, mirrorInput, path, T0 } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { analyzeHLEAt, hleClosedOnly, hleKnowledgeTimes, hleKnownInput, type HLEDataset } from './knowledge';
import { finalizeHLEScore, hleScoreComponents } from './score';
import type { HLESnapshot, Setup } from './types';

const S = { ...DEFAULT_HLE_SETTINGS };
const run = (candles: HLEInput, id = 'XAUUSD') => analyzeHighLow({ instrumentId: id, tickSize: 0.01, candles });
const ds = (candles: HLEInput): HLEDataset => ({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S, candles });
const key = (snap: HLESnapshot, side: 'BUY' | 'SELL' = 'BUY') => snap.setups.find((s) => s.side === side && Math.abs(s.level - (side === 'BUY' ? F.KEY_LOW : 300 - F.KEY_LOW)) < 1e-9)!;
const states = (s: Setup) => s.history.map((h) => h.to);
const h1Only = (closes: number[]) => {
  const h1 = fromCloses(closes, T0, 3600, 0.4);
  return run({ H1: h1, H4: aggregate(h1, 3600, 14400) });
};
const zig = (dir: 1 | -1) => {
  const legs: [number, number][] = [];
  let p = 100;
  for (let k = 0; k < 12; k++) {
    legs.push([p + dir * 7, 16], [p + dir * 3, 12]);
    p += dir * 3;
  }
  return path(100, ...legs);
};

describe('H4 direction (closed H4 candles, context only)', () => {
  it('Higher Highs + Higher Lows → BULLISH', () => {
    const h4 = h1Only(zig(1)).h4;
    expect(h4.bias).toBe('BULLISH');
    expect(h4.structure).toBe('Higher Highs + Higher Lows');
    expect(h4.lastSwingHigh!.price).toBeGreaterThan(h4.prevSwingHigh!.price);
  });
  it('Lower Highs + Lower Lows → BEARISH', () => {
    const h4 = h1Only(zig(-1)).h4;
    expect(h4.bias).toBe('BEARISH');
    expect(h4.structure).toBe('Lower Highs + Lower Lows');
  });
  it('contracting / expanding range → NEUTRAL (Range); too little history → INSUFFICIENT DATA', () => {
    // Rising highs with falling lows (HH + LL) — no single direction.
    const legs: [number, number][] = [];
    for (let k = 0; k < 12; k++) legs.push([110 + k * 1.5, 16], [100 - k * 1.5, 16]);
    const r = h1Only(path(100, ...legs)).h4;
    expect(r.bias).toBe('NEUTRAL');
    expect(r.structure).toMatch(/^Range \/ Neutral/);
    expect(h1Only(path(100, [104, 20], [100, 20])).h4.bias).toBe('INSUFFICIENT_DATA');
  });
  it('a BUY against a BEARISH H4 is flagged counter-trend but not blocked', () => {
    const s = key(run(F.buyReversal()));
    expect(s.h4AtSweep).toBe('BEARISH');
    expect(s.counterTrend).toBe(true);
    expect(states(s)).toContain('ENTRY_READY');
  });
});

describe('H1 levels (closed candles, UTC calendar)', () => {
  const snap = run(F.buyReversal());
  const coarse = F.coarseH1();
  const prevDay = coarse.slice(-24);
  it('Previous Day High / Low = the previous UTC day extremes, known when the day completes', () => {
    const pdl = snap.levels.find((l) => l.type === 'PDL' && l.periodStart === prevDay[0]!.time)!;
    const pdh = snap.levels.find((l) => l.type === 'PDH' && l.periodStart === prevDay[0]!.time)!;
    expect(pdl.price).toBe(Math.min(...prevDay.map((c) => c.low)));
    expect(pdh.price).toBe(Math.max(...prevDay.map((c) => c.high)));
    expect(pdl.createdAt).toBe(prevDay[0]!.time + 86400);
    expect(pdl.strength).toBe('STRONG');
    // The source candle is a real bar of that day.
    expect(prevDay.some((c) => c.time === pdl.sourceTime && c.low === pdl.price)).toBe(true);
  });
  it('Asia High / Low = extremes of 00:00–08:00 UTC, known at 08:00', () => {
    const day = F.coarseEnd(coarse);
    const asiaBars = (F.buyReversal().H1 ?? []).filter((c) => c.time >= day && c.time < day + 8 * 3600);
    const ah = snap.levels.find((l) => l.type === 'ASIA_HIGH' && l.periodStart === day)!;
    const al = snap.levels.find((l) => l.type === 'ASIA_LOW' && l.periodStart === day)!;
    expect(ah.price).toBe(Math.max(...asiaBars.map((c) => c.high)));
    expect(al.price).toBe(Math.min(...asiaBars.map((c) => c.low)));
    expect(ah.createdAt).toBe(day + 8 * 3600);
  });
  it('Major swing low: dominant, prominent, confirmed 3 bars later; PDL at the same price joins its setup (confluence, no duplicate)', () => {
    const sw = snap.levels.find((l) => l.type === 'SWING_LOW' && l.price === F.KEY_LOW)!;
    expect(sw.createdAt).toBe(sw.sourceTime + 4 * 3600);
    const s = key(snap);
    expect(s.levelType).toBe('SWING_LOW');
    expect(s.levelIds.map((id) => id.split(':')[3])).toEqual(['SWING_LOW', 'PDL']);
    expect(snap.setups.filter((x) => Math.abs(x.level - F.KEY_LOW) < 1e-9)).toHaveLength(1);
  });
  it('every level reports source, price, creation time, strength, state and distance; none is invented', () => {
    for (const l of snap.levels) {
      expect(l.createdAt).toBeGreaterThan(l.sourceTime);
      expect(['STRONG', 'MEDIUM', 'WEAK']).toContain(l.strength);
      expect(['ACTIVE', 'SWEPT', 'BROKEN', 'EXPIRED', 'SUPERSEDED']).toContain(l.status);
      expect(l.distance).toBeCloseTo(l.price - snap.price!, 9);
      const src = (F.buyReversal().H1 ?? []).find((c) => c.time === l.sourceTime)!;
      expect(l.kind === 'high' ? src.high : src.low).toBe(l.price);
    }
  });
  it('a newer previous-day level supersedes the older untouched one', () => {
    expect(snap.levels.some((l) => l.type === 'PDH' && l.status === 'SUPERSEDED')).toBe(true);
  });
});

describe('M15 liquidity (a sweep alone never confirms)', () => {
  it('BUY: SSL taken below the level, extreme / penetration / rejection recorded, then reclaimed', () => {
    const s = key(run(F.buyReversal()));
    expect(s.sweep!.extreme).toBeLessThan(F.KEY_LOW);
    expect(s.sweep!.penetration).toBeCloseTo(F.KEY_LOW - s.sweep!.extreme, 9);
    expect(s.sweep!.rejection).toBeGreaterThanOrEqual(0);
    expect(s.reclaim!.price).toBeGreaterThan(F.KEY_LOW);
    expect(states(s).slice(0, 6)).toEqual(['LEVEL_ACTIVE', 'LIQUIDITY_APPROACH', 'SWEPT', 'RECLAIMED', 'WAITING_M5', 'M5_CONFIRMED']);
  });
  it('SELL: BSL taken above the level (mirror)', () => {
    const s = key(run(F.sellReversal()), 'SELL');
    expect(s.sweep!.extreme).toBeGreaterThan(300 - F.KEY_LOW);
    expect(s.reclaim!.price).toBeLessThan(300 - F.KEY_LOW);
  });
  it('wick through without a reclaim → INVALIDATED; never reaches M5 / entry', () => {
    const s = key(run(F.wickNoReclaim()));
    expect(s.state).toBe('INVALIDATED');
    expect(s.reclaim).toBeNull();
    expect(s.history.at(-1)!.reason).toMatch(/without a reclaim/);
  });
  it('sweep continuation (accepted beyond) → INVALIDATED', () => {
    const s = key(run(F.continuation()));
    expect(s.state).toBe('INVALIDATED');
    expect(s.history.at(-1)!.reason).toMatch(/continuation/);
  });
  it('a swept + reclaimed setup without M5 structure is never ENTRY READY', () => {
    const s = key(run(F.reclaimNoM5()));
    expect(s.state).toBe('EXPIRED');
    expect(states(s)).not.toContain('ENTRY_READY');
  });
});

describe('M5 confirmation (closed M5 only)', () => {
  it('bullish CHOCH close after the SSL sweep + reclaim; displacement recorded', () => {
    const s = key(run(F.buyReversal()));
    expect(s.m5!.kind).toBe('CHOCH');
    expect(s.m5!.close).toBeGreaterThan(s.m5!.brokenLevel);
    expect(s.m5!.knownAt).toBeGreaterThanOrEqual(s.reclaim!.knownAt);
    expect(s.m5!.displacement.legAtr).toBeGreaterThan(0);
  });
  it('bearish CHOCH after the BSL sweep (mirror)', () => {
    const s = key(run(F.sellReversal()), 'SELL');
    expect(s.m5!.kind).toBe('CHOCH');
    expect(s.m5!.close).toBeLessThan(s.m5!.brokenLevel);
  });
  it('the forming M5 candle cannot confirm: one minute before the break bar closes there is no confirmation', () => {
    const d = ds(F.buyReversal());
    const full = key(run(d.candles));
    const before = key(analyzeHLEAt(d, full.m5!.knownAt - 60));
    expect(before.m5).toBeNull();
    expect(before.state).toBe('WAITING_M5');
    expect(key(analyzeHLEAt(d, full.m5!.knownAt)).m5).toEqual(full.m5);
  });
  it('closed-only input: a provider-flagged forming bar is dropped before the engine sees it', () => {
    const c: Candle[] = [{ time: 0, open: 1, high: 2, low: 0, close: 1, volume: null, isClosed: true }, { time: 60, open: 1, high: 9, low: 0, close: 9, volume: null, isClosed: false }];
    expect(hleClosedOnly(c)).toHaveLength(1);
  });
  it('an M5 close beyond the sweep extreme → INVALIDATED before entry', () => {
    const s = key(run(F.invalidatedBeforeEntry()));
    expect(s.state).toBe('INVALIDATED');
    expect(s.entry).toBeNull();
  });
});

describe('M1 entry, zone, SL and targets', () => {
  const s = key(run(F.buyReversal()));
  it('M1 pullback is detected only after M5 confirmation; ENTRY READY on a pullback into the zone', () => {
    expect(s.pullback!.time).toBeGreaterThanOrEqual(s.m5!.knownAt);
    expect(s.entry!.time).toBeGreaterThanOrEqual(s.m5!.knownAt);
    expect(Object.values(mandatoryGates(s)).every(Boolean)).toBe(true);
  });
  it('entry zone from an M5 order block overlapping an M1 FVG inside the leg, defined at the confirmation close', () => {
    expect(s.zone!.source).toBe('OB+FVG');
    expect(s.zone!.ob).not.toBeNull();
    expect(s.zone!.fvg).not.toBeNull();
    expect(s.zone!.definedAt).toBe(s.m5!.knownAt);
    expect(s.zone!.low).toBeGreaterThanOrEqual(s.sweep!.extreme - 1e-9);
    expect(s.zone!.high).toBeLessThanOrEqual(s.m5!.close);
  });
  it('entry = zone midpoint; SL = sweep extreme − 0.2 × M5 ATR', () => {
    expect(s.risk!.entry).toBeCloseTo((s.zone!.low + s.zone!.high) / 2, 9);
    expect(s.risk!.stop).toBeCloseTo(s.sweep!.extreme - S.slBufferAtr * s.m5!.displacement.atr, 9);
  });
  it('TP1 / TP2 = the two nearest opposing liquidity targets beyond the leg (here Asia High, then PDH)', () => {
    expect(s.risk!.tp1Source).toBe('Asia High');
    expect(s.risk!.tp2Source).toBe('Previous Day High');
    expect(s.risk!.tp2!).toBeGreaterThan(s.risk!.tp1!);
    expect(s.risk!.rr1).toBeCloseTo((s.risk!.tp1! - s.risk!.entry) / (s.risk!.entry - s.risk!.stop), 9);
  });
  it('confirmation then TP1 reached before any pullback → EXPIRED (missed)', () => {
    const m = key(run(F.confirmNoPullback()));
    expect(m.state).toBe('EXPIRED');
    expect(m.entry).toBeNull();
    expect(m.history.at(-1)!.reason).toMatch(/missed/);
  });
  it('without FVG / OB the zone is the reclaim band [level − ½ penetration, level]', () => {
    const snap = analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...S, obLookback: 0 }, candles: F.buyReversal() });
    const r = key(snap);
    if (r.zone!.source === 'RECLAIM') {
      expect(r.zone!.high).toBeCloseTo(F.KEY_LOW, 9);
      expect(r.zone!.low).toBeCloseTo(F.KEY_LOW - r.sweep!.penetration / 2, 9);
    } else expect(r.zone!.source).toBe('FVG');
  });
});

describe('BUY / SELL symmetry', () => {
  it('the mirrored data produces the mirrored SELL setup with identical states, times, R:R and score', () => {
    const b = key(run(F.buyReversal()));
    const s = key(run(F.sellReversal()), 'SELL');
    expect(states(s)).toEqual(states(b));
    expect(s.entry!.time).toBe(b.entry!.time);
    expect(s.risk!.stop).toBeCloseTo(300 - b.risk!.stop, 6);
    expect(s.risk!.tp1!).toBeCloseTo(300 - b.risk!.tp1!, 6);
    expect(s.risk!.rr1!).toBeCloseTo(b.risk!.rr1!, 6);
    expect(s.score.total).toBe(b.score.total);
  });
});

describe('score — descriptive, never a gate', () => {
  it('weights total 100 and total = Σ weight × component / 100', () => {
    expect(Object.values(HLE_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const s = key(run(F.buyReversal()));
    expect(s.score.total).toBe(Math.round(Object.values(s.score.contributions).reduce((a, b) => a + b, 0)));
    expect(s.score.components.htfAlignment).toBe(0);
    expect(s.score.components.m5Structure).toBe(100);
  });
  it('99-like score without M5 confirmation is still NO ENTRY', () => {
    const s = key(run(F.reclaimNoM5()));
    const boosted = { ...s, h4AtSweep: 'BULLISH' as const };
    const sc = finalizeHLEScore({ ...hleScoreComponents(boosted, 100, 'BULLISH'), m5Structure: 100, m1EntryQuality: 100, fvgObConfluence: 100, sweepQuality: 100, rejectionDisplacement: 100 });
    expect(sc.total).toBeGreaterThanOrEqual(99);
    expect(mandatoryGates(boosted).m5).toBe(false);
    expect(s.state).not.toBe('ENTRY_READY');
  });
});

describe('events, data integrity and isolation', () => {
  it('signal log: deterministic ids, every event has time / instrument / timeframe / type / price / setup, no duplicates', () => {
    const snap = run(F.buyReversal());
    const ids = snap.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const types = snap.events.filter((e) => e.setupId === key(snap).id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['LEVEL_DETECTED', 'LEVEL_APPROACH', 'SSL_TAKEN', 'LEVEL_RECLAIMED', 'M5_CHOCH', 'M1_PULLBACK', 'ENTRY_READY', 'SETUP_EXPIRED']));
    expect(snap.events.some((e) => e.type === 'H4_BIAS_CHANGED')).toBe(true);
    for (const e of snap.events) expect(e.instrumentId).toBe('XAUUSD');
    // Recomputing (e.g. a browser refresh) yields the identical log.
    expect(JSON.stringify(run(F.buyReversal()).events)).toBe(JSON.stringify(snap.events));
  });
  it('ENTRY READY → signal; the engine keeps it frozen after the signal window ends', () => {
    const d = ds(F.buyReversal());
    const full = key(run(d.candles));
    const at = analyzeHLEAt(d, full.entry!.knownAt);
    expect(at.signal).toEqual({ side: 'BUY', setupId: full.id, at: full.entry!.knownAt });
    expect(key(at).state).toBe('ENTRY_READY');
    expect(run(d.candles).signal).toBeNull();
  });
  it('incremental updates in any chunking equal one full run (replay determinism)', () => {
    const d = ds(F.buyReversal());
    const times = hleKnowledgeTimes(d);
    const e = new HighLowEngine({ instrumentId: 'XAUUSD', tickSize: 0.01 });
    for (let k = 0; k < times.length; k += 41) e.update(hleKnownInput(d, times[k]!));
    e.update(d.candles);
    expect(JSON.stringify(e.snapshot())).toBe(JSON.stringify(run(d.candles)));
  });
  it('duplicate and out-of-order candles are rejected and counted; results unchanged', () => {
    const c = F.buyReversal();
    const m1 = [...c.M1!];
    const snap = run({ ...c, M1: [...m1.slice(0, 500), m1[499]!, m1[100]!, ...m1.slice(500)] });
    expect(snap.timeframes.M1.rejected).toBe(2);
    expect(key(snap).history).toEqual(key(run(c)).history);
  });
  it('missing candles (a gap in M1) never fabricate bars; the engine continues from real bars', () => {
    const c = F.buyReversal();
    const m1 = c.M1!.filter((_, k) => k < 100 || k > 130);
    const snap = run({ ...c, M1: m1 });
    expect(snap.timeframes.M1.bars).toBe(m1.length);
  });
  it('insufficient history and no data are reported, not approximated', () => {
    expect(run({}).state).toBe('NO_DATA');
    expect(run({}).engineState).toBe('WAITING_FOR_LEVEL');
    const short = run({ H1: F.coarseH1().slice(0, 30) });
    expect(short.state).toBe('INSUFFICIENT_HISTORY');
  });
  it('instrument isolation (ids carry the instrument) and timeframe isolation (extra timeframes ignored)', () => {
    const a = run(F.buyReversal(), 'XAUUSD');
    const b = run(F.buyReversal(), 'XAGUSD');
    expect(a.setups.every((s) => s.id.startsWith('XAUUSD:'))).toBe(true);
    expect(b.setups.every((s) => s.id.startsWith('XAGUSD:'))).toBe(true);
    expect(JSON.stringify(run({ ...F.buyReversal(), M30: [], D1: [] } as HLEInput))).toBe(JSON.stringify(a));
  });
  it('no future leakage: later candles never change what was recorded earlier', () => {
    const d = ds(F.buyReversal());
    const full = key(run(d.candles));
    const early = key(analyzeHLEAt(d, full.entry!.knownAt));
    for (const k of ['sweep', 'reclaim', 'm5', 'zone', 'risk', 'entry', 'pullback'] as const) expect(full[k]).toEqual(early[k]);
    expect(full.history.slice(0, early.history.length)).toEqual(early.history);
  });
  it('mirrored XAGUSD-like data is not hardcoded to one instrument (price scale independent)', () => {
    const scaled = (inp: HLEInput): HLEInput => Object.fromEntries(Object.entries(inp).map(([tf, cs]) => [tf, (cs as Candle[]).map((x) => ({ ...x, open: x.open / 4, high: x.high / 4, low: x.low / 4, close: x.close / 4 }))])) as HLEInput;
    const a = key(run(F.buyReversal()));
    const snap = run(scaled(F.buyReversal()), 'XAGUSD');
    const b = snap.setups.find((x) => Math.abs(x.level - F.KEY_LOW / 4) < 1e-9)!;
    expect(states(b)).toEqual(states(a));
    expect(b.risk!.rr1!).toBeCloseTo(a.risk!.rr1!, 6);
    void mirrorInput;
  });
});
