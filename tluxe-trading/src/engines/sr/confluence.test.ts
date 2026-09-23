import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../../types/market';
import { buildMultiSnapshot } from './confluence';
import { analyzeTimeframe } from './engine';
import { mirror } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { DEFAULT_SR_SETTINGS, SCORE_WEIGHTS } from './settings';
import type { SRSnapshot } from './types';

const S = { ...DEFAULT_SR_SETTINGS };
const snap = (candles: Candle[], tf: Timeframe, id = 'GC'): SRSnapshot =>
  analyzeTimeframe({ instrumentId: id, timeframe: tf, tickSize: 0.1, settings: S, candles, lastBarClosed: true });

describe('multi-timeframe confluence', () => {
  it('14. H4 + H1 + M15 supports that really overlap form one confluence', () => {
    const multi = buildMultiSnapshot('GC', { H4: snap(F.h4SupportNear100(), 'H4'), H1: snap(F.strongSupport('H1'), 'H1'), M15: snap(F.strongSupport('M15'), 'M15') }, S);
    const cf = multi.confluences.find((c) => c.role === 'support' && c.overlapLow < 100 && c.overlapHigh > 99.5)!;
    expect(cf).toBeDefined();
    expect(cf.timeframes).toEqual(['H4', 'H1', 'M15']);
    expect(cf.zoneIds).toHaveLength(3);
    // Overlap region is the intersection of the participants.
    for (const m of cf.members) {
      expect(cf.overlapLow).toBeGreaterThanOrEqual(m.zoneLow - 1e-9);
      expect(cf.overlapHigh).toBeLessThanOrEqual(m.zoneHigh + 1e-9);
    }
    expect(cf.score).toBeGreaterThan(0);
    expect(cf.score).toBeLessThanOrEqual(100);
    // Members are rescored with the confluence component; others are not.
    const members = multi.zones.filter((z) => cf.zoneIds.includes(z.id));
    expect(members.every((z) => z.score.components.confluence === 100 && z.confluenceIds[0] === cf.id)).toBe(true);
    const base = snap(F.strongSupport('H1'), 'H1').zones.find((z) => z.id === cf.zoneIds[1])!;
    const after = members.find((z) => z.id === base.id)!;
    expect(after.score.total - base.score.total).toBe(Math.round(SCORE_WEIGHTS.confluence * 100 * after.score.statusFactor));
  });

  it('15. resistance confluence mirrors support confluence', () => {
    const multi = buildMultiSnapshot('GC', { H4: snap(mirror(F.h4SupportNear100(), 150), 'H4'), H1: snap(F.strongResistance('H1'), 'H1') }, S);
    const cf = multi.confluences.find((c) => c.role === 'resistance' && c.overlapLow < 200.5 && c.overlapHigh > 200)!;
    expect(cf.timeframes).toEqual(['H4', 'H1']);
  });

  it('never manufactures a higher-timeframe zone: only supplied timeframes participate', () => {
    const multi = buildMultiSnapshot('GC', { H1: snap(F.strongSupport('H1'), 'H1'), M15: snap(F.strongSupport('M15'), 'M15') }, S);
    expect(multi.zones.every((z) => z.timeframe === 'H1' || z.timeframe === 'M15')).toBe(true);
    expect(multi.confluences.every((c) => c.timeframes.every((tf) => tf === 'H1' || tf === 'M15'))).toBe(true);
  });

  it('same-timeframe overlaps and opposite roles never form confluence', () => {
    const multi = buildMultiSnapshot('GC', { H1: snap(F.strongSupport('H1'), 'H1') }, S);
    expect(multi.confluences).toEqual([]);
    const opposite = buildMultiSnapshot('GC', { H1: snap(F.strongSupport('H1'), 'H1'), H4: snap(mirror(F.h4SupportNear100(), 100), 'H4') }, S);
    expect(opposite.confluences.filter((c) => c.overlapLow < 100 && c.overlapHigh > 99.5)).toEqual([]);
  });

  it('ignores broken / expired zones and snapshots of other instruments', () => {
    const multi = buildMultiSnapshot('GC', { H1: snap(F.supportBreak(), 'H1'), H4: snap(F.h4SupportNear100(), 'H4', 'XAUUSD') }, S);
    expect(multi.confluences).toEqual([]);
    expect(multi.zones.every((z) => z.instrumentId === 'GC')).toBe(true);
  });

  it('is deterministic', () => {
    const make = () => buildMultiSnapshot('GC', { H4: snap(F.h4SupportNear100(), 'H4'), H1: snap(F.strongSupport('H1'), 'H1') }, S);
    expect(make()).toEqual(make());
  });
});
