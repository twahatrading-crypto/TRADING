import { describe, expect, it } from 'vitest';
import { summarize } from './analysis';
import { buildMultiSnapshot } from './confluence';
import { selectDisplayZones } from './display';
import { analyzeTimeframe } from './engine';
import * as F from './fixtures/scenarios';
import { finalizeScore, STATUS_FACTOR } from './scoring';
import { DEFAULT_SR_SETTINGS, SCORE_WEIGHTS, SR_SETTING_SPECS, sanitizeSettings, TIMEFRAME_SIGNIFICANCE } from './settings';
import { ZONE_TRANSITIONS } from './stateMachine';
import { ZONE_STATUSES } from './types';

const S = { ...DEFAULT_SR_SETTINGS };
const snap = (c = F.strongSupport()) => analyzeTimeframe({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: S, candles: c, lastBarClosed: true });

describe('scoring', () => {
  it('weights are documented and sum to 1', () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Object.keys(SCORE_WEIGHTS)).toEqual(['timeframe', 'reaction', 'touchQuality', 'freshness', 'structure', 'confluence']);
  });

  it('total = round(Σ weight × component × status factor), clamped 0–100', () => {
    for (const z of snap().zones) {
      const expected = Math.round(
        Math.min(100, Math.max(0, Object.entries(SCORE_WEIGHTS).reduce((a, [k, w]) => a + w * z.score.components[k as keyof typeof SCORE_WEIGHTS], 0) * STATUS_FACTOR[z.status])),
      );
      expect(z.score.total).toBe(expected);
      for (const v of Object.values(z.score.components)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    expect(finalizeScore({ timeframe: 100, reaction: 100, touchQuality: 100, freshness: 100, structure: 100, confluence: 100 }, 'FRESH').total).toBe(100);
    expect(finalizeScore({ timeframe: 0, reaction: 0, touchQuality: 0, freshness: 0, structure: 0, confluence: 0 }, 'FRESH').total).toBe(0);
  });

  it('timeframe significance rises with timeframe', () => {
    const v = Object.values(TIMEFRAME_SIGNIFICANCE);
    expect([...v].sort((a, b) => a - b)).toEqual(v);
  });

  it('broken zones score far lower than holding ones', () => {
    const broken = snap(F.supportBreak()).zones.find((z) => z.status === 'BROKEN' && z.zoneLow < 100 && z.zoneHigh > 99.5)!;
    const holding = snap().zones.find((z) => z.zoneLow < 100 && z.zoneHigh > 99.5)!;
    expect(broken.score.total).toBeLessThan(holding.score.total / 2);
  });
});

describe('state machine table', () => {
  it('covers every status; EXPIRED is terminal', () => {
    expect(Object.keys(ZONE_TRANSITIONS).sort()).toEqual([...ZONE_STATUSES].sort());
    expect(ZONE_TRANSITIONS.EXPIRED).toEqual([]);
  });
});

describe('display selection (ALL TF) is display-only', () => {
  it('filters, ranks and caps without mutating engine zones', () => {
    const multi = buildMultiSnapshot('GC', { H1: snap(F.supportToResistanceFlip()), M15: analyzeTimeframe({ instrumentId: 'GC', timeframe: 'M15', tickSize: 0.1, settings: S, candles: F.strongSupport('M15'), lastBarClosed: true }) }, S);
    const copy = structuredClone(multi.zones);
    const shown = selectDisplayZones(multi.zones, { minDisplayScore: 0, maxDisplayedZones: 3 });
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(shown.some((z) => z.status === 'BROKEN' || z.status === 'EXPIRED')).toBe(false);
    expect(multi.zones).toEqual(copy);
    expect(selectDisplayZones(multi.zones, { minDisplayScore: 101, maxDisplayedZones: 12 })).toEqual([]);
  });

  it('suppresses a lower-ranked zone that heavily overlaps a shown same-role zone', () => {
    const h1 = snap();
    const m15 = analyzeTimeframe({ instrumentId: 'GC', timeframe: 'M15', tickSize: 0.1, settings: S, candles: F.strongSupport('M15'), lastBarClosed: true });
    const shown = selectDisplayZones([...h1.zones, ...m15.zones], { minDisplayScore: 0, maxDisplayedZones: 40 });
    const at100 = shown.filter((z) => z.role === 'support' && z.zoneLow < 100 && z.zoneHigh > 99.5);
    expect(at100).toHaveLength(1);
  });
});

describe('analysis facts', () => {
  it('reports nearest / strongest zones and never a trade direction', () => {
    const s = snap();
    const facts = summarize(s.zones, [], s.currentPrice, S);
    expect(facts.price).toBe(s.currentPrice);
    expect(facts.nearestSupport?.role).toBe('support');
    expect(facts.nearestSupport!.zoneHigh).toBeLessThan(s.currentPrice!);
    if (facts.nearestResistance) expect(facts.nearestResistance.zoneLow).toBeGreaterThan(s.currentPrice!);
    expect(JSON.stringify(Object.keys(facts))).not.toMatch(/buy|sell|long|short/i);
  });

  it('is empty without a price', () => {
    expect(summarize(snap().zones, [], null, S).nearestSupport).toBeNull();
  });
});

describe('settings', () => {
  it('sanitises into documented bounds and falls back to defaults', () => {
    const s = sanitizeSettings({ pivotRight: 999, atrPeriod: -3, freshnessDecay: Number.NaN, zoneWidthMethod: 'bogus' as never });
    expect(s.pivotRight).toBe(SR_SETTING_SPECS.pivotRight.max);
    expect(s.atrPeriod).toBe(SR_SETTING_SPECS.atrPeriod.min);
    expect(s.freshnessDecay).toBe(DEFAULT_SR_SETTINGS.freshnessDecay);
    expect(s.zoneWidthMethod).toBe('wickBody');
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SR_SETTINGS);
  });

  it('every default lies inside its bounds', () => {
    for (const [k, spec] of Object.entries(SR_SETTING_SPECS)) {
      const v = DEFAULT_SR_SETTINGS[k as keyof typeof SR_SETTING_SPECS];
      expect(v).toBeGreaterThanOrEqual(spec.min);
      expect(v).toBeLessThanOrEqual(spec.max);
    }
  });
});
