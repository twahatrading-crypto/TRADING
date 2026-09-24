import { describe, expect, it } from 'vitest';
import type { Timeframe } from '../../types/market';
import { DEFAULT_LIQUIDITY_SETTINGS } from './config';
import { analyzeLiquidity } from './engine';
import { bars, path, warm } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { buildLiquidityMulti, isOpenLiquidity, nearestLiquidity } from './mtf';

const S = { ...DEFAULT_LIQUIDITY_SETTINGS };
const snap = (tf: Timeframe, candles: ReturnType<typeof bars>) =>
  analyzeLiquidity({ instrumentId: 'XAUUSD', timeframe: tf, tickSize: 0.01, settings: S, candles, lastBarClosed: true, currentPrice: 116 });
/** An M15 history of its OWN (different path) whose swing high tops out at `top`. */
const m15With = (top: number) => bars([...path(100, ...warm(100), [top - 0.5, 16], [115, 10], [117, 6], [115, 6])], { tf: 'M15' });

describe('multi-timeframe liquidity', () => {
  it('16: overlapping independent detections form a cluster; both originals are preserved', () => {
    const h1 = snap('H1', F.cleanBSL()); // BSL 130.50
    const m15 = snap('M15', m15With(130.6)); // BSL 130.60 from M15's own candles
    const multi = buildLiquidityMulti('XAUUSD', { H1: h1, M15: m15 }, S);
    const c = multi.clusters.find((x) => x.side === 'BSL' && x.timeframes.includes('H1') && x.timeframes.includes('M15'))!;
    expect(c).toBeDefined();
    expect([c.low, c.high]).toEqual([130.5, 130.6]);
    // Originals kept with their own timeframe, level and id.
    const members = multi.pools.filter((p) => c.poolIds.includes(p.id));
    expect(members.map((p) => [p.timeframe, p.level])).toEqual(expect.arrayContaining([['H1', 130.5], ['M15', 130.6]]));
    expect(members.every((p) => p.id.includes(`:${p.timeframe}:`) && p.confluenceIds[0] === c.id && p.score.components.confluence === 50)).toBe(true);
  });

  it('17: non-overlapping levels do not cluster (no fake agreement)', () => {
    const multi = buildLiquidityMulti('XAUUSD', { H1: snap('H1', F.cleanBSL()), M15: snap('M15', m15With(134)) }, S);
    expect(multi.clusters.filter((c) => c.timeframes.includes('H1') && c.timeframes.includes('M15') && c.high > 129)).toEqual([]);
  });

  it('no level is ever copied between timeframes: every pool comes from its own snapshot', () => {
    const h1 = snap('H1', F.cleanBSL());
    const m15 = snap('M15', m15With(130.6));
    const multi = buildLiquidityMulti('XAUUSD', { H1: h1, M15: m15 }, S);
    const own = new Set([...h1.pools, ...m15.pools].map((p) => p.id));
    expect(multi.pools.every((p) => own.has(p.id))).toBe(true);
    expect(multi.pools).toHaveLength(own.size);
  });

  it('nearest BSL above / SSL below use open (ACTIVE / TESTED) liquidity only — context, not a signal', () => {
    const h1 = snap('H1', F.cleanBSL());
    const { above, below } = nearestLiquidity(h1.pools, 116);
    expect(above?.side).toBe('BSL');
    expect(above!.level).toBeGreaterThan(116);
    expect(isOpenLiquidity(above!)).toBe(true);
    if (below) expect(below.level).toBeLessThan(116);
    expect(nearestLiquidity(h1.pools, null)).toEqual({ above: null, below: null });
  });
});
