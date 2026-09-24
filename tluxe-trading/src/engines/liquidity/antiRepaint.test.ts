/**
 * Liquidity anti-repaint validation on all timeframes (deterministic TEST-ONLY candles).
 * The same audit runs in the app on loaded MT5 candles ("Verify no-repaint").
 */
import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../../types/market';
import { auditLiquidity } from './antiRepaint';
import { DEFAULT_LIQUIDITY_SETTINGS, LIQUIDITY_TF_SECONDS } from './config';
import { LiquidityTimeframeEngine } from './engine';
import { T0, walk } from './fixtures/builders';
import * as F from './fixtures/scenarios';

const S = { ...DEFAULT_LIQUIDITY_SETTINGS };
const TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const retime = (c: readonly Candle[], tf: Timeframe) => c.map((b, i) => ({ ...b, time: T0 + i * LIQUIDITY_TF_SECONDS[tf] }));
const audit = (candles: readonly Candle[], timeframe: Timeframe, checkpoints = 30) =>
  auditLiquidity({ instrumentId: 'XAUUSD', timeframe, candles, tickSize: 0.01, settings: S, checkpoints });

describe('18: no future leakage / no repainting — every timeframe', () => {
  it.each(TFS)('%s: bar-by-bar replay matches fresh prefix runs; L1–L10 hold', (tf) => {
    for (const seed of [4, 19]) {
      const r = audit(walk(900, { seed: seed + tf.length * 7, start: 2650, vol: 2, tf }), tf);
      expect(r.violations).toEqual([]);
      expect(r.checkpoints).toBeGreaterThan(0);
      expect(r.pools).toBeGreaterThan(10);
      expect(r.sweeps).toBeGreaterThan(5);
      expect(r.reclaims).toBeGreaterThan(0);
      expect(r.consumed).toBeGreaterThan(0);
    }
  });

  it.each(TFS)('%s: every named scenario is clean on this timeframe clock', (tf) => {
    for (const make of Object.values(F)) expect(audit(retime(make(), tf), tf, 40).violations).toEqual([]);
  });

  it('a long 5000-bar history is clean (production-sized)', () => {
    const r = audit(walk(5000, { seed: 1, start: 2650, vol: 2, tf: 'M5' }), 'M5', 24);
    expect(r.violations).toEqual([]);
    expect(r.equalPools).toBeGreaterThan(0);
  }, 60000);
});

describe('the audit is not a rubber stamp', () => {
  it('flags an engine that peeks 3 bars into the future', () => {
    const candles = F.repeatedSweep();
    const cheat = (o: ConstructorParameters<typeof LiquidityTimeframeEngine>[0]) => {
      const inner = new LiquidityTimeframeEngine(o);
      return {
        update: (c: readonly Candle[]) => inner.update(candles.slice(0, Math.min(candles.length, c.length + 3)), { lastBarClosed: true }),
        snapshot: () => inner.snapshot(),
      };
    };
    const r = auditLiquidity({ instrumentId: 'XAUUSD', timeframe: 'H1', candles, tickSize: 0.01, settings: S, checkpoints: 30, createEngine: cheat });
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
