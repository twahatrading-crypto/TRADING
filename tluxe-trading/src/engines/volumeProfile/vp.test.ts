import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { auditVolumeProfile } from './antiRepaint';
import { DEFAULT_VP_SETTINGS } from './config';
import { confluence } from './confluence';
import { VolumeProfileEngine, analyzeVolumeProfile } from './engine';
import { T0, bar, dataset, m5Walk } from './fixtures/builders';
import { accumulate, niceStep, rowSize, rowsOf, valueArea } from './histogram';
import { analyzeVPAt, vpKnowledgeTimes, vpKnownInput, type VPDataset } from './knowledge';
import { acceptance, locate, nodeStates, profileState } from './location';
import { detectNodes } from './nodes';
import { nextTradingDayStart, sessionsAt, tradingDayStart, weekStart } from './periods';
import { buildProfile } from './profile';
import { vpScore } from './score';
import type { ProfileRow, VolumeProfile } from './types';
import { chooseVolume } from './volume';

/* TEST DATA ONLY — synthetic candles and synthetic tick volume. */

const S = { ...DEFAULT_VP_SETTINGS };
const MT5 = { kind: 'spot-otc', exchange: null };
const FUT = { kind: 'future', exchange: 'COMEX' };
const rows = (vols: number[], start = 100, size = 1): ProfileRow[] => vols.map((v, i) => ({ price: start + i * size, volume: v }));

describe('volume at price', () => {
  it('allocates a bar over the rows its range touches, conserving total volume exactly', () => {
    const h = new Map<number, number>();
    accumulate(h, bar(0, 100, 102, 100, 101, 10), 10, 1);
    expect([...h.entries()].sort()).toEqual([[100, 5], [101, 5]]);
    const h2 = new Map<number, number>();
    accumulate(h2, bar(0, 100.25, 100.25, 100.25, 100.25, 7), 7, 0.5);
    expect([...h2.entries()]).toEqual([[200, 7]]); // zero-range bar → its own row
    const h3 = new Map<number, number>();
    for (const b of m5Walk(2, { seed: 3 })) accumulate(h3, b, b.tickVolume!, 0.25);
    const total = m5Walk(2, { seed: 3 }).reduce((a, b) => a + b.tickVolume!, 0);
    expect([...h3.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(total, 6);
  });

  it('row size: a nice step of the first price × bp, never below a tick', () => {
    expect(niceStep(0.24)).toBe(0.25);
    expect(niceStep(0.0031)).toBeCloseTo(0.005, 12);
    expect(rowSize(2400, 1, 0.01)).toBeCloseTo(0.25, 12);
    expect(rowSize(31.2, 1, 0.001)).toBeCloseTo(0.005, 12);
    expect(rowSize(1, 1, 0.01)).toBe(0.01); // floor = one tick
  });

  it('dense rows include empty rows between traded prices', () => {
    const h = new Map([[100, 3], [103, 1]]);
    expect(rowsOf(h, 1).map((r) => r.volume)).toEqual([3, 0, 0, 1]);
  });
});

describe('POC and value area', () => {
  it('two-row CME expansion to 70 %, VAH / VAL at row edges, POC at row centre', () => {
    const va = valueArea(rows([1, 2, 5, 9, 4, 3, 1]), 1, 0.7)!;
    expect(va.poc).toBe(103.5);
    // 9 → tie (4+3 vs 5+2) → up = 16 → down (5+2) = 23 ≥ 17.5
    expect(va.vah).toBe(106);
    expect(va.val).toBe(101);
    expect(va.vaVolume).toBe(23);
    expect(va.total).toBe(25);
  });
  it('the value-area % is configurable', () => {
    const va = valueArea(rows([1, 2, 5, 9, 4, 3, 1]), 1, 0.5)!;
    expect([va.val, va.vah, va.vaVolume]).toEqual([103, 106, 16]);
    const all = valueArea(rows([1, 2, 5, 9, 4, 3, 1]), 1, 1)!;
    expect([all.val, all.vah, all.vaVolume]).toEqual([100, 107, 25]);
  });
  it('POC tie → the row nearest the profile middle', () => {
    expect(valueArea(rows([5, 1, 1, 1, 5, 1, 5]), 1, 0.7)!.poc).toBe(104.5);
  });
  it('empty / zero volume → no value area', () => {
    expect(valueArea([], 1, 0.7)).toBeNull();
    expect(valueArea(rows([0, 0]), 1, 0.7)).toBeNull();
  });
});

describe('HVN / LVN', () => {
  const bimodal = [1, 2, 4, 8, 12, 14, 12, 8, 4, 2, 1, 1, 2, 4, 9, 13, 16, 13, 9, 4, 2, 1];
  it('two volume peaks → two HVN, and the valley between them → one LVN', () => {
    const n = detectNodes(rows(bimodal), S);
    expect(n.filter((x) => x.type === 'HVN').map((x) => x.index)).toEqual([5, 16]);
    const lvn = n.filter((x) => x.type === 'LVN');
    expect(lvn).toHaveLength(1);
    expect(lvn[0]!.index).toBeGreaterThan(8);
    expect(lvn[0]!.index).toBeLessThan(13);
  });
  it('thin tails at the edges are not LVN; flat or noisy-flat profiles are not over-detected', () => {
    expect(detectNodes(rows([1, 1, 2, 5, 10, 15, 10, 5, 2, 1, 1]), S).filter((x) => x.type === 'LVN')).toHaveLength(0);
    expect(detectNodes(rows(Array(30).fill(10)), S)).toHaveLength(0);
    const noisy = Array.from({ length: 40 }, (_, i) => 10 + ((i * 7) % 3) * 0.3);
    expect(detectNodes(rows(noisy), S)).toHaveLength(0);
    expect(detectNodes(rows([5, 9, 5]), S)).toHaveLength(0); // too few rows
  });
});

describe('volume source labelling (never mixed, never faked)', () => {
  const mt5 = [bar(0, 1, 2, 0.5, 1.5, 10), bar(300, 1.5, 2, 1, 1.2, 12)];
  it('MT5 → "MT5 Tick Volume"; tick volume is never called exchange volume', () => {
    expect(chooseVolume(mt5, MT5).source).toMatchObject({ mode: 'MT5_TICK', label: 'MT5 Tick Volume', usedBars: 2 });
    expect(chooseVolume(mt5, FUT).source.mode).toBe('MT5_TICK'); // even for a futures instrument via MT5
  });
  it('MT5 real_volume on every bar → broker-reported real volume (not COMEX)', () => {
    const r = chooseVolume(mt5.map((b) => ({ ...b, realVolume: 5 })), MT5).source;
    expect(r.label).toBe('MT5 Real Volume (broker-reported)');
    expect(r.detail).toMatch(/not COMEX/);
  });
  it('futures feed with exchange volume → "COMEX Exchange Volume"', () => {
    const g = mt5.map((b) => ({ ...b, source: 'futures-feed', volume: 100, tickVolume: null }));
    expect(chooseVolume(g, FUT).source).toMatchObject({ mode: 'EXCHANGE', label: 'COMEX Exchange Volume' });
    expect(chooseVolume(g, MT5).source.mode).toBe('NONE'); // not a future → exchange volume not claimed
  });
  it('missing volume: bars excluded and counted; none at all → VOLUME DATA UNAVAILABLE', () => {
    expect(chooseVolume([mt5[0]!, { ...mt5[1]!, tickVolume: null }], MT5).source).toMatchObject({ mode: 'MT5_TICK', usedBars: 1, missingBars: 1 });
    expect(chooseVolume(mt5.map((b) => ({ ...b, tickVolume: null })), MT5).source).toMatchObject({ mode: 'NONE', label: 'VOLUME DATA UNAVAILABLE' });
    expect(chooseVolume([], MT5).source.mode).toBe('NONE');
  });
  it('GC without an exchange-volume provider: GC VOLUME DATA UNAVAILABLE; no synthetic profile', () => {
    const s = analyzeVolumeProfile({ instrumentId: 'GC', tickSize: 0.1, instrument: FUT, candles: {} });
    expect(s.unavailable).toBe('GC VOLUME DATA UNAVAILABLE');
    expect(Object.keys(s.profiles)).toHaveLength(0);
    const x = analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, candles: { M5: m5Walk(2, { seed: 1 }).map((b) => ({ ...b, tickVolume: null })) } });
    expect(x.unavailable).toBe('VOLUME DATA UNAVAILABLE');
    expect(x.profiles.DAILY!.rows).toEqual([]);
  });
});

describe('session / day / week windows (IANA, DST-safe)', () => {
  it('trading day starts 17:00 New York: 22:00Z in winter, 21:00Z in summer', () => {
    expect(new Date(tradingDayStart(Date.UTC(2026, 0, 13, 12) / 1000) * 1000).toISOString()).toBe('2026-01-12T22:00:00.000Z');
    expect(new Date(tradingDayStart(Date.UTC(2026, 6, 14, 12) / 1000) * 1000).toISOString()).toBe('2026-07-13T21:00:00.000Z');
    expect(new Date(tradingDayStart(Date.UTC(2026, 0, 13, 22, 30) / 1000) * 1000).toISOString()).toBe('2026-01-13T22:00:00.000Z');
    // DST switch weekend (2026-03-08): Friday 17:00 EST → next day start Sunday 17:00 EDT spans 2 days − 1 h
    const fri = tradingDayStart(Date.UTC(2026, 2, 6, 23) / 1000);
    expect(new Date(fri * 1000).toISOString()).toBe('2026-03-06T22:00:00.000Z');
    expect(new Date(nextTradingDayStart(fri) * 1000).toISOString()).toBe('2026-03-07T22:00:00.000Z');
  });
  it('weeks start Sunday 17:00 New York', () => {
    expect(new Date(weekStart(Date.UTC(2026, 0, 14, 12) / 1000) * 1000).toISOString()).toBe('2026-01-11T22:00:00.000Z');
  });
  it('current / previous session and the latest Asia / London / New York windows', () => {
    const K = Date.UTC(2026, 0, 13, 15, 0) / 1000; // 10:00 New York
    const s = sessionsAt(K);
    expect(s.current!.id).toBe('new-york');
    expect(s.previous!.id).toBe('london');
    expect(new Date(s.latest.asia!.from * 1000).toISOString()).toBe('2026-01-13T00:00:00.000Z');
    expect(new Date(s.latest.london!.from * 1000).toISOString()).toBe('2026-01-13T08:00:00.000Z');
    expect(new Date(s.latest['new-york']!.from * 1000).toISOString()).toBe('2026-01-13T13:00:00.000Z');
  });
});

describe('profiles from the engine', () => {
  const d = dataset(9, 7);
  const snap = analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, candles: d });
  it('builds every profile type with POC / VAH / VAL and the tick-volume label', () => {
    for (const k of ['DAILY', 'PREVIOUS_DAY', 'WEEKLY', 'PREVIOUS_WEEK', 'CURRENT_SESSION', 'PREVIOUS_SESSION', 'ASIA', 'LONDON', 'NEW_YORK'] as const) {
      const p = snap.profiles[k]!;
      expect(p, k).toBeDefined();
      expect(p.source.label).toBe('MT5 Tick Volume');
      if (p.bars) {
        expect(p.val!).toBeLessThanOrEqual(p.poc!);
        expect(p.vah!).toBeGreaterThanOrEqual(p.poc!);
        expect(p.vaShare).toBeGreaterThanOrEqual(0.7 - 1e-9);
      }
    }
    expect(snap.profiles.PREVIOUS_DAY!.complete).toBe(true);
    expect(snap.profiles.PREVIOUS_WEEK!.complete).toBe(true);
    expect(snap.source.label).toBe('MT5 Tick Volume');
  });
  it('previous day skips the weekend (Monday → Friday)', () => {
    // Knowledge time on Monday 2026-01-12 03:00Z → previous trading day with bars = Friday
    const K = Date.UTC(2026, 0, 12, 3, 0) / 1000;
    const ds: VPDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, settings: S, candles: d };
    const p = analyzeVPAt(ds, K).profiles.PREVIOUS_DAY!;
    expect(new Date(p.from * 1000).toISOString()).toBe('2026-01-08T22:00:00.000Z'); // Thu 17:00 NY = Friday's trading day
    expect(p.bars).toBeGreaterThan(0);
  });
  it('a window that starts before the loaded history is flagged partial', () => {
    expect(snap.profiles.PREVIOUS_WEEK!.partial || snap.profiles.PREVIOUS_WEEK!.from >= d.M30[0]!.time).toBe(true);
  });
  it('visible / fixed range profile is computed on demand over the chart timeframe', () => {
    const e = new VolumeProfileEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5 });
    e.update(d);
    const from = d.M15[100]!.time;
    const to = d.M15[200]!.time;
    const p = e.rangeProfile('M15', from, to, 'Visible range');
    expect(p.bars).toBe(100);
    expect(p.kind).toBe('RANGE');
    expect(p.poc).not.toBeNull();
  });
  it('MTF: every timeframe calculates independently from its own bars', () => {
    expect(snap.mtf.map((r) => r.timeframe)).toEqual(['D1', 'H4', 'H1', 'M30', 'M15', 'M5']);
    const other = analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, candles: { ...d, H4: dataset(9, 99, { start: 2500 }).H4 } });
    expect(other.mtf.find((r) => r.timeframe === 'H4')!.poc).not.toBe(snap.mtf.find((r) => r.timeframe === 'H4')!.poc);
    expect(other.mtf.find((r) => r.timeframe === 'H1')).toEqual(snap.mtf.find((r) => r.timeframe === 'H1'));
    expect(snap.mtf.find((r) => r.timeframe === 'D1')!.context).toBe('INSUFFICIENT DATA'); // only 9 daily bars (< 10)
  });
  it('key levels are ranked from engine output only', () => {
    expect(snap.keyLevels.length).toBeGreaterThan(0);
    const all = new Set(Object.values(snap.profiles).flatMap((p) => [p!.poc, p!.vah, p!.val]).concat(snap.nodes.map((n) => n.price)));
    for (const l of snap.keyLevels) expect(all.has(l.price)).toBe(true);
  });
});

describe('price location, acceptance / rejection', () => {
  const ref = { id: 'ref', label: 'Previous Day', kind: 'PREVIOUS_DAY', complete: true, poc: 100, vah: 104, val: 96, to: 0 } as unknown as VolumeProfile;
  const atr = 2;
  const b = (i: number, o: number, h: number, l: number, c: number) => bar(i * 900, o, h, l, c, 10);
  const acc = (bars: Candle[]) => acceptance(ref, bars, atr, S, 900)!.state;
  it('location with ATR distances', () => {
    expect(locate(105, ref, atr, S)!.location).toBe('ABOVE VALUE');
    expect(locate(95, ref, atr, S)!.location).toBe('BELOW VALUE');
    expect(locate(100.4, ref, atr, S)!.location).toBe('NEAR POC');
    expect(locate(102, ref, atr, S)!.location).toBe('UPPER VALUE');
    expect(locate(97, ref, atr, S)!.location).toBe('LOWER VALUE');
    expect(locate(102, ref, atr, S)).toMatchObject({ distPoc: 2, distPocAtr: 1, distVah: -2, distVal: 6 });
  });
  it('every state from its documented rule', () => {
    expect(acc([b(1, 103, 105, 102, 104.5), b(2, 104.5, 106, 104, 105)])).toBe('ACCEPTED ABOVE VAH');
    expect(acc([b(1, 97, 97, 94, 95), b(2, 95, 96, 93, 94)])).toBe('ACCEPTED BELOW VAL');
    expect(acc([b(1, 103, 104, 102, 103), b(2, 103, 106, 102, 105)])).toBe('BREAKING FROM VALUE');
    expect(acc([b(1, 103, 106, 102, 103.5), b(2, 103.5, 104, 102, 102.5)])).toBe('REJECTED ABOVE VAH');
    expect(acc([b(1, 97, 98, 94, 97), b(2, 97, 98, 96.5, 97.5)])).toBe('REJECTED BELOW VAL');
    expect(acc([b(1, 101, 102, 99.5, 101.5), b(2, 101.5, 102.5, 101, 102)])).toBe('POC REJECTION');
    expect(acc([b(1, 100, 101, 99, 100.2), b(2, 100.2, 101, 99, 99.8), b(3, 99.8, 100.5, 99.5, 100.1)])).toBe('POC ACCEPTANCE');
    expect(acc([98, 101.8, 97, 102.5, 97.5, 103].map((c, i) => b(i + 1, c, c + 0.5, c - 0.5, c)))).toBe('ROTATING INSIDE VALUE');
    expect(acc([b(1, 102, 102.5, 101.6, 102)])).toBe('NO CONFIRMATION');
    expect(acceptance(ref, [], atr, S, 900)!.state).toBe('NO CONFIRMATION');
    expect(acceptance(undefined, [], atr, S, 900)).toBeNull();
  });
  it('wick without close through VAH is never acceptance', () => {
    expect(acc([b(1, 103, 108, 102, 103.9), b(2, 103.9, 109, 103, 103.8)])).not.toBe('ACCEPTED ABOVE VAH');
  });
  it('profile state', () => {
    expect(profileState({ state: 'ACCEPTED ABOVE VAH' } as never)).toBe('IMBALANCED UP');
    expect(profileState({ state: 'ROTATING INSIDE VALUE' } as never)).toBe('BALANCED');
    expect(profileState(null)).toBe('NO DATA');
  });
  it('node states: TESTED, BROKEN (closes on the far side), EXPIRED', () => {
    const node = { id: 'n', type: 'HVN', low: 99, high: 101, price: 100, developing: false, validFrom: 0, confirmedAt: 0, state: 'ACTIVE', testedAt: null, brokenAt: null } as never;
    const [t] = nodeStates([node], [b(1, 103, 103, 100.5, 102)], 103, 5000, S, 900);
    expect(t!.state).toBe('TESTED');
    const [br] = nodeStates([node], [b(1, 102, 102, 98, 98.5), b(2, 98.5, 99, 97, 97.5)], 103, 5000, S, 900);
    expect(br!.state).toBe('BROKEN');
    const [ex] = nodeStates([node], [], 103, 6 * 86_400, S, 900);
    expect(ex!.state).toBe('EXPIRED');
  });
});

describe('events', () => {
  const d = dataset(6, 11);
  const s = analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, candles: d });
  it('NEW POC per trading day, POC SHIFTED (≥ 2 rows), node creation, value interactions', () => {
    const types = new Set(s.events.map((e) => e.type));
    for (const t of ['NEW POC', 'POC SHIFTED', 'HVN CREATED', 'VAH TESTED', 'VAL TESTED'] as const) expect(types.has(t), t).toBe(true);
    expect(s.events.filter((e) => e.type === 'NEW POC').length).toBeGreaterThanOrEqual(5);
    expect(new Set(s.events.map((e) => e.id)).size).toBe(s.events.length);
    for (let k = 1; k < s.events.length; k++) expect(s.events[k]!.time).toBeGreaterThanOrEqual(s.events[k - 1]!.time);
  });
});

describe('revised candles (ACCEPT + LOG), replay and anti-repaint', () => {
  const d = dataset(5, 21);
  const ds: VPDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, settings: S, candles: d };

  it('a revised closed candle is reported, the analysis rebuilt equals a clean run, no duplicates on redelivery', () => {
    const e = new VolumeProfileEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5 });
    e.update(d);
    const m5 = d.M5.map((c, i) => (i === d.M5.length - 50 ? { ...c, tickVolume: (c.tickVolume ?? 0) + 500, high: c.high + 0.5 } : c));
    const r = e.update({ ...d, M5: m5 });
    expect(r.revised).toEqual([{ tf: 'M5', time: d.M5[d.M5.length - 50]!.time }]);
    expect(JSON.stringify(e.snapshot())).toBe(JSON.stringify(analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, candles: { ...d, M5: m5 } })));
    expect(e.update({ ...d, M5: m5 })).toEqual({ rebuilt: [], revised: [] });
  });

  it('incremental candle-by-candle state == clean recomputation at every knowledge time; no leaks; completed profiles frozen', () => {
    const r = auditVolumeProfile(ds, { stride: 7 });
    expect(r.checks).toBeGreaterThan(150);
    expect(r.mismatches).toEqual([]);
    expect(r.leaks).toEqual([]);
    expect(r.mutations).toEqual([]);
  }, 120_000);

  it('no future candle affects an earlier result', () => {
    const times = vpKnowledgeTimes(ds);
    for (const K of [times[200]!, times[700]!, times[1100]!]) {
      const a = analyzeVPAt(ds, K);
      const cut: VPDataset = { ...ds, candles: vpKnownInput(ds, K) };
      expect(JSON.stringify(a)).toBe(JSON.stringify(analyzeVPAt(cut, K)));
    }
  });

  it('a LOOK-AHEAD engine (fed future candles) is detected by the parity check', () => {
    const times = vpKnowledgeTimes(ds);
    const cheat = new VolumeProfileEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5 });
    cheat.update(d); // sees everything
    let mismatches = 0;
    for (const K of [times[300]!, times[800]!]) if (JSON.stringify(cheat.snapshot()) !== JSON.stringify(analyzeVPAt(ds, K))) mismatches += 1;
    expect(mismatches).toBe(2);
  });

  it('XAGUSD-priced data works identically (instrument-independent rows)', () => {
    const ag = dataset(4, 5, { start: 31.2, vol: 0.01 });
    const s = analyzeVolumeProfile({ instrumentId: 'XAGUSD', tickSize: 0.001, instrument: MT5, candles: ag });
    const p = s.profiles.PREVIOUS_DAY!;
    expect(p.binSize).toBeCloseTo(0.005, 12);
    expect(p.poc).not.toBeNull();
    expect(p.source.label).toBe('MT5 Tick Volume');
  });
});

describe('score and confluence (read-only)', () => {
  const d = dataset(6, 11);
  const s = analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, candles: d });
  it('weights total 100; components shown separately; never a probability', () => {
    const sc = vpScore(s, [], null);
    expect(Object.keys(sc.components)).toHaveLength(9);
    expect(sc.note).toMatch(/not a probability of winning/);
    let raw = 0;
    for (const k of Object.keys(sc.components) as (keyof typeof sc.components)[]) raw += sc.components[k] * ({ htfAlignment: 15, pocSignificance: 10, valueInteraction: 15, nodeSignificance: 10, liquidity: 15, sr: 10, smc: 15, session: 5, freshness: 5 })[k] / 100;
    expect(sc.uncapped).toBe(Math.round(raw));
  });
  it('missing mandatory evidence caps the score; no data → no score', () => {
    const noAcc = vpScore({ ...s, acceptance: { ...s.acceptance!, state: 'NO CONFIRMATION' } }, [], null);
    expect(noAcc.total!).toBeLessThanOrEqual(40);
    expect(noAcc.missing).toContain('no acceptance / rejection confirmation');
    expect(vpScore(analyzeVolumeProfile({ instrumentId: 'GC', tickSize: 0.1, instrument: FUT, candles: {} }), [], null).total).toBeNull();
  });
  it('confluence names the engine that produced each object and never mutates it', () => {
    const vah = s.profiles.PREVIOUS_DAY!.vah!;
    const pool = { id: 'p', timeframe: 'M15', side: 'BSL', kind: 'EQH', level: vah + 0.01, poolState: 'ACTIVE', status: 'LIQUIDITY PRESENT', confirmedAt: 0, lastSweepAt: null, score: 70, touches: 1 };
    const smc = { byTimeframe: { M15: { dataState: 'READY', liquidity: [pool], sweeps: [], orderBlocks: [], fvgs: [], breaks: [], location: null, range: null } } } as never;
    const frozen = JSON.stringify(smc);
    const items = confluence(s, smc, null, S.confluenceAtr);
    const hit = items.find((i) => i.with.startsWith('EQH'));
    expect(hit).toMatchObject({ engine: 'Liquidity engine (via SMC)', strength: 'High' });
    expect(JSON.stringify(smc)).toBe(frozen);
    expect(confluence(s, null, null, S.confluenceAtr)).toEqual([]);
  });
});

describe('buildProfile edge cases', () => {
  it('bars after K are never used; a developing profile is incomplete', () => {
    const m5 = m5Walk(1, { seed: 2 });
    const K = m5[20]!.time + 300;
    const p = buildProfile({ instrumentId: 'X', kind: 'DAILY', label: 'd', id: 'd', resolution: 'M5', bars: m5, from: T0, to: T0 + 86_400, K, bp: 1, tick: 0.01, ctx: MT5, settings: S, datasetStart: m5[0]!.time });
    expect(p.bars).toBe(21);
    expect(p.lastBarClose).toBe(K);
    expect(p.complete).toBe(false);
    expect(p.hvn.every((n) => n.developing && n.confirmedAt === null)).toBe(true);
  });
});
