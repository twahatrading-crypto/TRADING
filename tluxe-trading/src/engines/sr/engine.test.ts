import { describe, expect, it } from 'vitest';
import { normalizeCandles } from '../../services/market/normalize';
import type { Candle, Timeframe } from '../../types/market';
import { analyzeTimeframe, SRTimeframeEngine } from './engine';
import { appendBars, fromCloses, path, scale } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { DEFAULT_SR_SETTINGS, type SRSettings } from './settings';
import { canTransition } from './stateMachine';
import type { SRSnapshot, SRZone } from './types';

const S: SRSettings = { ...DEFAULT_SR_SETTINGS };
const run = (candles: Candle[], tf: Timeframe = 'H1', settings: SRSettings = S, instrumentId = 'GC', tickSize = 0.1): SRSnapshot =>
  analyzeTimeframe({ instrumentId, timeframe: tf, tickSize, settings, candles, lastBarClosed: true });

/** The zone whose range contains `price`. */
const zoneAt = (snap: SRSnapshot, price: number, type?: SRZone['type']): SRZone => {
  const z = snap.zones.find((x) => x.zoneLow <= price && price <= x.zoneHigh && (!type || x.type === type));
  if (!z) throw new Error(`no zone at ${price}: ${snap.zones.map((x) => `${x.type}@${x.zoneLow.toFixed(2)}-${x.zoneHigh.toFixed(2)}`).join(', ')}`);
  return z;
};

describe('confirmed pivots', () => {
  const candles = F.freshLevel();
  const lowIdx = candles.findIndex((c) => c.close === 100);

  it('never confirms a pivot before pivotRight bars have closed after it', () => {
    for (let n = lowIdx + 1; n <= lowIdx + S.pivotRight; n++) {
      const snap = analyzeTimeframe({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: { ...S, minHistoryBars: 20 }, candles: candles.slice(0, n), lastBarClosed: true });
      expect(snap.pivots.some((p) => p.pivotTime === candles[lowIdx]!.time)).toBe(false);
    }
    const snap = analyzeTimeframe({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: { ...S, minHistoryBars: 20 }, candles: candles.slice(0, lowIdx + S.pivotRight + 1), lastBarClosed: true });
    const p = snap.pivots.find((x) => x.pivotTime === candles[lowIdx]!.time);
    expect(p).toBeDefined();
    expect(p!.confirmedAt).toBe(candles[lowIdx + S.pivotRight]!.time);
    expect(p!.confirmedIndex - p!.index).toBe(S.pivotRight);
  });

  it('treats the newest candle as forming unless told otherwise', () => {
    const n = lowIdx + S.pivotRight + 1;
    const e = new SRTimeframeEngine({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: { ...S, minHistoryBars: 20 } });
    e.update(candles.slice(0, n)); // last bar = confirmation bar, still forming
    expect(e.snapshot().pivots.some((p) => p.pivotTime === candles[lowIdx]!.time)).toBe(false);
    e.update(candles.slice(0, n + 1)); // now it has closed
    expect(e.snapshot().pivots.some((p) => p.pivotTime === candles[lowIdx]!.time)).toBe(true);
  });

  it('stores pivotTime and confirmedAt on zones', () => {
    const z = zoneAt(run(candles), 99.8);
    expect(z.createdAt).toBe(candles[lowIdx]!.time);
    expect(z.confirmedAt).toBe(candles[lowIdx + S.pivotRight]!.time);
    expect(z.confirmedAt).toBeGreaterThan(z.createdAt);
  });
});

describe('zones, not lines', () => {
  it('every zone has low < high and a frozen definition', () => {
    const snap = run(F.strongSupport());
    for (const z of snap.zones) {
      expect(z.zoneLow).toBeLessThan(z.zoneHigh);
      expect(z.midPrice).toBeCloseTo((z.zoneLow + z.zoneHigh) / 2);
      expect(z.width).toBeCloseTo(z.zoneHigh - z.zoneLow);
    }
  });

  it('support spans wick low → body bottom (clamped by ATR)', () => {
    const z = zoneAt(run(F.freshLevel()), 99.8, 'support');
    expect(z.zoneLow).toBeCloseTo(99.5); // wick low
    expect(z.zoneHigh).toBeCloseTo(100); // body bottom
  });

  it('ATR method uses zoneAtrMultiplier × ATR from the extreme', () => {
    const z = zoneAt(run(F.freshLevel(), 'H1', { ...S, zoneWidthMethod: 'atr' }), 99.6, 'support');
    expect(z.zoneLow).toBeCloseTo(99.5);
    expect(z.width).toBeCloseTo(S.zoneAtrMultiplier * z.atrAtConfirmation);
  });

  it('respects the minimum tick width', () => {
    const z = zoneAt(run(F.freshLevel(), 'H1', { ...S, zoneMinAtr: 0.02, zoneMaxAtr: 0.2 }, 'GC', 1), 99.6, 'support');
    expect(z.width).toBeGreaterThanOrEqual(2 * 1 - 1e-9);
  });
});

describe('scenario fixtures', () => {
  it('1. strong support: two clean rejections, holding', () => {
    const z = zoneAt(run(F.strongSupport()), 99.8, 'support');
    expect(z.status).toBe('TESTED');
    expect(z.touchCount).toBe(2);
    expect(z.rejectionCount).toBe(2);
    expect(z.interactions.every((i) => i.outcome === 'rejection')).toBe(true);
    expect(z.brokenAt).toBeNull();
  });

  it('2. strong resistance mirrors strong support exactly', () => {
    const sup = zoneAt(run(F.strongSupport()), 99.8, 'support');
    const res = zoneAt(run(F.strongResistance()), 200.2, 'resistance');
    expect(res.status).toBe(sup.status);
    expect(res.touchCount).toBe(sup.touchCount);
    expect(res.rejectionCount).toBe(sup.rejectionCount);
    expect(res.score).toEqual(sup.score);
    expect(res.zoneLow).toBeCloseTo(300 - sup.zoneHigh);
  });

  it('3. fresh level: never revisited', () => {
    const z = zoneAt(run(F.freshLevel()), 99.8, 'support');
    expect(z.status).toBe('FRESH');
    expect(z.touchCount).toBe(0);
    expect(z.score.components.freshness).toBeGreaterThan(90);
  });

  it('4. multiple touches are counted as episodes, not bars', () => {
    const candles = F.multipleTouches();
    const z = zoneAt(run(candles), 99.8, 'support');
    const barsTouching = candles.filter((c, k) => k > 60 && c.low <= z.zoneHigh + 0.2).length;
    expect(z.touchCount).toBe(3);
    expect(barsTouching).toBeGreaterThan(z.touchCount);
    const starts = z.interactions.map((i) => i.startTime);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('5. repeated weak tests weaken the level and lower its score', () => {
    const weak = zoneAt(run(F.repeatedWeakTests()), 99.8, 'support');
    const strong = zoneAt(run(F.strongSupport()), 99.8, 'support');
    expect(weak.status).toBe('WEAKENING');
    expect(weak.touchCount).toBeGreaterThanOrEqual(3);
    expect(weak.rejectionCount).toBe(0);
    expect(weak.interactions.filter((i) => i.outcome === 'touch').length).toBeGreaterThanOrEqual(2);
    expect(weak.score.components.touchQuality).toBeLessThan(strong.score.components.touchQuality);
    expect(weak.score.components.freshness).toBeLessThan(strong.score.components.freshness);
    expect(weak.score.total).toBeLessThan(strong.score.total);
  });

  it('more touches alone never raise the score', () => {
    const three = zoneAt(run(F.multipleTouches()), 99.8, 'support');
    const two = zoneAt(run(F.strongSupport()), 99.8, 'support');
    expect(three.touchCount).toBeGreaterThan(two.touchCount);
    expect(three.score.components.freshness).toBeLessThan(two.score.components.freshness);
    expect(three.score.total).toBeLessThanOrEqual(two.score.total);
  });

  it('6. wick sweep + reclaim is a SWEEP, not a break', () => {
    const z = zoneAt(run(F.sweepAndReclaim()), 99.8, 'support');
    expect(z.brokenAt).toBeNull();
    expect(z.status).not.toBe('BROKEN');
    expect(z.sweepCount).toBe(1);
    const it = z.interactions.find((i) => i.swept)!;
    expect(it.outcome).toBe('sweep');
    expect(it.sweepDepth).toBeGreaterThan(0);
    expect(it.sweepTime).not.toBeNull();
    expect(it.rejected).toBe(true);
  });

  it('7. a close through without confirmation is NOT a break (but weakens)', () => {
    const z = zoneAt(run(F.closeThroughNoBreak()), 99.8, 'support');
    expect(z.brokenAt).toBeNull();
    expect(z.closeThroughCount).toBe(1);
    expect(z.interactions[0]!.outcome).toBe('closeThrough');
    expect(z.status).toBe('WEAKENING');
  });

  it('8. confirmed support break records brokenAt and evidence', () => {
    const candles = F.supportBreak();
    const z = zoneAt(run(candles), 99.8, 'support');
    expect(z.status).toBe('BROKEN');
    expect(z.breakEvidence?.rule).toBe('consecutiveCloses');
    expect(z.breakEvidence?.closes).toHaveLength(S.breakConfirmCloses);
    expect(z.breakEvidence!.closes.every((c) => c < z.breakEvidence!.threshold)).toBe(true);
    expect(z.brokenAt).toBe(z.breakEvidence!.closeTimes.at(-1));
    expect(z.interactions.at(-1)!.outcome).toBe('break');
  });

  it('9. confirmed resistance break mirrors support break', () => {
    const z = zoneAt(run(F.resistanceBreak()), 200.2, 'resistance');
    expect(z.status).toBe('BROKEN');
    expect(z.breakEvidence?.role).toBe('resistance');
    expect(z.breakEvidence!.closes.every((c) => c > z.breakEvidence!.threshold)).toBe(true);
  });

  it('a single decisive displacement close confirms a break', () => {
    const z = zoneAt(run(F.supportBreak(), 'H1', { ...S, breakConfirmCloses: 5, breakDisplacementAtr: 0.5 }), 99.8, 'support');
    expect(z.breakEvidence?.rule).toBe('displacement');
  });

  it('10. support → resistance flip keeps the id and full history', () => {
    const z = zoneAt(run(F.supportToResistanceFlip()), 99.8);
    expect(z.type).toBe('support');
    expect(z.role).toBe('resistance');
    expect(z.status).toBe('FLIPPED');
    expect(z.roleHistory).toEqual([{ from: 'support', to: 'resistance', time: z.flippedAt }]);
    expect(z.statusHistory.map((s) => s.to)).toEqual(expect.arrayContaining(['FRESH', 'BROKEN', 'FLIPPED']));
    expect(z.brokenAt).not.toBeNull();
    expect(z.flippedAt!).toBeGreaterThan(z.brokenAt!);
    const retest = z.interactions.find((i) => i.phase === 'retest')!;
    expect(retest.role).toBe('resistance');
    expect(retest.rejected).toBe(true);
  });

  it('11. resistance → support flip mirrors it', () => {
    const z = zoneAt(run(F.resistanceToSupportFlip()), 200.2);
    expect(z.type).toBe('resistance');
    expect(z.role).toBe('support');
    expect(z.status).toBe('FLIPPED');
  });

  it('no flip without a separated retest (continuation is not a retest)', () => {
    const z = zoneAt(run(F.supportBreak()), 99.8, 'support');
    expect(z.flippedAt).toBeNull();
    expect(z.status).toBe('BROKEN');
  });

  it('12. duplicate nearby pivots cluster into one zone with provenance', () => {
    const snap = run(F.duplicateNearbyPivots());
    const near = snap.zones.filter((z) => z.type === 'support' && z.zoneHigh > 99 && z.zoneLow < 101);
    expect(near).toHaveLength(1);
    expect(near[0]!.sourcePivotIds.length).toBeGreaterThanOrEqual(2);
    expect(near[0]!.score.components.structure).toBeGreaterThan(60);
  });

  it('13. genuinely separate nearby structures stay separate', () => {
    const snap = run(F.separatedNearbyZones());
    zoneAt(snap, 99.8, 'support');
    zoneAt(snap, 105.2, 'support');
    const supports = snap.zones.filter((z) => z.type === 'support' && z.zoneLow > 98 && z.zoneHigh < 107);
    expect(supports).toHaveLength(2);
  });

  it('16. insufficient history reports it and returns no zones', () => {
    const snap = run(F.strongSupport().slice(0, 30));
    expect(snap.state).toBe('INSUFFICIENT_HISTORY');
    expect(snap.zones).toEqual([]);
    expect(snap.requiredBars).toBe(S.minHistoryBars);
    expect(run([]).state).toBe('NO_DATA');
  });

  it('17. missing candles are reported, never filled in; invalid candles are dropped', () => {
    const full = F.strongSupport();
    const gappy = full.filter((_, k) => k < 40 || k >= 45);
    const snap = run(gappy);
    expect(snap.gaps).toEqual([{ after: full[39]!.time, before: full[45]!.time, missingBars: 5 }]);
    expect(snap.barsProcessed).toBe(gappy.length);
    const corrupt = [...full];
    corrupt[70] = { ...corrupt[70]!, high: Number.NaN };
    const clean = normalizeCandles(corrupt);
    expect(clean).toHaveLength(full.length - 1);
    expect(() => run(clean)).not.toThrow();
  });

  it('18. identical structure on different price scales gives identical results', () => {
    const base = F.strongSupport();
    const gc = run(base, 'H1', S, 'GC', 0.1);
    const eur = run(scale(base, 0.0105), 'H1', S, 'EURUSD', 0.00001);
    const btc = run(scale(base, 640), 'H1', S, 'BTCUSD', 0.01);
    for (const other of [eur, btc]) {
      expect(other.zones.map((z) => [z.type, z.status, z.touchCount, z.rejectionCount, z.score.total])).toEqual(
        gc.zones.map((z) => [z.type, z.status, z.touchCount, z.rejectionCount, z.score.total]),
      );
    }
    expect(eur.zones[0]!.zoneLow).toBeCloseTo(gc.zones[0]!.zoneLow * 0.0105, 8);
    expect(btc.zones.every((z) => z.id.startsWith('BTCUSD:H1:'))).toBe(true);
  });
});

describe('timeframes and instruments', () => {
  it.each(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const)('%s runs independently and keeps its source timeframe', (tf) => {
    const candles = fromCloses(path(130, [124, 4], [130, 4], [124, 4], [130, 4], [124, 4], [130, 4], [100, 16], [118, 12], [100.3, 12], [120, 12]), { tf });
    const snap = run(candles, tf);
    expect(snap.timeframe).toBe(tf);
    expect(snap.zones.length).toBeGreaterThan(0);
    expect(snap.zones.every((z) => z.timeframe === tf && z.id.includes(`:${tf}:`))).toBe(true);
    expect(snap.zones.every((z) => z.score.components.timeframe === { M1: 20, M5: 35, M15: 50, M30: 60, H1: 70, H4: 85, D1: 100 }[tf])).toBe(true);
  });

  it('every zone and pivot carries the explicit instrument id', () => {
    const snap = run(F.strongSupport(), 'H1', S, 'XAGUSD', 0.001);
    expect(snap.instrumentId).toBe('XAGUSD');
    expect(snap.zones.every((z) => z.instrumentId === 'XAGUSD' && z.id.startsWith('XAGUSD:'))).toBe(true);
    expect(snap.pivots.every((p) => p.id.startsWith('XAGUSD:'))).toBe(true);
  });

  it('never outputs trade directions', () => {
    const json = JSON.stringify(run(F.supportToResistanceFlip()));
    expect(json).not.toMatch(/\b(BUY|SELL|LONG|SHORT)\b/i);
  });
});

describe('state machine', () => {
  it('every recorded transition is legal', () => {
    for (const fn of Object.values(F)) {
      const candles = (fn as () => Candle[])();
      const tf = candles[1]!.time - candles[0]!.time === 14400 ? 'H4' : 'H1';
      for (const z of run(candles, tf).zones) {
        z.statusHistory.slice(1).forEach((c) => expect(canTransition(c.from!, c.to)).toBe(true));
        expect(z.statusHistory.at(-1)!.to).toBe(z.status);
      }
    }
  });

  it('holding zones expire after expiryBars without interaction', () => {
    const long = appendBars(F.freshLevel(), Array.from({ length: 40 }, () => [125, 126, 124, 125] as [number, number, number, number]));
    const z = zoneAt(run(long, 'H1', { ...S, expiryBars: 50 }), 99.8, 'support');
    expect(z.status).toBe('EXPIRED');
    expect(z.statusHistory.at(-1)!.reason).toMatch(/no interaction/);
  });

  it('broken zones expire when no retest happens inside the flip window', () => {
    const z = zoneAt(run(F.supportBreak(), 'H1', { ...S, flipWindowBars: 10 }), 99.8, 'support');
    expect(z.status).toBe('EXPIRED');
    expect(z.statusHistory.map((s) => s.to)).toEqual(['FRESH', 'ACTIVE', 'BROKEN', 'EXPIRED']);
  });
});

describe('settings', () => {
  it('changing settings recalculates deterministically', () => {
    const a1 = run(F.strongSupport(), 'H1', { ...S, pivotLeft: 5, pivotRight: 5 });
    const a2 = run(F.strongSupport(), 'H1', { ...S, pivotLeft: 5, pivotRight: 5 });
    const b = run(F.strongSupport());
    expect(a1).toEqual(a2);
    expect(a1.settingsKey).not.toBe(b.settingsKey);
    expect(a1.zones.map((z) => z.confirmedAt)).not.toEqual(b.zones.map((z) => z.confirmedAt));
  });
});
