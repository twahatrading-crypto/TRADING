import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { analyzeLiquidity } from '../liquidity/engine';
import { analyzeOrderBlocks } from '../orderBlocks/engine';
import { DEFAULT_SMC_SETTINGS } from './config';
import { SmcEngine, analyzeSmc } from './engine';
import { candles, path } from './fixtures/builders';
import * as S from './fixtures/scenarios';
import { rangeLocation } from './range';
import { SmcTimeframeEngine } from './timeframe';

/* TEST DATA ONLY — synthetic candles. */

const tf = (c: readonly Candle[], price?: number) => {
  const e = new SmcTimeframeEngine({ instrumentId: 'XAUUSD', timeframe: 'M15', tickSize: 0.01 });
  e.update(c, price);
  return e.snapshot();
};
const next = (c: readonly Candle[], x: Omit<Candle, 'time' | 'volume'>): Candle[] => [...c, { ...x, time: c[c.length - 1]!.time + 900, volume: null }];

describe('market structure', () => {
  it('bullish structure: HH / HL swings, bullish BOS, state BULLISH', () => {
    const s = tf(S.bullishTrend());
    expect(s.dataState).toBe('READY');
    expect(s.state).toBe('BULLISH');
    expect(s.trend).toBe('bullish');
    const labels = s.swings.filter((w) => w.label === 'HH' || w.label === 'HL').length;
    expect(labels).toBeGreaterThanOrEqual(6);
    expect(s.lastHigh!.label).toBe('HH');
    expect(s.lastLow!.label).toBe('HL');
    const bos = s.breaks.filter((b) => b.kind === 'BOS' && b.direction === 'bullish');
    expect(bos.length).toBeGreaterThanOrEqual(3);
    expect(s.breaks.some((b) => b.kind === 'CHOCH')).toBe(false);
  });

  it('bearish structure: LH / LL swings, bearish BOS, state BEARISH', () => {
    const s = tf(S.bearishTrend());
    expect(s.state).toBe('BEARISH');
    expect(s.lastHigh!.label).toBe('LH');
    expect(s.lastLow!.label).toBe('LL');
    expect(s.breaks.filter((b) => b.kind === 'BOS' && b.direction === 'bearish').length).toBeGreaterThanOrEqual(3);
  });

  it('range: no sustained break → RANGING with EQH / EQL swings', () => {
    const s = tf(S.range());
    expect(s.state).toBe('RANGING');
    expect(s.stateEvidence).toMatch(/No structural break/);
    expect(s.swings.some((w) => w.label === 'EQH')).toBe(true);
    expect(s.swings.some((w) => w.label === 'EQL')).toBe(true);
  });

  it('UNDEFINED before two swing highs and lows / before any break', () => {
    const s = tf(candles(path(100, [100.5, 20])));
    expect(s.state).toBe('UNDEFINED');
  });

  it('swings are causal: confirmed only after swingRight bars have closed', () => {
    const c = S.bullishTrend();
    const full = tf(c);
    const sw = full.swings.find((w) => w.label === 'HH')!;
    const R = DEFAULT_SMC_SETTINGS.swingRight;
    expect(sw.confirmedIndex).toBe(sw.originIndex + R);
    expect(sw.validFrom).toBe(sw.confirmedAt + 900);
    expect(tf(c.slice(0, sw.originIndex + R)).swings.some((w) => w.id === sw.id)).toBe(false);
    expect(tf(c.slice(0, sw.originIndex + R + 1)).swings.some((w) => w.id === sw.id)).toBe(true);
  });

  it('every structure object carries instrument, timeframe, price, originTime, confirmedAt, validFrom, state, evidence', () => {
    const s = tf(S.bullishTrend());
    for (const w of s.swings) {
      expect(w).toMatchObject({ instrumentId: 'XAUUSD', timeframe: 'M15' });
      expect(w.originTime).toBeLessThanOrEqual(w.confirmedAt);
      expect(w.validFrom).toBe(w.confirmedAt + 900);
      expect(['ACTIVE', 'BROKEN']).toContain(w.state);
      expect(w.evidence.length).toBeGreaterThan(10);
    }
  });
});

describe('BOS / CHOCH', () => {
  it('bullish BOS stores the broken swing, break candle, close, distance, ATR-normalised break', () => {
    const s = tf(S.bullishTrend());
    const b = s.breaks.filter((x) => !x.initial)[0]!;
    const sw = s.swings.find((w) => w.id === b.swingId)!;
    expect(b.level).toBe(sw.price);
    expect(b.close).toBeGreaterThan(b.level);
    expect(b.breakDistance).toBeCloseTo(b.close - b.level, 10);
    expect(b.breakAtr).toBeGreaterThanOrEqual(DEFAULT_SMC_SETTINGS.breakMinAtr);
    expect(b.validFrom).toBe(b.confirmedAt + 900);
    expect(sw.state).toBe('BROKEN');
    expect(sw.brokenAt).toBe(b.confirmedAt);
    expect(b.evidence).toMatch(/close .* above/);
  });

  it('the first break of the history is an initial BOS (never a CHOCH)', () => {
    const s = tf(S.bullishTrend());
    expect(s.breaks[0]!.initial).toBe(true);
    expect(s.breaks[0]!.kind).toBe('BOS');
  });

  it('bullish CHOCH: a close through the last LH against an established bearish trend', () => {
    const s = tf(S.bullishReversal());
    const ch = s.breaks.find((b) => b.kind === 'CHOCH')!;
    expect(ch.direction).toBe('bullish');
    expect(ch.prevState).toBe('BEARISH');
    expect(ch.swingLabel).toBe('LH');
    expect(ch.level).toBeCloseTo(92.3, 5);
    expect(s.breaks.filter((b) => b.kind === 'CHOCH')).toHaveLength(1);
    // Followed by a bullish BOS in the new direction.
    expect(s.breaks.some((b) => b.kind === 'BOS' && b.direction === 'bullish' && b.confirmedAt > ch.confirmedAt)).toBe(true);
    expect(s.state).toBe('BULLISH');
  });

  it('bearish CHOCH (mirror)', () => {
    const s = tf(S.bearishReversal());
    const ch = s.breaks.find((b) => b.kind === 'CHOCH')!;
    expect(ch.direction).toBe('bearish');
    expect(ch.prevState).toBe('BULLISH');
    expect(ch.swingLabel).toBe('HL');
    expect(s.state).toBe('BEARISH');
  });

  it('a wick through the swing without a close is NOT a break', () => {
    const c = S.bullishTrend();
    const s0 = tf(c);
    const ref = s0.refHigh!;
    const last = c[c.length - 1]!;
    const wick = next(c, { open: last.close, high: ref.price + 2, low: last.close - 0.2, close: ref.price - 0.05 });
    const s1 = tf(wick);
    expect(s1.breaks).toHaveLength(s0.breaks.length);
    expect(s1.refHigh!.id).toBe(ref.id);
    const close = next(wick, { open: ref.price - 0.05, high: ref.price + 1.2, low: ref.price - 0.1, close: ref.price + 1 });
    const s2 = tf(close);
    expect(s2.breaks).toHaveLength(s0.breaks.length + 1);
    expect(s2.breaks[s2.breaks.length - 1]!.swingId).toBe(ref.id);
  });

  it('history is not rewritten: earlier breaks are identical after more candles', () => {
    const c = S.bullishReversal();
    const early = tf(c.slice(0, 100));
    const late = tf(c);
    for (const b of early.breaks) expect(late.breaks.find((x) => x.id === b.id)).toEqual(b);
  });
});

describe('displacement', () => {
  const setup = () => {
    const c = S.bullishTrend();
    const last = c[c.length - 1]!;
    // A small bearish bar resets any bullish run so the next bar is judged alone.
    const base = next(c, { open: last.close, high: last.close + 0.05, low: last.close - 0.45, close: last.close - 0.4 });
    const ap = tf(base).atr!;
    return { base, ap, o: base[base.length - 1]!.close };
  };

  it('threshold boundary: body just above 1.0 ATR (≥ 60% of range) qualifies; just below does not', () => {
    const { base, ap, o } = setup();
    const bar = (k: number) => ({ open: o, close: o + ap * k, high: o + ap * k + ap * k * 0.1, low: o - ap * k * 0.1 });
    const above = tf(next(base, bar(1.001)));
    const below = tf(next(base, bar(0.999)));
    const nb = tf(base).displacements.length;
    expect(above.displacements).toHaveLength(nb + 1);
    const d = above.displacements[above.displacements.length - 1]!;
    expect(d).toMatchObject({ direction: 'bullish', rule: 'single', bars: 1 });
    expect(d.maxBodyAtr).toBeGreaterThanOrEqual(1);
    expect(d.maxBodyPct).toBeGreaterThanOrEqual(0.6);
    expect(below.displacements).toHaveLength(nb);
  });

  it('a large bar with a small body share is not displacement (wick-dominated)', () => {
    const { base, ap, o } = setup();
    const s = tf(next(base, { open: o, close: o + ap * 1.2, high: o + ap * 2.5, low: o - ap * 0.5 }));
    expect(s.displacements).toHaveLength(tf(base).displacements.length);
  });

  it('run rule: ≥ 3 consecutive directional closes with net ≥ 2 ATR', () => {
    const s = tf(S.bullishTrend());
    const run = s.displacements.find((d) => d.rule === 'run')!;
    expect(run.bars).toBeGreaterThanOrEqual(3);
    expect(run.netMoveAtr).toBeGreaterThanOrEqual(2);
    expect(run.minBodyPct).toBeGreaterThanOrEqual(0.5);
    expect(run.evidence).toMatch(/consecutive/);
  });

  it('breaks record the displacement that drove them', () => {
    const s = tf(S.bullishReversal());
    const ch = s.breaks.find((b) => b.kind === 'CHOCH')!;
    expect(ch.displacementId).not.toBeNull();
    expect(s.displacements.find((d) => d.id === ch.displacementId)!.breakId).toBe(ch.id);
  });
});

describe('FVG', () => {
  const base = () => candles(path(100, ...S.warm()));
  const add = (c: Candle[], ...xs: [number, number, number, number][]) => xs.reduce((acc, [o, h, l, cl]) => next(acc, { open: o, high: h, low: l, close: cl }), c);
  const bull = () => add(base(), [100, 100.5, 99.8, 100.2], [100.2, 103, 100.1, 102.8], [102.8, 104, 101.5, 103.5]);

  it('bullish FVG: low of candle 3 above high of candle 1, frozen bounds', () => {
    const s = tf(bull());
    const f = s.fvgs[s.fvgs.length - 1]!;
    expect(f).toMatchObject({ direction: 'bullish', lower: 100.5, upper: 101.5, state: 'FRESH', fillPct: 0 });
    expect(f.mid).toBeCloseTo(101, 10);
    expect(f.size).toBeCloseTo(1, 10);
    expect(f.sizeAtr).toBeGreaterThan(0);
    const later = tf(add(bull(), [103.5, 106, 103.4, 105.8], [105.8, 107, 105.5, 106.9]));
    const g = later.fvgs.find((x) => x.id === f.id)!;
    expect([g.upper, g.lower, g.mid, g.size, g.confirmedAt]).toEqual([f.upper, f.lower, f.mid, f.size, f.confirmedAt]);
  });

  it('bearish FVG: high of candle 3 below low of candle 1', () => {
    const c = add(base(), [100, 100.2, 99.5, 99.8], [99.8, 99.9, 97, 97.2], [97.2, 98.5, 96, 96.5]);
    const f = tf(c).fvgs.at(-1)!;
    expect(f).toMatchObject({ direction: 'bearish', lower: 98.5, upper: 99.5 });
  });

  it('partial fill then full fill (wick), never moving the boundaries', () => {
    const p = tf(add(bull(), [103.5, 103.6, 101.2, 102]));
    const f = p.fvgs.at(-1)!;
    expect(f.state).toBe('PARTIALLY_FILLED');
    expect(f.fillPct).toBeCloseTo(30, 5);
    expect(p.events.some((e) => e.type === 'FVG PARTIALLY FILLED' && e.id.endsWith(f.id))).toBe(true);
    const full = tf(add(bull(), [103.5, 103.6, 101.2, 102], [102, 102.1, 100.4, 101]));
    const g = full.fvgs.find((x) => x.id === f.id)!;
    expect(g.state).toBe('FILLED');
    expect(g.fillPct).toBe(100);
    expect(g.filledAt).not.toBeNull();
    expect([g.upper, g.lower]).toEqual([101.5, 100.5]);
  });

  it('a close beyond the far edge invalidates it', () => {
    const s = tf(add(bull(), [103.5, 103.6, 100, 100.2]));
    expect(s.fvgs.at(-1)!.state).toBe('INVALIDATED');
  });

  it('gaps below the minimum size are ignored', () => {
    const c = add(base(), [100, 100.5, 99.8, 100.2], [100.2, 101, 100.1, 100.9], [100.9, 101.2, 100.51, 101]);
    expect(tf(c).fvgs.filter((f) => f.lower === 100.5)).toHaveLength(0);
  });
});

describe('liquidity, order blocks (read-only reuse)', () => {
  it('OB adapter maps the Order Block engine output 1:1 (same ids, bounds, states)', () => {
    const c = S.bullishReversal();
    const s = tf(c);
    const ob = analyzeOrderBlocks({ instrumentId: 'XAUUSD', timeframe: 'M15', tickSize: 0.01, candles: c, lastBarClosed: true, currentPrice: c.at(-1)!.close });
    expect(s.orderBlocks.map((b) => [b.id, b.low, b.high, b.state, b.score])).toEqual(ob.blocks.map((b) => [b.id, b.low, b.high, b.state, b.score.total]));
    expect(s.orderBlocks.length).toBeGreaterThan(0);
  });

  it('liquidity adapter maps the Liquidity engine pools; FORMING / INVALIDATED are not liquidity', () => {
    const c = S.bullishReversal();
    const s = tf(c);
    const lq = analyzeLiquidity({ instrumentId: 'XAUUSD', timeframe: 'M15', tickSize: 0.01, candles: c, lastBarClosed: true, currentPrice: c.at(-1)!.close });
    const expected = lq.pools.filter((p) => p.state !== 'FORMING' && p.state !== 'INVALIDATED').map((p) => p.id);
    expect(s.liquidity.map((p) => p.id)).toEqual(expected);
    for (const p of s.liquidity) expect(['LIQUIDITY PRESENT', 'LIQUIDITY SWEPT', 'LIQUIDITY CONSUMED']).toContain(p.status);
  });

  it('liquidity sweep ≠ structural reversal: reversal only when the first break after the sweep is a CHOCH against the swept side', () => {
    const s = tf(S.bullishReversal());
    expect(s.sweeps.length).toBeGreaterThan(0);
    const ch = s.breaks.find((b) => b.kind === 'CHOCH')!;
    for (const w of s.sweeps) {
      if (!w.reversalBreakId) continue;
      expect(w.reversalBreakId).toBe(ch.id);
      expect(w.side).toBe('SSL');
      const first = s.breaks.find((b) => b.confirmedAt >= w.time)!;
      expect(first.id).toBe(ch.id);
    }
    expect(s.sweeps.some((w) => !w.reversalBreakId)).toBe(true);
  });
});

describe('dealing range, premium / discount, inducement', () => {
  it('valid dealing range from the last break; location PREMIUM above 52.5 %, DISCOUNT below 47.5 %', () => {
    const c = S.bullishTrend();
    const s = tf(c);
    expect(s.range!.state).toBe('VALID');
    expect(s.rangeUnavailable).toBeNull();
    expect(s.range!.high).toBeGreaterThan(s.range!.low);
    expect(s.range!.eq).toBeCloseTo((s.range!.high + s.range!.low) / 2, 10);
    expect(s.location!.zone).toBe('PREMIUM');
    const lowPrice = s.range!.low + (s.range!.high - s.range!.low) * 0.2;
    expect(tf(c, lowPrice).location!.zone).toBe('DISCOUNT');
    const mid = s.range!.eq;
    expect(tf(c, mid).location!.zone).toBe('EQUILIBRIUM');
  });

  it('rangeLocation boundaries', () => {
    const r = { high: 110, low: 100 };
    const z = (p: number) => rangeLocation(r, p, { eqBandPct: 5 }).zone;
    expect(z(105)).toBe('EQUILIBRIUM');
    expect(z(105.25)).toBe('EQUILIBRIUM');
    expect(z(105.3)).toBe('PREMIUM');
    expect(z(104.7)).toBe('DISCOUNT');
    expect(z(111)).toBe('ABOVE_RANGE');
    expect(z(99)).toBe('BELOW_RANGE');
  });

  it('no dealing range is invented before a structural break', () => {
    const s = tf(candles(path(100, ...S.warm().slice(0, 8))));
    expect(s.range).toBeNull();
    expect(s.location).toBeNull();
    expect(s.rangeUnavailable).toMatch(/DEALING RANGE UNAVAILABLE/);
  });

  it('a close through the range extreme invalidates it (unavailable until the next break)', () => {
    const c = S.bullishTrend();
    const s0 = tf(c);
    const last = c.at(-1)!;
    const s1 = tf(next(c, { open: last.close, high: last.close, low: s0.range!.low - 1, close: s0.range!.low - 0.5 }));
    const r = s1.range!;
    if (r.id === s0.range!.id) {
      expect(r.state).toBe('INVALIDATED');
      expect(s1.location).toBeNull();
    } else expect(r.direction).toBe('bearish'); // the same close was also a CHOCH → new range
  });

  it('inducement candidate: first internal swing after the break, TAKEN only with the range intact', () => {
    const s = tf(S.bullishReversal());
    const taken = s.inducements.filter((x) => x.state === 'TAKEN');
    expect(taken.length).toBeGreaterThan(0);
    for (const x of taken) {
      expect(x.takenAt).not.toBeNull();
      expect(x.penetrationAtr).toBeGreaterThan(0);
      expect(x.evidence).toMatch(/first swing .* inside the .* dealing range/);
      expect(s.events.some((e) => e.type === 'INDUCEMENT CANDIDATE' && e.id.endsWith(x.id))).toBe(true);
    }
    // Every inducement belongs to a dealing range; one per range.
    const perRange = new Map<string, number>();
    for (const x of s.inducements) perRange.set(x.rangeId, (perRange.get(x.rangeId) ?? 0) + 1);
    expect([...perRange.values()].every((n) => n === 1)).toBe(true);
    expect(tf(S.range()).inducements.filter((x) => x.state === 'TAKEN')).toHaveLength(0);
  });
});

describe('sequence, events, data', () => {
  it('bullish sequence after a reversal: sweep, displacement, CHOCH and BOS confirmed', () => {
    const q = tf(S.bullishReversal()).sequences.bullish;
    const st = Object.fromEntries(q.stages.map((x) => [x.key, x.state]));
    expect(st).toMatchObject({ liquidity: 'CONFIRMED', sweep: 'CONFIRMED', displacement: 'CONFIRMED', choch: 'CONFIRMED', bos: 'CONFIRMED' });
    expect(q.confirmed).toBeGreaterThanOrEqual(5);
    for (const x of q.stages) if (x.state === 'CONFIRMED') expect(x.evidence && x.time).toBeTruthy();
    const t = (k: string) => q.stages.find((x) => x.key === k)!.time!;
    expect(t('sweep')).toBeLessThanOrEqual(t('displacement'));
    expect(t('displacement')).toBeLessThanOrEqual(t('choch'));
    expect(t('choch')).toBeLessThan(t('bos'));
    expect(q.stages.find((x) => x.key === 'sweep')!.evidence).not.toMatch(/accepted/);
  });

  it('unconfirmed stages stay WAITING (bullish trend has no bullish CHOCH)', () => {
    const q = tf(S.bullishTrend()).sequences.bullish;
    expect(q.stages.find((x) => x.key === 'choch')!.state).toBe('WAITING');
    expect(q.stages.find((x) => x.key === 'choch')!.evidence).toBeNull();
  });

  it('events are unique, time-ordered and never before their object is knowable', () => {
    const s = tf(S.bullishReversal());
    expect(new Set(s.events.map((e) => e.id)).size).toBe(s.events.length);
    for (let k = 1; k < s.events.length; k++) expect(s.events[k]!.time).toBeGreaterThanOrEqual(s.events[k - 1]!.time);
    for (const e of s.events) expect(e.time).toBeLessThanOrEqual(s.knowledgeTime!);
    const types = new Set(s.events.map((e) => e.type));
    for (const t of ['SWING CONFIRMED', 'STRUCTURE CHANGED', 'BOS CONFIRMED', 'CHOCH CONFIRMED', 'DISPLACEMENT', 'FVG CREATED', 'LIQUIDITY SWEPT', 'DEALING RANGE CHANGED'] as const) expect(types.has(t)).toBe(true);
  });

  it('insufficient bars → INSUFFICIENT_DATA; none → NO_DATA', () => {
    expect(tf(candles(path(100, [101, 30]))).dataState).toBe('INSUFFICIENT_DATA');
    expect(tf([]).dataState).toBe('NO_DATA');
  });

  it('duplicate / out-of-order candles are rejected, never processed', () => {
    const c = S.bullishTrend();
    const s = tf([...c.slice(0, 80), c[79]!, c[10]!, ...c.slice(80)]);
    expect(s.rejectedBars).toBe(2);
    expect(JSON.stringify({ ...s, rejectedBars: 0 })).toBe(JSON.stringify({ ...tf(c), rejectedBars: 0 }));
  });
});

describe('revised candles (ACCEPT + LOG)', () => {
  it('a revised closed candle is detected, rebuilt deterministically and reported once', () => {
    const c = S.bullishReversal();
    const e = new SmcEngine({ instrumentId: 'XAUUSD', tickSize: 0.01 });
    expect(e.update({ M15: c }).revised).toEqual([]);
    const rev = c.map((x, i) => (i === 95 ? { ...x, close: x.close + 0.4, high: Math.max(x.high, x.close + 0.4) } : x));
    const r = e.update({ M15: rev });
    expect(r.revised).toEqual([{ tf: 'M15', time: c[95]!.time }]);
    expect(r.rebuilt).toEqual(['M15']);
    expect(JSON.stringify(e.snapshot())).toBe(JSON.stringify(analyzeSmc({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: { M15: rev } })));
    // Same data again: nothing revised, nothing rebuilt (no duplicate DATA REVISED).
    expect(e.update({ M15: rev })).toEqual({ rebuilt: [], revised: [] });
  });
});
