/**
 * Order Block anti-repaint validation on all timeframes (deterministic TEST-ONLY candles).
 */
import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../../types/market';
import { auditOrderBlocks } from './antiRepaint';
import { DEFAULT_OB_SETTINGS, OB_TF_SECONDS } from './config';
import { OrderBlockTimeframeEngine } from './engine';
import { T0, walk } from './fixtures/builders';
import * as F from './fixtures/scenarios';

const S = { ...DEFAULT_OB_SETTINGS };
const TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const retime = (c: readonly Candle[], tf: Timeframe) => c.map((b, i) => ({ ...b, time: T0 + i * OB_TF_SECONDS[tf] }));
const audit = (candles: readonly Candle[], timeframe: Timeframe, checkpoints = 30) => auditOrderBlocks({ instrumentId: 'XAUUSD', timeframe, candles, tickSize: 0.01, settings: S, checkpoints });
const scenarios = Object.entries(F).filter(([k]) => k !== 'ORIGIN') as [string, () => Candle[]][];

describe('anti-repaint — every timeframe', () => {
  it.each(TFS)('%s: bar-by-bar state === clean recomputation; O1–O10 hold', (tf) => {
    for (const seed of [8, 29]) {
      const r = audit(walk(1200, { seed: seed + tf.length * 5, start: 2650, vol: 2, tf }), tf);
      expect(r.violations).toEqual([]);
      expect(r.checkpoints).toBeGreaterThan(0);
      expect(r.blocks).toBeGreaterThan(3);
      expect(r.breaks).toBeGreaterThan(r.blocks); // not every break is an order block
    }
  });

  it.each(TFS)('%s: every named scenario is clean on this timeframe clock', (tf) => {
    for (const [, make] of scenarios) expect(audit(retime(make(), tf), tf, 40).violations).toEqual([]);
  });

  it('a 5000-bar history is clean (production-sized) and exercises the whole lifecycle', () => {
    const r = audit(walk(5000, { seed: 3, start: 2650, vol: 2, tf: 'M15' }), 'M15', 24);
    expect(r.violations).toEqual([]);
    expect(r.chochs).toBeGreaterThan(0);
    expect(r.tested).toBeGreaterThan(0);
    expect(r.mitigated).toBeGreaterThan(0);
    expect(r.invalidated).toBeGreaterThan(0);
  }, 60000);
});

describe('the audit catches look-ahead', () => {
  it('flags an engine that peeks 3 bars into the future', () => {
    const candles = F.fullMitigation();
    const cheat = (o: ConstructorParameters<typeof OrderBlockTimeframeEngine>[0]) => {
      const inner = new OrderBlockTimeframeEngine(o);
      return { update: (c: readonly Candle[]) => inner.update(candles.slice(0, Math.min(candles.length, c.length + 3)), { lastBarClosed: true }), snapshot: () => inner.snapshot() };
    };
    const r = auditOrderBlocks({ instrumentId: 'XAUUSD', timeframe: 'H1', candles, tickSize: 0.01, settings: S, checkpoints: 30, createEngine: cheat });
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
