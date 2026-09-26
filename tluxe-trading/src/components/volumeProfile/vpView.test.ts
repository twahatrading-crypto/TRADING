import { describe, expect, it } from 'vitest';
import { analyzeVolumeProfile } from '../../engines/volumeProfile/engine';
import { dataset } from '../../engines/volumeProfile/fixtures/builders';
import { DEFAULT_VP_TOGGLES, histogramOf, snapToBar, utcInputToSec, secToUtcInput, volumeSourceText, vpOverlays, vpViewState } from './vpView';

/* TEST DATA ONLY. */
const MT5 = { kind: 'spot-otc' as const, exchange: null };
const ds = dataset(5, 4);
const snap = analyzeVolumeProfile({ instrumentId: 'XAUUSD', tickSize: 0.01, instrument: MT5, candles: ds, currentPrice: ds.M5.at(-1)!.close });
const barTimes = ds.M15.map((c) => c.time);

describe('vpView', () => {
  it('histogram mirrors the engine rows exactly (no smoothing, no invented rows)', () => {
    const p = snap.profiles.PREVIOUS_DAY!;
    const h = histogramOf(p)!;
    expect(h.rows).toBe(p.rows);
    expect(h.max).toBe(Math.max(...p.rows.map((r) => r.volume)));
    expect([h.poc, h.vah, h.val]).toEqual([p.poc, p.vah, p.val]);
    expect(histogramOf(null)).toBeNull();
  });

  it('overlays follow the toggles; every line is an engine value', () => {
    const p = snap.profiles.DAILY!;
    const all = vpOverlays({ snapshot: snap, profile: p, smc: null, srZones: null, chartTf: 'M15', toggles: DEFAULT_VP_TOGGLES, decimals: 2, barTimes });
    expect(all.hist).not.toBeNull();
    expect(all.drawables.find((x) => x.id === 'vp:poc')!.high).toBe(p.poc);
    expect(all.drawables.find((x) => x.id === 'vp:vah')!.high).toBe(p.vah);
    expect(all.drawables.find((x) => x.id === 'vp:pd:poc')!.high).toBe(snap.profiles.PREVIOUS_DAY!.poc);
    const none = vpOverlays({ snapshot: snap, profile: p, smc: null, srZones: null, chartTf: 'M15', toggles: Object.fromEntries(Object.keys(DEFAULT_VP_TOGGLES).map((k) => [k, false])) as typeof DEFAULT_VP_TOGGLES, decimals: 2, barTimes });
    expect(none.hist).toBeNull();
    expect(none.drawables).toHaveLength(0);
    for (const m of all.markers) expect(barTimes).toContain(m.time);
  });

  it('snapToBar maps a close time onto the bar that produced it', () => {
    expect(snapToBar([0, 900, 1800], 1800)).toBe(900);
    expect(snapToBar([0, 900, 1800], 1801)).toBe(1800);
    expect(snapToBar([900], 900)).toBeNull();
  });

  it('source label never upgrades tick volume; GC without provider is unavailable', () => {
    expect(volumeSourceText({ snapshot: snap, profile: snap.profiles.DAILY!, symbol: 'XAUUSD', isFuture: false }).label).toBe('MT5 Tick Volume');
    expect(volumeSourceText({ snapshot: null, profile: null, symbol: 'GC', isFuture: true })).toEqual({ label: 'GC VOLUME DATA UNAVAILABLE', unavailable: true });
    expect(volumeSourceText({ snapshot: null, profile: null, symbol: 'XAUUSD', isFuture: false }).label).toBe('VOLUME DATA UNAVAILABLE');
  });

  it('view state is LIVE only with a live feed and a real profile', () => {
    const p = snap.profiles.DAILY!;
    expect(vpViewState({ feed: 'LIVE', snapshot: snap, profile: p, replay: false, hasProvider: true })).toBe('LIVE');
    expect(vpViewState({ feed: 'LIVE', snapshot: snap, profile: p, replay: false, hasProvider: false })).toBe('UNAVAILABLE');
    expect(vpViewState({ feed: 'STALE', snapshot: snap, profile: p, replay: false, hasProvider: true })).toBe('STALE');
    expect(vpViewState({ feed: 'LIVE', snapshot: snap, profile: null, replay: false, hasProvider: true })).toBe('INSUFFICIENT_DATA');
    expect(vpViewState({ feed: 'LIVE', snapshot: snap, profile: { ...p, source: { ...p.source, mode: 'NONE' } }, replay: false, hasProvider: true })).toBe('VOLUME_UNAVAILABLE');
  });

  it('fixed-range inputs are UTC', () => {
    expect(utcInputToSec('2026-01-05T00:00')).toBe(Date.UTC(2026, 0, 5) / 1000);
    expect(secToUtcInput(Date.UTC(2026, 0, 5, 13, 30) / 1000)).toBe('2026-01-05T13:30');
    expect(utcInputToSec('')).toBeNull();
  });
});
