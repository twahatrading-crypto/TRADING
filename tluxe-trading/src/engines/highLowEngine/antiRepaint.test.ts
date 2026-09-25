import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { auditHighLowEngine } from './antiRepaint';
import { DEFAULT_HLE_SETTINGS } from './config';
import { HighLowEngine, type HLEEngineOptions, type HLEInput } from './engine';
import * as F from './fixtures/scenarios';

const base = (candles: HLEInput) => ({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...DEFAULT_HLE_SETTINGS }, candles, checkpoints: 12 });

describe('High / Low Engine anti-repaint audit (every knowledge time, five timeframes)', () => {
  it.each([
    ['BUY (ENTRY READY)', F.buyReversal],
    ['SELL', F.sellReversal],
    ['break without reclaim (LEVEL_BROKEN)', F.breakNoReclaim],
    ['reclaim without M5 (EXPIRED)', F.reclaimNoM5],
    ['no pullback (stage-3 EXPIRED)', F.confirmNoPullback],
    ['invalidated before entry', F.invalidatedBeforeEntry],
    ['stop after entry', F.stopAfterEntry],
    ['shallow poke', F.shallowPoke],
  ])('%s: PASS', (_n, f) => {
    const r = auditHighLowEngine(base(f()));
    expect(r.violations).toEqual([]);
    expect(r.steps).toBeGreaterThan(1000);
    expect(r.sweeps).toBeGreaterThan(0);
    expect(r.events).toBeGreaterThan(0);
  });
  it('the full chain is exercised (sweep → reclaim → M5 → ENTRY READY)', () => {
    const r = auditHighLowEngine(base(F.buyReversal()));
    expect(r.reclaims).toBeGreaterThan(0);
    expect(r.confirmations).toBeGreaterThan(0);
    expect(r.entryReady).toBeGreaterThan(0);
  });
  it('FAIL on look-ahead: an engine that sees one future M1 candle is caught (first mismatch reported)', () => {
    const full = F.buyReversal();
    const cheat = (o: HLEEngineOptions) => {
      const e = new HighLowEngine(o);
      return {
        update(input: HLEInput) {
          const m1 = input.M1 ?? [];
          const next = (full.M1 ?? [])[m1.length];
          e.update(next ? { ...input, M1: [...m1, next as Candle] } : input);
        },
        snapshot: () => e.snapshot(),
        inspect: () => e.inspect(),
      };
    };
    const r = auditHighLowEngine({ ...base(full), createEngine: cheat });
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations[0]).toMatch(/^A\d+ /);
  }, 180_000);
});
