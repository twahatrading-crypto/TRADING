import { describe, expect, it } from 'vitest';
import { analyzeVolumeProfile } from '../../engines/volumeProfile/engine';
import { dataset } from '../../engines/volumeProfile/fixtures/builders';
import { DEFAULT_VP_TOGGLES, VP_TOGGLE_GROUPS, VP_TOGGLE_LABELS, declutterMarkers, engineBadge, histogramOf, markerGapBars, snapToBar, sourceBadge, utcInputToSec, secToUtcInput, volumeSourceText, vpOverlays, vpViewState, type VPMarker } from './vpView';

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

  it('a window with no closed candle yet (session just opened) reports the real source, not "unavailable"', () => {
    const empty = { ...snap.profiles.DAILY!, bars: 0, poc: null, source: { mode: 'NONE' as const, label: 'VOLUME DATA UNAVAILABLE', detail: 'No closed candles for this profile.', usedBars: 0, missingBars: 0 } };
    const s = { ...snap, unavailable: 'XAUUSD VOLUME DATA UNAVAILABLE' };
    expect(volumeSourceText({ snapshot: s, profile: empty, symbol: 'XAUUSD', isFuture: false })).toEqual({ label: 'MT5 Tick Volume · no closed candle in this window yet', unavailable: false });
    expect(vpViewState({ feed: 'LIVE', snapshot: s, profile: empty, replay: false, hasProvider: true })).toBe('INSUFFICIENT_DATA');
    // Profiles WITH bars but no volume stay unavailable.
    const noVol = { ...s, profiles: {}, mtf: s.mtf.map((m) => ({ ...m, source: { ...m.source, mode: 'NONE' as const } })) };
    expect(volumeSourceText({ snapshot: noVol, profile: empty, symbol: 'XAUUSD', isFuture: false }).unavailable).toBe(true);
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

  it('marker declutter: same-side markers never closer than the gap; hidden ones are counted, never lost', () => {
    const times = Array.from({ length: 40 }, (_, i) => 1000 + i * 900);
    const mk = (i: number, text: string, position: VPMarker['position'] = 'aboveBar'): VPMarker => ({ time: times[i]!, position, shape: 'circle', color: '#fff', text });
    const input = [mk(10, 'POC SHIFT'), mk(11, 'NEW POC'), mk(12, 'VAH TEST'), mk(11, 'RE-ENTRY', 'belowBar'), mk(12, 'VAL TEST', 'belowBar'), mk(30, 'POC SHIFT')];
    const out = declutterMarkers(input, times, 4);
    const idx = (m: VPMarker) => times.indexOf(m.time);
    for (const pos of ['aboveBar', 'belowBar'] as const) {
      const side = out.filter((m) => m.position === pos).map(idx).sort((a, b) => a - b);
      for (let i = 1; i < side.length; i++) expect(side[i]! - side[i - 1]!).toBeGreaterThanOrEqual(4);
    }
    // Higher-importance labels win; the merged count keeps every event accounted for.
    expect(out.find((m) => idx(m) === 11 && m.position === 'aboveBar')?.text).toBe('NEW POC +2');
    expect(out.find((m) => m.position === 'belowBar')?.text).toBe('RE-ENTRY +1');
    const total = out.reduce((n, m) => n + 1 + Number(/\+(\d+)$/.exec(m.text)?.[1] ?? 0), 0);
    expect(total).toBe(input.length);
    expect(declutterMarkers(input, times, 4)).toEqual(out); // deterministic
    expect(declutterMarkers(input, times, 1)).toHaveLength(input.length); // gap 1: nothing merged
    expect(markerGapBars(64)).toBe(1);
    expect(markerGapBars(8)).toBe(8);
  });

  it('badges: concise provenance, MT5 tick volume is never called exchange volume', () => {
    expect(sourceBadge('DATABENTO / GLBX.MDP3 / CME/COMEX / REAL VOLUME')).toBe('DATABENTO · CME REAL VOLUME');
    expect(sourceBadge('MT5 Tick Volume')).toBe('MT5 TICK VOL');
    expect(sourceBadge('MT5 Real Volume (broker-reported)')).toBe('MT5 REAL VOL');
    expect(sourceBadge('GC VOLUME DATA UNAVAILABLE')).toBe('NO VOLUME');
    expect(sourceBadge('MT5 Tick Volume')).not.toMatch(/EXCHANGE|CME|COMEX/);
    expect(['S&R engine', 'Liquidity engine (via SMC)', 'Order Block engine (via SMC)', 'SMC engine'].map(engineBadge)).toEqual(['S&R', 'LIQUIDITY', 'ORDER BLOCKS', 'SMC']);
  });

  it('overlay groups cover every toggle exactly once (same keys and defaults as before)', () => {
    const keys = VP_TOGGLE_GROUPS.flatMap((g) => g.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(VP_TOGGLE_LABELS.map(([k]) => k).sort());
    expect(VP_TOGGLE_GROUPS.map((g) => g.title)).toEqual(['PROFILE', 'CONFLUENCE']);
  });
});
