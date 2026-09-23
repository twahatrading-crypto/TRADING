import { describe, expect, it } from 'vitest';
import { buildMultiSnapshot } from '../../engines/sr/confluence';
import { analyzeTimeframe } from '../../engines/sr/engine';
import * as F from '../../engines/sr/fixtures/scenarios';
import { DEFAULT_SR_SETTINGS } from '../../engines/sr/settings';
import { chartDrawables, filterZones, sortZones, srViewState, tableRows, zoneLabel } from './srView';

const S = { ...DEFAULT_SR_SETTINGS };
const snap = (tf: 'H1' | 'M15' | 'H4', c = tf === 'H4' ? F.h4SupportNear100() : F.supportToResistanceFlip()) =>
  analyzeTimeframe({ instrumentId: 'GC', timeframe: tf, tickSize: 0.1, settings: S, candles: c, lastBarClosed: true });
const multi = buildMultiSnapshot('GC', { H1: snap('H1'), M15: snap('M15', F.strongSupport('M15')), H4: snap('H4') }, S);

describe('srViewState', () => {
  it('is NOT_CONNECTED without candles and a disconnected feed', () => {
    expect(srViewState({ tradable: true, connection: 'UNAVAILABLE', snapshots: [undefined] })).toBe('NOT_CONNECTED');
  });
  it('is INSUFFICIENT_HISTORY when connected without enough candles', () => {
    expect(srViewState({ tradable: true, connection: 'LIVE', snapshots: [undefined] })).toBe('INSUFFICIENT_HISTORY');
    const few = analyzeTimeframe({ instrumentId: 'GC', timeframe: 'H1', tickSize: 0.1, settings: S, candles: F.strongSupport().slice(0, 20) });
    expect(srViewState({ tradable: true, connection: 'DISCONNECTED', snapshots: [few] })).toBe('INSUFFICIENT_HISTORY');
  });
  it('is READY when any requested timeframe is ready; CATEGORY for non-tradable', () => {
    expect(srViewState({ tradable: true, connection: 'UNAVAILABLE', snapshots: [undefined, snap('H1')] })).toBe('READY');
    expect(srViewState({ tradable: false, connection: 'LIVE', snapshots: [snap('H1')] })).toBe('CATEGORY');
  });
});

describe('filtering and sorting are view-only', () => {
  it('filters by type / timeframe / status; ALL hides EXPIRED', () => {
    expect(filterZones(multi.zones, { type: 'support', tf: 'ALL', status: 'ALL' }).every((z) => z.role === 'support')).toBe(true);
    expect(filterZones(multi.zones, { type: 'all', tf: 'H4', status: 'ALL' }).every((z) => z.timeframe === 'H4')).toBe(true);
    expect(filterZones(multi.zones, { type: 'all', tf: 'ALL', status: 'BROKEN' }).every((z) => z.status === 'BROKEN')).toBe(true);
    expect(filterZones(multi.zones, { type: 'all', tf: 'ALL', status: 'ALL' }).some((z) => z.status === 'EXPIRED')).toBe(false);
  });

  it('sorts without mutating the engine zones', () => {
    const before = structuredClone(multi.zones);
    const asc = sortZones(multi.zones, { key: 'score', dir: 'asc' });
    expect(asc.map((z) => z.score.total)).toEqual([...asc.map((z) => z.score.total)].sort((a, b) => a - b));
    expect(multi.zones).toEqual(before);
  });

  it('ALL TF shows the relevant subset, "show all" shows everything', () => {
    const f = { type: 'all', tf: 'ALL', status: 'ALL' } as const;
    const some = tableRows(multi.zones, f, { ...S, maxDisplayedZones: 3 }, false);
    const all = tableRows(multi.zones, f, { ...S, maxDisplayedZones: 3 }, true);
    expect(some.rows.length).toBeLessThanOrEqual(3);
    expect(all.rows.length).toBe(all.total);
    expect(some.total).toBe(all.total);
  });
});

describe('chart drawables', () => {
  it('labels zones like "H4 SUPPORT | 82" / "2 touches | FRESH" from engine values', () => {
    const z = multi.zones[0]!;
    const { label, sublabel } = zoneLabel(z);
    expect(label).toBe(`${z.timeframe} ${z.role === 'support' ? 'SUPPORT' : 'RESISTANCE'} | ${z.score.total}`);
    expect(sublabel).toBe(`${z.touchCount} ${z.touchCount === 1 ? 'touch' : 'touches'} | ${z.status}`);
  });

  it('always includes the selected zone and highlights confluence members, dimming others', () => {
    const cf = multi.confluences[0]!;
    const broken = multi.zones.find((z) => z.status === 'BROKEN')!;
    const d = chartDrawables({ zones: multi.zones, filters: { type: 'all', tf: 'ALL', status: 'ALL' }, settings: S, selectedZoneId: broken.id, confluence: cf });
    expect(d.find((x) => x.id === broken.id)?.selected).toBe(true);
    for (const id of cf.zoneIds) expect(d.find((x) => x.id === id)?.highlighted).toBe(true);
    expect(d.filter((x) => !x.highlighted && !x.selected).every((x) => x.dimmed)).toBe(true);
    expect(d.every((x) => x.low < x.high)).toBe(true);
  });

  it('higher timeframes get more visual emphasis', () => {
    const d = chartDrawables({ zones: multi.zones, filters: { type: 'all', tf: 'ALL', status: 'ALL' }, settings: { ...S, minDisplayScore: 0 }, selectedZoneId: null, confluence: null });
    const h4 = d.find((x) => x.label.startsWith('H4'));
    const m15 = d.find((x) => x.label.startsWith('M15'));
    expect(h4!.emphasis).toBeGreaterThan(m15!.emphasis);
  });
});
