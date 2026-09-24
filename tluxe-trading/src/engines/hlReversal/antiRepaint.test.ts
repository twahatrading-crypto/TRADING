import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { auditHighLowReversal } from './antiRepaint';
import { DEFAULT_HLR_SETTINGS } from './config';
import { HighLowReversalEngine, type HLREngineOptions, type HLRInput } from './engine';
import * as F from './fixtures/scenarios';

const base = (candles: HLRInput) => ({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...DEFAULT_HLR_SETTINGS }, candles, checkpoints: 12 });

describe('High / Low Reversal anti-repaint audit (every knowledge time, all five timeframes)', () => {
  it.each([
    ['BUY reversal (ENTRY READY → TRIGGERED)', F.buyReversal],
    ['SELL reversal', F.sellReversal],
    ['sweep without reclaim', F.sweepNoReclaim],
    ['acceptance beyond', F.acceptedBeyond],
    ['reclaim without M5', F.reclaimNoM5],
    ['M5 without pullback (MISSED)', F.confirmNoPullback],
    ['invalidation before entry', F.invalidatedBeforeEntry],
  ])('%s: no violations', (_n, f) => {
    const r = auditHighLowReversal(base(f()));
    expect(r.violations).toEqual([]);
    expect(r.steps).toBeGreaterThan(900);
    expect(r.checkpoints).toBeGreaterThanOrEqual(12);
    expect(r.sweeps).toBeGreaterThan(0);
  });

  it('the full BUY sequence is actually exercised (sweep, reclaim, M5, entry)', () => {
    const r = auditHighLowReversal(base(F.buyReversal()));
    expect(r.reclaims).toBeGreaterThan(0);
    expect(r.confirmations).toBeGreaterThan(0);
    expect(r.entryReady).toBeGreaterThan(0);
  });

  it('detects look-ahead: an engine that sees one future M1 candle is caught', () => {
    const full = F.buyReversal();
    const cheat = (o: HLREngineOptions) => {
      const e = new HighLowReversalEngine(o);
      return {
        update(input: HLRInput) {
          const m1 = input.M1 ?? [];
          const next = (full.M1 ?? [])[m1.length];
          e.update(next ? { ...input, M1: [...m1, next as Candle] } : input);
        },
        snapshot: () => e.snapshot(),
        inspect: () => e.inspect(),
      };
    };
    const r = auditHighLowReversal({ ...base(full), createEngine: cheat });
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.some((v) => v.startsWith('R8') || v.startsWith('R1') || v.startsWith('R5') || v.startsWith('R6'))).toBe(true);
  });
});
