import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../../types/market';
import { DEFAULT_OB_SETTINGS } from './config';
import { analyzeOrderBlocks } from './engine';
import { bars, path, warm } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { buildOBMulti, isLiveBlock, nearestBlocks } from './mtf';

const S = { ...DEFAULT_OB_SETTINGS };
const snap = (tf: Timeframe, c: readonly Candle[]) => analyzeOrderBlocks({ instrumentId: 'XAUUSD', timeframe: tf, tickSize: 0.01, settings: S, candles: c, lastBarClosed: true, currentPrice: 100 });
/** An M15 history of its OWN whose bullish origin candle spans [lo, lo + 2]. */
const m15With = (lo: number) =>
  bars([...path(100, ...warm(), [lo + 4, 5], [lo + 9.5, 3], [lo, 5], [lo + 2, 2]), lo + 0.5, lo + 4, lo + 8, lo + 11.5, ...path(lo + 11.5, [lo + 14, 3], [lo + 13, 6])], { tf: 'M15' });

describe('multi-timeframe order blocks', () => {
  it('independently detected overlapping blocks form a SEPARATE confluence result; originals are not mutated', () => {
    const h1 = snap('H1', F.cleanBullish()); // bullish [86, 88]
    const m15 = snap('M15', m15With(86.5)); // bullish from its own candles
    const m15Block = m15.blocks.find((b) => b.type === 'bullish' && b.low > 85 && b.high < 90)!;
    expect(m15Block).toBeDefined();
    const before = JSON.stringify({ h1, m15 });
    const multi = buildOBMulti('XAUUSD', { H1: h1, M15: m15 }, S);
    expect(JSON.stringify({ h1, m15 })).toBe(before); // per-timeframe snapshots untouched
    const c = multi.confluences.find((x) => x.timeframes.includes('H1') && x.timeframes.includes('M15'))!;
    expect(c.type).toBe('bullish');
    expect(c.low).toBe(Math.max(86, m15Block.low));
    expect(c.high).toBe(Math.min(88, m15Block.high));
  });

  it('non-overlapping independent blocks do not form a confluence', () => {
    const multi = buildOBMulti('XAUUSD', { H1: snap('H1', F.cleanBullish()), M15: snap('M15', m15With(92)) }, S);
    expect(multi.confluences.filter((x) => x.timeframes.includes('H1') && x.timeframes.includes('M15') && x.low < 90)).toEqual([]);
  });

  it('no block is ever copied to another timeframe', () => {
    const h1 = snap('H1', F.cleanBullish());
    const m15 = snap('M15', m15With(86.5));
    const own = new Set([...h1.blocks, ...m15.blocks].map((b) => b.id));
    const multi = buildOBMulti('XAUUSD', { H1: h1, M15: m15 }, S);
    expect(multi.blocks).toHaveLength(own.size);
    expect(multi.blocks.every((b) => own.has(b.id) && b.id.includes(`:${b.timeframe}:`))).toBe(true);
  });

  it('nearest live blocks above / below price (context only)', () => {
    const { below } = nearestBlocks(snap('H1', F.cleanBullish()).blocks, 100);
    expect(below && isLiveBlock(below) && below.high < 100).toBe(true);
  });
});
