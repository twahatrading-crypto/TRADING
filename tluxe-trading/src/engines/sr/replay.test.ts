import { describe, expect, it } from 'vitest';
import { SRTimeframeEngine, analyzeTimeframe } from './engine';
import { randomWalk } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { replaySR } from './replay';
import { DEFAULT_SR_SETTINGS } from './settings';
import type { SRZone } from './types';

const S = { ...DEFAULT_SR_SETTINGS };
const FROZEN = ['id', 'type', 'zoneLow', 'zoneHigh', 'midPrice', 'width', 'createdAt', 'confirmedAt', 'timeframe', 'instrumentId', 'pivotId'] as const;
const frozen = (z: SRZone) => Object.fromEntries(FROZEN.map((k) => [k, z[k]]));

describe('20. replay / anti-repaint', () => {
  it.each([1, 7, 42, 2026])('random walk seed %i: zero violations over a bar-by-bar replay', (seed) => {
    const candles = randomWalk(320, { seed, start: 2350, vol: 3 });
    const r = replaySR({ instrumentId: 'GC', timeframe: 'H1', candles, tickSize: 0.1, settings: S });
    expect(r.violations).toEqual([]);
    expect(r.events.filter((e) => e.type === 'zoneConfirmed').length).toBeGreaterThan(5);
    // A zone is only reported once its confirmation bar has closed.
    for (const e of r.events.filter((x) => x.type === 'zoneConfirmed')) {
      expect(r.firstSeen.get(e.zoneId)!.confirmedAt).toBeLessThanOrEqual(e.observedAt!);
    }
  });

  it('records confirmations, touches, rejections, breaks, flips and score changes in order', () => {
    const r = replaySR({ instrumentId: 'GC', timeframe: 'H1', candles: F.supportToResistanceFlip(), tickSize: 0.1, settings: S });
    expect(r.violations).toEqual([]);
    const id = r.final.zones.find((z) => z.status === 'FLIPPED')!.id;
    const seq = r.events.filter((e) => e.zoneId === id).map((e) => e.type);
    const at = (t: string) => seq.indexOf(t as never);
    expect(at('zoneConfirmed')).toBe(0);
    expect(at('interactionStarted')).toBeGreaterThan(at('zoneConfirmed'));
    expect(at('broken')).toBeGreaterThan(at('interactionStarted'));
    expect(at('flipped')).toBeGreaterThan(at('broken'));
    expect(seq).toContain('scoreChanged');
    expect(seq).toContain('interactionResolved');
  });

  it('incremental bar-by-bar results equal a one-shot batch analysis', () => {
    const candles = randomWalk(260, { seed: 99, start: 1.085, vol: 0.0012 });
    const r = replaySR({ instrumentId: 'EURUSD', timeframe: 'M15', candles, tickSize: 0.00001, settings: S });
    const batch = analyzeTimeframe({ instrumentId: 'EURUSD', timeframe: 'M15', tickSize: 0.00001, settings: S, candles });
    expect(r.final).toEqual(batch);
  });

  it('future candles never rewrite what was confirmed in the past', () => {
    const candles = randomWalk(300, { seed: 5, start: 31.2, vol: 0.12 });
    const prefix = analyzeTimeframe({ instrumentId: 'XAGUSD', timeframe: 'H4', tickSize: 0.001, settings: S, candles: candles.slice(0, 180) });
    const full = analyzeTimeframe({ instrumentId: 'XAGUSD', timeframe: 'H4', tickSize: 0.001, settings: S, candles });
    const later = new Map(full.zones.map((z) => [z.id, z]));
    expect(prefix.zones.length).toBeGreaterThan(0);
    for (const z of prefix.zones) expect(frozen(later.get(z.id)!)).toEqual(frozen(z));
  });

  it('two different futures agree on everything confirmed before they diverge', () => {
    const shared = randomWalk(200, { seed: 11, start: 64000, vol: 180 });
    const futureA = randomWalk(80, { seed: 12, start: shared.at(-1)!.close, vol: 180 }).map((c, k) => ({ ...c, time: shared.at(-1)!.time + (k + 1) * 3600 }));
    const futureB = randomWalk(80, { seed: 13, start: shared.at(-1)!.close, vol: 400 }).map((c, k) => ({ ...c, time: shared.at(-1)!.time + (k + 1) * 3600 }));
    const a = analyzeTimeframe({ instrumentId: 'BTCUSD', timeframe: 'H1', tickSize: 0.01, settings: S, candles: [...shared, ...futureA] });
    const b = analyzeTimeframe({ instrumentId: 'BTCUSD', timeframe: 'H1', tickSize: 0.01, settings: S, candles: [...shared, ...futureB] });
    const cutoff = shared.at(-2)!.time; // last bar of `shared` counts as forming for a prefix-only run
    const confirmedA = a.zones.filter((z) => z.confirmedAt <= cutoff).map(frozen);
    const confirmedB = b.zones.filter((z) => z.confirmedAt <= cutoff).map(frozen);
    expect(confirmedA.length).toBeGreaterThan(0);
    expect(confirmedA).toEqual(confirmedB);
  });

  it('a revised historical bar triggers a deterministic rebuild', () => {
    const candles = randomWalk(200, { seed: 3, start: 2350, vol: 3 });
    const e = new SRTimeframeEngine({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: S });
    e.update(candles);
    const revised = candles.map((c, k) => (k === 60 ? { ...c, low: c.low - 15 } : c));
    e.update(revised);
    expect(e.snapshot()).toEqual(analyzeTimeframe({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: S, candles: revised }));
  });

  it('the forming bar never creates or confirms structure', () => {
    const candles = randomWalk(150, { seed: 21, start: 2350, vol: 3 });
    const e = new SRTimeframeEngine({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: S });
    e.update(candles);
    const before = e.snapshot();
    // Wildly different forming bar: only the current price may change.
    const wild = [...candles.slice(0, -1), { ...candles.at(-1)!, high: 9999, low: 1, close: 5000 }];
    e.update(wild);
    const after = e.snapshot();
    expect(after.zones.map(frozen)).toEqual(before.zones.map(frozen));
    expect(after.pivots).toEqual(before.pivots);
    expect(after.currentPrice).toBe(5000);
  });
});
