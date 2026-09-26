import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../../types/market';
import { SMC_SCORE_CAP_MISSING, SMC_SCORE_WEIGHTS, SMC_TIMEFRAMES } from './config';
import { analyzeSmc, type SmcInput } from './engine';
import { candles, path } from './fixtures/builders';
import * as S from './fixtures/scenarios';

/* TEST DATA ONLY. Each timeframe gets its own synthetic series (spaced at that timeframe) — the engine
 * analyses every timeframe independently, so the series need not be consistent with each other. */

type Shape = 'bull' | 'bear' | 'range' | 'rev';
const closesOf = (c: readonly Candle[]) => c.map((x) => x.close);
const SHAPES: Record<Shape, () => Candle[]> = { bull: S.bullishTrend, bear: S.bearishTrend, range: S.range, rev: S.bullishReversal };
const at = (shape: Shape, tf: Timeframe): Candle[] => {
  const src = SHAPES[shape]();
  const ov: Record<number, Partial<Candle>> = {};
  src.forEach((x, i) => (ov[i] = { high: x.high, low: x.low, open: x.open }));
  return candles(closesOf(src), { tf, ov });
};
const input = (m: Partial<Record<Timeframe, Shape>>): SmcInput => Object.fromEntries(Object.entries(m).map(([tf, sh]) => [tf, at(sh!, tf as Timeframe)]));
const run = (m: Partial<Record<Timeframe, Shape>>, feed: 'LIVE' | 'STALE' | 'DISCONNECTED' = 'LIVE') => analyzeSmc({ instrumentId: 'XAGUSD', tickSize: 0.001, candles: input(m), feed });
const all = (sh: Shape): Partial<Record<Timeframe, Shape>> => Object.fromEntries(SMC_TIMEFRAMES.map((tf) => [tf, sh]));

describe('MTF aggregation (no majority voting)', () => {
  it('every timeframe is analysed independently from its own candles', () => {
    const s = run({ ...all('bull'), M15: 'bear' });
    expect(s.byTimeframe.H1!.state).toBe('BULLISH');
    expect(s.byTimeframe.M15!.state).toBe('BEARISH');
  });

  it('BULLISH ALIGNMENT when H4, H1, M15 are bullish and D1 / M5 do not oppose', () => {
    const s = run(all('bull'));
    expect(s.summary.verdict).toBe('BULLISH ALIGNMENT');
    expect(s.summary.bias).toBe('bullish');
    expect(s.summary.conflicts.filter((c) => c.severity === 'conflict')).toHaveLength(0);
  });

  it('BEARISH ALIGNMENT (mirror)', () => {
    expect(run(all('bear')).summary.verdict).toBe('BEARISH ALIGNMENT');
  });

  it('conflict is reported, not hidden: H4 + H1 bearish, M15 bullish CHOCH, M5 bullish', () => {
    const s = run({ D1: 'bear', H4: 'bear', H1: 'bear', M30: 'bear', M15: 'rev', M5: 'bull', M1: 'bull' });
    expect(s.summary.verdict).toBe('MIXED');
    const text = s.summary.conflicts.map((c) => c.text).join('\n');
    expect(text).toMatch(/M30 BEARISH vs M15 BULLISH/);
    expect(text).toMatch(/M15 bullish CHOCH against H4 BEARISH/);
  });

  it('a single opposing low timeframe cannot be outvoted: D1 against the core → WAIT, not alignment', () => {
    const s = run({ ...all('bull'), D1: 'bear' });
    expect(s.summary.verdict).toBe('WAIT');
    expect(s.summary.conflicts.some((c) => c.text.includes('D1 BEARISH vs H4 BULLISH'))).toBe(true);
  });

  it('WAIT when H4 and H1 agree but M15 has not confirmed', () => {
    const s = run({ ...all('bull'), M15: 'range' });
    expect(s.summary.verdict).toBe('WAIT');
    expect(s.summary.reason).toMatch(/M15 has not confirmed/);
  });

  it('NEUTRAL when nothing is directional', () => {
    expect(run(all('range')).summary.verdict).toBe('NEUTRAL');
  });

  it('INSUFFICIENT DATA when a core timeframe is missing; DATA STALE on a stale feed; DATA UNAVAILABLE without data', () => {
    const { H1: _h1, ...noH1 } = all('bull');
    void _h1;
    const s = run(noH1);
    expect(s.summary.verdict).toBe('INSUFFICIENT DATA');
    expect(s.summary.reason).toMatch(/H1/);
    expect(s.score.total).toBeNull();
    expect(run(all('bull'), 'STALE').summary.verdict).toBe('DATA STALE');
    expect(run({}, 'DISCONNECTED').summary.verdict).toBe('DATA UNAVAILABLE');
  });

  it('matrix has one row per timeframe (D1 → M1) with the documented columns', () => {
    const s = run(all('rev'));
    expect(s.matrix.map((r) => r.timeframe)).toEqual(['D1', 'H4', 'H1', 'M30', 'M15', 'M5', 'M1']);
    const r = s.matrix.find((x) => x.timeframe === 'M15')!;
    expect(r.state).toBe('BULLISH');
    expect(r.choch).toMatch(/^Bullish/);
    expect(r.sweep).toMatch(/SSL .* → reversal|SSL|BSL/);
    for (const k of ['lastSwing', 'liquidity', 'sweep', 'bos', 'choch', 'displacement', 'ob', 'fvg', 'premiumDiscount'] as const) expect(typeof r[k]).toBe('string');
  });
});

describe('SMC confluence score', () => {
  it('weights total exactly 100', () => {
    expect(Object.values(SMC_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('is Σ weight × component / 100, with evidence per component, and never claims probability', () => {
    const s = run(all('rev'));
    const sc = s.score;
    expect(sc.total).not.toBeNull();
    let raw = 0;
    for (const [k, w] of Object.entries(SMC_SCORE_WEIGHTS)) raw += (w * sc.components[k as keyof typeof SMC_SCORE_WEIGHTS]) / 100;
    expect(sc.uncapped).toBe(Math.round(raw));
    for (const v of Object.values(sc.components)) expect(v >= 0 && v <= 100).toBe(true);
    expect(sc.note).toMatch(/not a probability of winning/);
    expect(sc.direction).toBe('bullish');
  });

  it('missing mandatory structural evidence caps the score (a high score cannot hide it)', () => {
    const s = run({ ...all('bull'), H4: 'range', H1: 'range' });
    expect(s.score.missing.length).toBeGreaterThan(0);
    expect(s.score.total!).toBeLessThanOrEqual(SMC_SCORE_CAP_MISSING);
    expect(s.score.note).toMatch(/Capped/);
  });

  it('aligned structure scores higher than conflicting structure', () => {
    const aligned = run(all('rev')).score.total!;
    const conflicted = run({ ...all('bear'), M15: 'rev', M5: 'bull' }).score.total!;
    expect(aligned).toBeGreaterThan(conflicted);
  });
});

describe('instrument independence', () => {
  it('same shapes on XAUUSD- and XAGUSD-like prices give the same structure (ATR-relative rules)', () => {
    const scale = (c: Candle[], k: number) => c.map((x) => ({ ...x, open: x.open * k, high: x.high * k, low: x.low * k, close: x.close * k }));
    const gold = analyzeSmc({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: { M15: scale(S.bullishReversal(), 40) } }).byTimeframe.M15!;
    const silver = analyzeSmc({ instrumentId: 'XAGUSD', tickSize: 0.001, candles: { M15: scale(S.bullishReversal(), 0.3) } }).byTimeframe.M15!;
    expect(silver.state).toBe(gold.state);
    expect(silver.breaks.map((b) => [b.kind, b.direction])).toEqual(gold.breaks.map((b) => [b.kind, b.direction]));
    expect(silver.swings.map((w) => w.label)).toEqual(gold.swings.map((w) => w.label));
    expect(silver.instrumentId).toBe('XAGUSD');
  });

  it('flat path never produces structure', () => {
    const s = analyzeSmc({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: { M15: candles(path(100, [100, 120]), { w: 0 }) } }).byTimeframe.M15!;
    expect(s.swings).toHaveLength(0);
    expect(s.breaks).toHaveLength(0);
    expect(s.fvgs).toHaveLength(0);
  });
});
