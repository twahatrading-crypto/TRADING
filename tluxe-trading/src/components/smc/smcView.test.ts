import { describe, expect, it } from 'vitest';
import { analyzeSmc } from '../../engines/smc/engine';
import * as S from '../../engines/smc/fixtures/scenarios';
import { DEFAULT_SMC_TOGGLES, SMC_TOGGLE_LABELS, smcOverlays, smcViewState, type SmcToggles } from './smcView';

/* TEST DATA ONLY. */
const snap = analyzeSmc({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: { M15: S.bullishReversal() } });

describe('smcView overlays (engine output only)', () => {
  it('every drawable and marker corresponds to an engine object of the chart timeframe', () => {
    const all = Object.fromEntries(SMC_TOGGLE_LABELS.map(([k]) => [k, true])) as SmcToggles;
    const { drawables, markers } = smcOverlays({ snapshot: snap, chartTf: 'M15', toggles: all, decimals: 2 });
    const tf = snap.byTimeframe.M15!;
    const ids = new Set([...tf.swings, ...tf.breaks, ...tf.fvgs, ...tf.inducements, ...tf.orderBlocks, ...tf.liquidity].map((x) => x.id));
    for (const d of drawables) {
      const m = /^smc:(?:brk|ob|fvg|lq|idm|ref):(.+)$/.exec(d.id);
      if (m) expect(ids.has(m[1]!)).toBe(true);
      else expect(['smc:path', 'smc:pd:prem', 'smc:pd:disc', 'smc:pd:eq']).toContain(d.id);
    }
    const times = new Set([...tf.swings.map((w) => w.originTime), ...tf.sweeps.map((w) => w.time), ...tf.displacements.map((x) => x.confirmedAt)]);
    for (const k of markers) expect(times.has(k.time)).toBe(true);
    expect(drawables.some((d) => d.label.includes('CHOCH'))).toBe(true);
  });

  it('all toggles off → nothing drawn; no snapshot → nothing drawn', () => {
    const off = Object.fromEntries(SMC_TOGGLE_LABELS.map(([k]) => [k, false])) as SmcToggles;
    expect(smcOverlays({ snapshot: snap, chartTf: 'M15', toggles: off, decimals: 2 })).toEqual({ drawables: [], markers: [] });
    expect(smcOverlays({ snapshot: null, chartTf: 'M15', toggles: DEFAULT_SMC_TOGGLES, decimals: 2 })).toEqual({ drawables: [], markers: [] });
  });

  it('view state is LIVE only for a live feed with a READY chart timeframe', () => {
    const tf = snap.byTimeframe.M15!;
    expect(smcViewState({ feed: 'LIVE', tf, replay: false, hasProvider: true })).toBe('LIVE');
    expect(smcViewState({ feed: 'STALE', tf, replay: false, hasProvider: true })).toBe('STALE');
    expect(smcViewState({ feed: 'DISCONNECTED', tf, replay: false, hasProvider: true })).toBe('UNAVAILABLE');
    expect(smcViewState({ feed: 'LIVE', tf, replay: false, hasProvider: false })).toBe('UNAVAILABLE');
    expect(smcViewState({ feed: 'LIVE', tf: snap.byTimeframe.H1, replay: false, hasProvider: true })).toBe('INSUFFICIENT_DATA');
  });
});
