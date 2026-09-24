/**
 * Liquidity Engine v1 — rule tests on deterministic TEST-ONLY scenarios.
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { DEFAULT_LIQUIDITY_SETTINGS, LIQUIDITY_SCORE_WEIGHTS } from './config';
import { analyzeLiquidity, LiquidityTimeframeEngine } from './engine';
import { walk } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import type { LiquidityPool, LiquiditySide } from './types';

const S = { ...DEFAULT_LIQUIDITY_SETTINGS };
const run = (candles: readonly Candle[], o: { lastBarClosed?: boolean; tickSize?: number } = {}) =>
  analyzeLiquidity({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: o.tickSize ?? 0.01, settings: S, candles, lastBarClosed: o.lastBarClosed ?? true });
/** The pool of interest (scenario level ~130.5 for BSL, ~169.5 for mirrored SSL). */
const poolNear = (pools: LiquidityPool[], side: LiquiditySide, level: number) =>
  pools.filter((p) => p.side === side && Math.abs(p.level - level) < 0.4).sort((a, b) => a.createdAt - b.createdAt)[0]!;

describe('1–2 clean BSL / SSL', () => {
  it('a qualifying swing high becomes an ACTIVE BSL resting at the high', () => {
    const p = poolNear(run(F.cleanBSL()).pools, 'BSL', 130.5);
    expect(p).toMatchObject({ side: 'BSL', source: 'swing', level: 130.5, state: 'ACTIVE' });
    expect(p.contributions).toHaveLength(1);
    expect(p.sweeps).toEqual([]);
  });
  it('a qualifying swing low becomes an ACTIVE SSL (exact mirror)', () => {
    const p = poolNear(run(F.cleanSSL()).pools, 'SSL', 169.5);
    expect(p).toMatchObject({ side: 'SSL', source: 'swing', level: 169.5, state: 'ACTIVE' });
  });
});

describe('3–8 equal highs / lows and tolerance', () => {
  it('EQH: two highs within tolerance cluster into ONE pool; level = the higher high', () => {
    const pools = run(F.eqh()).pools.filter((p) => p.side === 'BSL' && p.level > 129);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ source: 'equal', level: 130.6, rangeLow: 130.5, rangeHigh: 130.6 });
    expect(pools[0]!.contributions.map((c) => c.price)).toEqual([130.5, 130.6]);
  });
  it('EQL: two lows within tolerance cluster into ONE SSL pool; level = the lower low', () => {
    const pools = run(F.eql()).pools.filter((p) => p.side === 'SSL' && p.level < 171);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ source: 'equal', level: 169.4 });
  });
  it('near-equal highs at the edge of tolerance still join; beyond the band the first high is swept instead', () => {
    const tol = poolNear(run(F.cleanBSL()).pools, 'BSL', 130.5).tolerance;
    expect(poolNear(run(F.eqh(tol * 0.9)).pools, 'BSL', 130.5).contributions).toHaveLength(2);
    const beyond = run(F.eqh(tol * 1.6)).pools;
    const first = beyond.find((p) => p.side === 'BSL' && p.createdAt === poolNear(beyond, 'BSL', 130.5).createdAt)!;
    expect(first.contributions).toHaveLength(1);
    expect(first.sweeps.length).toBe(1);
  });
  it('highs outside tolerance stay separate pools', () => {
    const pools = run(F.highsOutsideTolerance()).pools.filter((p) => p.side === 'BSL' && p.level > 128);
    expect(pools.map((p) => p.level).sort()).toEqual([129, 130.5]);
    expect(pools.every((p) => p.source === 'swing')).toBe(true);
  });
  it('near-equal lows within tolerance join; lows outside tolerance stay separate', () => {
    expect(run(F.eql(0.2)).pools.filter((p) => p.side === 'SSL' && p.level < 171 && p.source === 'equal')).toHaveLength(1);
    expect(run(F.lowsOutsideTolerance()).pools.filter((p) => p.side === 'SSL' && p.level < 172 && p.level > 168).map((p) => p.level).sort()).toEqual([169.5, 171]);
  });
  it('tolerance = max(equalTolAtr × ATR, equalMinTicks × tick) — ATR-based, with a tick floor', () => {
    const snap = run(F.cleanBSL());
    const p = poolNear(snap.pools, 'BSL', 130.5);
    expect(p.tolerance).toBeCloseTo(Math.max(S.equalTolAtr * p.atrAtConfirmation, S.equalMinTicks * 0.01), 10);
    // Tick floor wins for a coarse instrument.
    expect(poolNear(run(F.cleanBSL(), { tickSize: 1 }).pools, 'BSL', 130.5).tolerance).toBe(2);
  });
});

describe('9–15 sweeps, reclaim, continuation, lifecycle', () => {
  it('BSL wick sweep + same-bar reclaim: SWEPT + RECLAIMED, never a reversal/signal', () => {
    const p = poolNear(run(F.bslWickSweepReclaim()).pools, 'BSL', 130.5);
    expect(p.state).toBe('SWEPT');
    expect(p.reclaimed).toBe(true);
    const e = p.sweeps[0]!;
    expect(e).toMatchObject({ kind: 'wick', outcome: 'reclaimed', sequence: 1, barsToReclaim: 0, level: 130.5, extremePrice: 131.6 });
    expect(e.penetration).toBeCloseTo(1.1, 10);
    expect(Object.keys(e)).not.toContain('signal');
  });
  it('SSL wick sweep + reclaim mirrors BSL', () => {
    const p = poolNear(run(F.sslWickSweepReclaim()).pools, 'SSL', 169.5);
    expect(p.sweeps[0]).toMatchObject({ kind: 'wick', outcome: 'reclaimed', extremePrice: 168.4 });
  });
  it('BSL break and continuation: close-through → accepted → CONSUMED (liquidity taken ≠ reversal)', () => {
    const p = poolNear(run(F.bslBreakContinuation()).pools, 'BSL', 130.5);
    expect(p.state).toBe('CONSUMED');
    expect(p.reclaimed).toBe(false);
    expect(p.sweeps).toHaveLength(1);
    expect(p.sweeps[0]).toMatchObject({ kind: 'closeThrough', outcome: 'accepted', reclaimed: false });
    expect(p.consumedAt).toBe(p.sweeps[0]!.acceptedTime);
  });
  it('SSL break and continuation mirrors BSL', () => {
    const p = poolNear(run(F.sslBreakContinuation()).pools, 'SSL', 169.5);
    expect(p.state).toBe('CONSUMED');
    expect(p.sweeps[0]).toMatchObject({ kind: 'closeThrough', outcome: 'accepted' });
  });
  it('repeated sweep: a second excursion after a reclaim is sweep #2 of the same pool', () => {
    const p = poolNear(run(F.repeatedSweep()).pools, 'BSL', 130.5);
    expect(p.sweeps.map((e) => e.sequence)).toEqual([1, 2]);
    expect(p.sweeps.every((e) => e.outcome === 'reclaimed')).toBe(true);
    expect(p.state).toBe('SWEPT');
  });
  it('already-consumed liquidity stays CONSUMED when price returns; no new sweeps are recorded', () => {
    const p = poolNear(run(F.consumedThenReturn()).pools, 'BSL', 130.5);
    expect(p.state).toBe('CONSUMED');
    expect(p.sweeps).toHaveLength(1);
    expect(p.stateHistory.at(-1)!.to).toBe('CONSUMED');
  });
  it('tested but unswept: TESTED with one test and no sweep', () => {
    const p = poolNear(run(F.testedUnswept()).pools, 'BSL', 130.5);
    expect(p).toMatchObject({ state: 'TESTED', reclaimed: false });
    expect(p.tests).toHaveLength(1);
    expect(p.sweeps).toEqual([]);
  });
  it('a swing that never displaces stays FORMING and is INVALIDATED after the qualify window', () => {
    // Tight chop: swings exist but price never closes 1 ATR away.
    const snap = run(walk(400, { seed: 5, start: 100, vol: 0.4 }));
    const inv = snap.pools.filter((p) => p.state === 'INVALIDATED');
    expect(inv.length).toBeGreaterThan(0);
    for (const p of inv) expect(p.stateHistory.map((h) => h.to)).toEqual(['FORMING', 'INVALIDATED']);
  });
});

describe('19, 21–23 determinism, forming bar, gaps, duplicates', () => {
  it('19: IDs are deterministic and stable across identical runs', () => {
    const a = run(F.repeatedSweep());
    const b = run(F.repeatedSweep());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const p = poolNear(a.pools, 'BSL', 130.5);
    expect(p.id).toBe(`XAUUSD:H1:LQ:BSL:${p.createdAt}`);
    expect(p.sweeps.map((e) => e.id)).toEqual([`${p.id}#SW1`, `${p.id}#SW2`]);
  });
  it('21: the forming bar never confirms a swing, creates/joins a pool, adds a test or records a sweep', () => {
    const closed = F.cleanBSL();
    const e = new LiquidityTimeframeEngine({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: 0.01, settings: S });
    e.update(closed, { lastBarClosed: true });
    const before = e.snapshot();
    const wild: Candle = { time: closed.at(-1)!.time + 3600, open: 116, high: 200, low: 1, close: 150, volume: null };
    e.update([...closed, wild]);
    const after = e.snapshot();
    const structural = (s: typeof before) => JSON.stringify({ swings: s.swings, pools: s.pools.map((p) => [p.id, p.state, p.level, p.tests, p.sweeps, p.stateHistory, p.contributions]) });
    expect(structural(after)).toBe(structural(before));
    expect(after.currentPrice).toBe(150);
    // …but it may show a live probe beyond an open pool (context only).
    expect(poolNear(after.pools, 'BSL', 130.5).liveProbe).toBe(true);
    expect(poolNear(before.pools, 'BSL', 130.5).liveProbe).toBe(false);
  });
  it('22: market-data gaps are reported, not filled, and do not invalidate pools', () => {
    const c = F.cleanBSL();
    const gapped = [...c.slice(0, 60), ...c.slice(60).map((b) => ({ ...b, time: b.time + 20 * 3600 }))];
    const snap = run(gapped);
    expect(snap.gaps).toEqual([{ after: c[59]!.time, before: c[60]!.time + 20 * 3600, missingBars: 20 }]);
    expect(poolNear(snap.pools, 'BSL', 130.5).state).toBe('ACTIVE');
  });
  it('23: duplicate / out-of-order timestamps are ignored (identical result)', () => {
    const c = F.bslWickSweepReclaim();
    const dup = [...c.slice(0, 70), { ...c[69]! }, ...c.slice(70)];
    expect(JSON.stringify(run(dup).pools)).toBe(JSON.stringify(run(c).pools));
  });
  it('insufficient history reports no pools', () => {
    const snap = run(F.cleanBSL().slice(0, 30));
    expect(snap.state).toBe('INSUFFICIENT_HISTORY');
    expect(snap.pools).toEqual([]);
  });
});

describe('score', () => {
  it('is transparent: total = Σ weight × component × state factor, 0–100', () => {
    for (const p of run(F.repeatedSweep()).pools) {
      const s = p.score;
      const w = (Object.keys(LIQUIDITY_SCORE_WEIGHTS) as (keyof typeof LIQUIDITY_SCORE_WEIGHTS)[]).reduce((a, k) => a + s.weights[k] * s.components[k], 0);
      expect(s.total).toBe(Math.round(Math.min(100, Math.max(0, w * s.stateFactor))));
      expect(s.total).toBeGreaterThanOrEqual(0);
      expect(s.total).toBeLessThanOrEqual(100);
    }
  });
  it('equal highs score higher than the same swing alone; swept/consumed score lower than active', () => {
    const single = poolNear(run(F.cleanBSL()).pools, 'BSL', 130.5).score.components.equalLevels;
    const equal = poolNear(run(F.eqh()).pools, 'BSL', 130.6).score.components.equalLevels;
    expect(equal).toBeGreaterThan(single);
    expect(poolNear(run(F.bslBreakContinuation()).pools, 'BSL', 130.5).score.stateFactor).toBeLessThan(1);
  });
});

