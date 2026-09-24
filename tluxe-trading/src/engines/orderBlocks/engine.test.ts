/**
 * Order Block Engine v1 — rule tests on deterministic TEST-ONLY scenarios.
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { DEFAULT_OB_SETTINGS, OB_SCORE_WEIGHTS, type OBSettings } from './config';
import { analyzeOrderBlocks, OrderBlockTimeframeEngine } from './engine';
import * as F from './fixtures/scenarios';
import type { OrderBlock } from './types';

const S = { ...DEFAULT_OB_SETTINGS };
const run = (candles: readonly Candle[], settings: OBSettings = S) => analyzeOrderBlocks({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: 0.01, settings, candles, lastBarClosed: true });
const bull = (c: readonly Candle[], s?: OBSettings) => run(c, s).blocks.find((b) => b.type === 'bullish' && b.low > 80 && b.high < 100) as OrderBlock;
const bear = (c: readonly Candle[]) => run(c).blocks.find((b) => b.type === 'bearish' && b.low > 200 && b.high < 220) as OrderBlock;

describe('detection', () => {
  it('clean bullish OB: displacement closes through a confirmed swing high (CHOCH); origin = last bearish candle; wickBody bounds', () => {
    const c = F.cleanBullish();
    const b = bull(c);
    const o = c[F.ORIGIN()]!;
    expect(b).toMatchObject({ type: 'bullish', low: 86, high: 88, originTime: o.time, originCandles: 1, breakKind: 'CHOCH', brokenLevel: 95.5, boundaryMode: 'wickBody' });
    expect(o.close).toBeLessThan(o.open);
    expect(b.low).toBe(o.low);
    expect(b.high).toBe(Math.max(o.open, o.close));
    expect(b.displacement.legAtr).toBeGreaterThanOrEqual(S.minLegAtr);
    expect(b.displacement.maxBodyAtr).toBeGreaterThanOrEqual(S.minBodyAtr);
    expect(b.breakDistance).toBeCloseTo(97.5 - 95.5, 10);
    expect(b.confirmedAt).toBe(c[F.ORIGIN() + 3]!.time);
    expect(b.id).toBe(`XAUUSD:H1:OB:BULL:${o.time}`);
  });

  it('clean bearish OB is the exact mirror', () => {
    const b = bear(F.cleanBearish());
    expect(b).toMatchObject({ type: 'bearish', low: 212, high: 214, breakKind: 'CHOCH', brokenLevel: 204.5 });
  });

  it('bullish / bearish displacement without a BOS → no break, no block', () => {
    expect(run(F.bullDisplacementNoBOS()).blocks.filter((b) => b.low > 80 && b.high < 100)).toEqual([]);
    expect(run(F.bearDisplacementNoBOS()).blocks.filter((b) => b.low > 200 && b.high < 220)).toEqual([]);
  });

  it('weak move: structure breaks, but without displacement → no block (reason recorded)', () => {
    const snap = run(F.weakMove());
    const brk = snap.breaks.find((b) => b.direction === 'up' && b.index > F.ORIGIN())!;
    expect(brk.orderBlockId).toBeNull();
    expect(brk.noBlockReason).toMatch(/insufficient displacement/);
    expect(snap.blocks.filter((b) => b.low > 80 && b.high < 100)).toEqual([]);
  });

  it('multiple candidate origins: single mode = last bearish candle; cluster mode = the whole run', () => {
    const c = F.multipleOrigins();
    expect(bull(c)).toMatchObject({ low: 86, high: 87.2, originCandles: 1 });
    expect(bull(c, { ...S, originMode: 'cluster' })).toMatchObject({ low: 86, high: 88, originCandles: 2 });
  });

  it('fullRange boundary mode uses the whole origin candle', () => {
    expect(bull(F.cleanBullish(), { ...S, boundaryMode: 'fullRange' })).toMatchObject({ low: 86, high: 88.5, boundaryMode: 'fullRange' });
  });

  it('BOS vs CHOCH: a break with the trend is BOS, against it CHOCH; a wick alone never breaks', () => {
    const snap = run(F.cleanBullish());
    const ups = snap.breaks.filter((b) => b.index > F.ORIGIN());
    expect(ups[0]!.kind).toBe('CHOCH');
    expect(ups[1]!.kind).toBe('BOS');
    for (const b of snap.breaks) {
      const c = F.cleanBullish()[b.index]!;
      expect(b.direction === 'up' ? c.close > b.level : c.close < b.level).toBe(true);
    }
  });
});

describe('lifecycle', () => {
  it('FRESH → ACTIVE when untouched longer than freshBars', () => {
    const b = bull(F.cleanBullish());
    expect(b.stateHistory.map((h) => h.to)).toEqual(['FRESH', 'ACTIVE']);
    expect(b.tests).toEqual([]);
  });
  it('retest (20 %) and partial mitigation (30 %) → TESTED with mitigation %', () => {
    expect(bull(F.retest())).toMatchObject({ state: 'TESTED', mitigationPct: 20, mitigatedAt: null });
    const p = bull(F.partialMitigation());
    expect(p).toMatchObject({ state: 'TESTED', mitigationPct: 30 });
    expect(p.tests).toHaveLength(1);
    expect(p.firstTestAt).toBe(p.lastTestAt);
  });
  it('full mitigation (70 % ≥ 50 %) → MITIGATED; still valid (not invalidated)', () => {
    const b = bull(F.fullMitigation());
    expect(b).toMatchObject({ state: 'MITIGATED', mitigationPct: 70, invalidatedAt: null });
    expect(b.mitigatedAt).toBe(b.firstTestAt);
  });
  it('invalidation: a CLOSE below the zone low → INVALIDATED; the same bar’s test is still recorded', () => {
    const b = bull(F.invalidation());
    expect(b.state).toBe('INVALIDATED');
    expect(b.invalidatedAt).toBe(b.firstTestAt);
    expect(b.tests).toHaveLength(1);
  });
  it('same-bar edge: a wick through the entire zone that closes inside → MITIGATED 100 %, NOT invalidated', () => {
    expect(bull(F.wickThroughCloseInside())).toMatchObject({ state: 'MITIGATED', mitigationPct: 100, invalidatedAt: null });
  });
  it('expiry (when enabled) ends a block; disabled keeps it', () => {
    expect(bull(F.cleanBullish(), { ...S, expiryBars: 10 }).state).toBe('EXPIRED');
    expect(bull(F.cleanBullish(), { ...S, expiryBars: 0 }).state).toBe('ACTIVE');
  });
});

describe('data integrity', () => {
  it('gap: reported, not filled; detection continues', () => {
    const c = F.cleanBullish();
    const g = [...c.slice(0, 40), ...c.slice(40).map((b) => ({ ...b, time: b.time + 30 * 3600 }))];
    const snap = run(g);
    expect(snap.gaps[0]).toMatchObject({ missingBars: 30 });
    expect(snap.blocks.some((b) => b.low === 86 && b.high === 88)).toBe(true);
  });
  it('duplicate timestamps are rejected (counted) and do not change the result', () => {
    const c = F.cleanBullish();
    const dup = [...c.slice(0, 70), { ...c[69]! }, { ...c[69]!, close: 1 }, ...c.slice(70)];
    const a = run(dup);
    expect(a.rejectedBars).toBe(2);
    expect(JSON.stringify(a.blocks)).toBe(JSON.stringify(run(c).blocks));
  });
  it('out-of-order history is rejected (never goes backwards)', () => {
    const c = F.cleanBullish();
    const ooo = [...c.slice(0, 60), { ...c[30]! }, ...c.slice(60)];
    expect(run(ooo).rejectedBars).toBe(1);
    expect(JSON.stringify(run(ooo).blocks)).toBe(JSON.stringify(run(c).blocks));
  });
  it('forming candle exclusion: the forming bar cannot confirm a break/block, test or invalidate', () => {
    const c = F.cleanBullish();
    const cut = F.ORIGIN() + 3; // the break bar
    const e = new OrderBlockTimeframeEngine({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: 0.01, settings: S });
    e.update(c.slice(0, cut + 1)); // break bar is still FORMING
    expect(e.snapshot().blocks.filter((b) => b.low === 86)).toEqual([]);
    e.update(c.slice(0, cut + 1), { lastBarClosed: true }); // now it closed
    expect(e.snapshot().blocks.filter((b) => b.low === 86)).toHaveLength(1);
    // A wild forming bar later changes only the current price.
    const full = F.retest();
    const e2 = new OrderBlockTimeframeEngine({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: 0.01, settings: S });
    e2.update(full.slice(0, 90), { lastBarClosed: true });
    const before = JSON.stringify(e2.snapshot().blocks.map((b) => [b.id, b.state, b.tests, b.mitigationPct]));
    e2.update([...full.slice(0, 90), { ...full[90]!, low: 1, close: 2 }]);
    expect(JSON.stringify(e2.snapshot().blocks.map((b) => [b.id, b.state, b.tests, b.mitigationPct]))).toBe(before);
    expect(e2.snapshot().currentPrice).toBe(2);
  });
  it('insufficient history reports no blocks', () => {
    const snap = run(F.cleanBullish().slice(0, 30));
    expect(snap.state).toBe('INSUFFICIENT_HISTORY');
    expect(snap.blocks).toEqual([]);
  });
});

describe('score', () => {
  it('weights total exactly 100 % and total = Σ weight × component / 100 (no hidden adjustment)', () => {
    expect(Object.values(OB_SCORE_WEIGHTS).reduce((a, w) => a + w, 0)).toBe(100);
    for (const b of run(F.fullMitigation()).blocks) {
      const raw = (Object.keys(OB_SCORE_WEIGHTS) as (keyof typeof OB_SCORE_WEIGHTS)[]).reduce((a, k) => a + (b.score.weights[k] * b.score.components[k]) / 100, 0);
      expect(b.score.total).toBe(Math.round(Math.min(100, Math.max(0, raw))));
    }
  });
  it('untested beats heavily mitigated on the mitigation component; invalidated scores 0 there', () => {
    expect(bull(F.cleanBullish()).score.components.mitigation).toBe(100);
    expect(bull(F.fullMitigation()).score.components.mitigation).toBeLessThan(100);
    expect(bull(F.invalidation()).score.components.mitigation).toBe(0);
  });
  it('deterministic IDs and identical results across runs', () => {
    expect(JSON.stringify(run(F.fullMitigation()))).toBe(JSON.stringify(run(F.fullMitigation())));
  });
});
