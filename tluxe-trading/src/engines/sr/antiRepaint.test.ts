/**
 * Anti-repaint validation (S&R v1). Uses deterministic TEST-ONLY candle series.
 * The same audit runs in the app on real MT5 candles ("Verify no-repaint").
 */
import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../../types/market';
import { auditTimeframe, type AuditResult } from './antiRepaint';
import { SRTimeframeEngine } from './engine';
import { FIXTURE_START, mirror, randomWalk } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { DEFAULT_SR_SETTINGS, TIMEFRAME_SECONDS } from './settings';

const S = { ...DEFAULT_SR_SETTINGS };
const TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

/** Same bar sequence on another timeframe's clock (scenarios are authored on H1). */
const retime = (candles: readonly Candle[], tf: Timeframe): Candle[] =>
  candles.map((c, i) => ({ ...c, time: FIXTURE_START + i * TIMEFRAME_SECONDS[tf] }));

const audit = (candles: readonly Candle[], timeframe: Timeframe, checkpoints = 30) =>
  auditTimeframe({ instrumentId: 'XAUUSD', timeframe, candles, tickSize: 0.01, settings: S, checkpoints });

class SRTimeframeEngineForTest {
  readonly zones;
  constructor(c: readonly Candle[]) {
    const e = new SRTimeframeEngine({ instrumentId: 'XAUUSD', timeframe: 'M5', tickSize: 0.01, settings: S });
    e.update(c, { lastBarClosed: true });
    this.zones = e.snapshot().zones;
  }
}

const expectClean = (r: AuditResult) => {
  expect(r.violations).toEqual([]);
  expect(r.checkpoints).toBeGreaterThan(0);
};

describe('anti-repaint audit — every timeframe', () => {
  it.each(TFS)('%s: random-walk history, prefix N === replay at N for every checked N, all rules R1–R10 hold', (tf) => {
    const vol = { M1: 0.6, M5: 1.2, M15: 2, M30: 2.8, H1: 4, H4: 8, D1: 18 }[tf];
    for (const seed of [3, 17]) {
      const r = audit(randomWalk(420, { seed: seed + tf.length * 31, start: 2650, vol, tf }), tf);
      expectClean(r);
      expect(r.zones).toBeGreaterThan(5);
      expect(r.touches).toBeGreaterThan(5);
    }
  });

  it.each(TFS)('%s: break + flip scenarios obey the flip rule on this timeframe clock', (tf) => {
    for (const make of [F.supportToResistanceFlip, F.resistanceToSupportFlip, F.supportBreak]) {
      const r = audit(retime(make(), tf), tf, 40);
      expectClean(r);
      expect(r.breaks).toBeGreaterThan(0);
    }
    expect(audit(retime(F.supportToResistanceFlip(), tf), tf).flips).toBeGreaterThan(0);
  });
});

describe('anti-repaint audit — market-structure sections', () => {
  const sections: [string, () => Candle[]][] = [
    ['clean support reactions', () => F.strongSupport()],
    ['clean resistance reactions', () => F.strongResistance()],
    ['multiple touches', F.multipleTouches],
    ['repeated weak tests', F.repeatedWeakTests],
    ['sweep and reclaim', F.sweepAndReclaim],
    ['close-through without break', F.closeThroughNoBreak],
    ['genuine support break', F.supportBreak],
    ['genuine resistance break', () => mirror(F.supportBreak(), 150)],
    ['support → resistance reversal', F.supportToResistanceFlip],
    ['resistance → support reversal', F.resistanceToSupportFlip],
    ['strong volatility', () => randomWalk(500, { seed: 404, start: 2650, vol: 22 })],
    ['consolidation', () => randomWalk(500, { seed: 505, start: 2650, vol: 0.8 })],
  ];

  it.each(sections)('%s: zero violations', (_name, make) => {
    expectClean(audit(make(), 'H1', 60));
  });

  it('the sections really exercise touches, rejections, breaks and flips (tests are not vacuous)', () => {
    const results = sections.map(([, make]) => audit(make(), 'H1', 5));
    expect(results.reduce((a, r) => a + r.touches, 0)).toBeGreaterThan(50);
    expect(results.reduce((a, r) => a + r.breaks, 0)).toBeGreaterThanOrEqual(4);
    expect(results.reduce((a, r) => a + r.flips, 0)).toBeGreaterThanOrEqual(2);
  });
});

describe('regression: rejected retest that later breaks in the same episode', () => {
  // Found by the 5000-bar audit: a retest was rejected (zone flipped), then the SAME episode broke the
  // flipped zone. The break overwrote the interaction's resolvedTime with the later break time.
  const candles = randomWalk(5000, { seed: 1, start: 2650, vol: 2, tf: 'M5' });
  const id = 'XAUUSD:M5:S:1769019600';
  const run = (n: number) =>
    new SRTimeframeEngineForTest(candles.slice(0, n)).zones.find((z) => z.id === id)!;

  it('the rejection keeps the time it was decided; the break keeps its own time', () => {
    const full = run(candles.length);
    const retest = full.interactions.find((it) => it.phase === 'retest')!;
    const flipAt = full.roleHistory[0]!.time;
    const atFlip = run(candles.findIndex((c) => c.time === flipAt) + 1).interactions.find((it) => it.id === retest.id)!;
    expect(atFlip.rejected).toBe(true);
    expect(atFlip.resolvedTime).toBe(flipAt);
    expect(retest.broke).toBe(true);
    expect(retest.resolvedTime).toBe(flipAt); // not rewritten to the later break bar
    expect(retest.endTime).toBe(full.statusHistory.filter((h) => h.to === 'BROKEN').at(-1)!.time);
  });

  it('the full 5000-bar audit is clean', () => {
    expect(audit(candles, 'M5', 24).violations).toEqual([]);
  }, 30000);
});

describe('the audit catches repainting (it is not a rubber stamp)', () => {
  /** A deliberately CHEATING engine: whenever it is given N bars it secretly analyses N + 3 (future) bars. */
  const lookahead = (future: readonly Candle[]) => (o: ConstructorParameters<typeof SRTimeframeEngine>[0]) => {
    const inner = new SRTimeframeEngine(o);
    return {
      update: (c: readonly Candle[]) => inner.update(future.slice(0, Math.min(future.length, c.length + 3)), { lastBarClosed: true }),
      snapshot: () => inner.snapshot(),
    };
  };

  it('flags an engine that peeks at future candles', () => {
    const candles = F.supportToResistanceFlip();
    expect(audit(candles, 'H1').violations).toEqual([]);
    const r = auditTimeframe({ instrumentId: 'XAUUSD', timeframe: 'H1', candles, tickSize: 0.01, settings: S, checkpoints: 30, createEngine: lookahead(candles) });
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.some((v) => v.startsWith('R3') || v.startsWith('R10'))).toBe(true);
  });
});
