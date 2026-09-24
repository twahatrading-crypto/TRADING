import { describe, expect, it } from 'vitest';
import { analyzeHighLow } from '../../engines/highLowEngine/engine';
import * as F from '../../engines/highLowEngine/fixtures/scenarios';
import { focusSetup, hleOverlays, hleViewState, latestByType, sequence } from './hleView';

const snap = (c = F.buyReversal()) => analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: c });
const ALL = { levels: true, liquidity: true, sweeps: true, structure: true, risk: true };

describe('High / Low Engine view', () => {
  it('page state is truthful: OFFLINE / INSUFFICIENT DATA / DEPENDENCY / STALE / LIVE', () => {
    const s = snap();
    expect(hleViewState({ tradable: true, connection: 'DISCONNECTED', snapshot: null })).toBe('OFFLINE');
    expect(hleViewState({ tradable: true, connection: 'LIVE', snapshot: s })).toBe('LIVE');
    expect(hleViewState({ tradable: true, connection: 'DISCONNECTED', snapshot: s })).toBe('STALE');
    const noM1 = { ...F.buyReversal() };
    delete noM1.M1;
    expect(hleViewState({ tradable: true, connection: 'LIVE', snapshot: snap(noM1) })).toBe('DEPENDENCY_UNAVAILABLE');
    expect(hleViewState({ tradable: true, connection: 'LIVE', snapshot: snap({ ...F.buyReversal(), M15: F.buyReversal().M15!.slice(0, 10) }) })).toBe('INSUFFICIENT_DATA');
  });
  it('sequence steps change only with real evidence; failed stages are marked', () => {
    const s = snap();
    const full = s.setups.find((x) => x.entry)!;
    expect(sequence(full).steps.map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    const noM5 = snap(F.reclaimNoM5()).setups.find((x) => x.reclaim)!;
    expect(sequence(noM5).steps.map((x) => x.status)).toEqual(['done', 'done', 'failed', 'failed', 'failed']);
    expect(sequence(null).steps.every((x) => x.status === 'pending')).toBe(true);
    expect(focusSetup(s.setups, s.price)?.id).toBe(full.id);
  });
  it('overlays draw only engine outputs and respect the tools toggles', () => {
    const s = snap();
    const full = s.setups.find((x) => x.entry)!;
    const o = hleOverlays({ levels: s.levels, selected: full, chartTf: 'M15', decimals: 2, tools: ALL });
    expect(o.drawables.some((x) => x.kind === 'zone')).toBe(true);
    expect(o.drawables.some((x) => x.kind === 'structure')).toBe(true);
    expect(o.markers.map((m) => m.text).join(' ')).toMatch(/SSL Sweep/);
    const off = hleOverlays({ levels: s.levels, selected: full, chartTf: 'M15', decimals: 2, tools: { levels: false, liquidity: false, sweeps: false, structure: false, risk: false } });
    expect(off.drawables).toEqual([]);
    expect(off.markers).toEqual([]);
    const by = latestByType(s.levels);
    expect(by.ASIA_HIGH?.type).toBe('ASIA_HIGH');
  });
});
