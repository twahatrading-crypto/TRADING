import { describe, expect, it } from 'vitest';
import { hleDecision } from '../../engines/highLowEngine/decision';
import { analyzeHighLow } from '../../engines/highLowEngine/engine';
import * as F from '../../engines/highLowEngine/fixtures/scenarios';
import { hleFeedOf } from '../../services/highLowEngine/feed';
import { headline, hleOverlays, hleViewState, pipeline } from './hleView';

const snap = (c = F.buyReversal()) => analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: c });
const ALL = { levels: true, liquidity: true, sweeps: true, structure: true, risk: true };

describe('High / Low Engine view', () => {
  it('page state is truthful: OFFLINE / INSUFFICIENT DATA / DEPENDENCY / STALE / LIVE — a delayed feed is never LIVE', () => {
    const s = snap();
    expect(hleViewState({ tradable: true, connection: 'DISCONNECTED', snapshot: null })).toBe('OFFLINE');
    expect(hleViewState({ tradable: true, connection: 'LIVE', snapshot: s })).toBe('LIVE');
    expect(hleViewState({ tradable: true, connection: 'DELAYED', snapshot: s })).toBe('STALE');
    expect(hleViewState({ tradable: true, connection: 'LIVE', feedCode: 'STALE', snapshot: s })).toBe('STALE');
    expect(hleViewState({ tradable: true, connection: 'DISCONNECTED', snapshot: s })).toBe('STALE');
    const noM1 = { ...F.buyReversal() };
    delete noM1.M1;
    expect(hleViewState({ tradable: true, connection: 'LIVE', snapshot: snap(noM1) })).toBe('DEPENDENCY_UNAVAILABLE');
    expect(hleViewState({ tradable: true, connection: 'LIVE', snapshot: snap({ ...F.buyReversal(), M15: F.buyReversal().M15!.slice(0, 10) }) })).toBe('INSUFFICIENT_DATA');
  });
  it('feed gate: only a fresh feed is LIVE; bridge offline / terminal disconnected never counts as live', () => {
    expect(hleFeedOf('LIVE', 'LIVE')).toBe('LIVE');
    expect(hleFeedOf('LIVE', 'STALE')).toBe('STALE');
    expect(hleFeedOf('DISCONNECTED', 'MT5_BRIDGE_OFFLINE')).toBe('DISCONNECTED');
    expect(hleFeedOf('DISCONNECTED', 'ERROR')).toBe('DISCONNECTED');
    expect(hleFeedOf('DISCONNECTED', 'MT5_NOT_RUNNING')).toBe('DISCONNECTED');
    expect(hleFeedOf('DELAYED', null)).toBe('STALE');
  });
  it('pipeline boxes follow the engine stage; the last box lights only on the real live confirmation', () => {
    const s = snap();
    const d = hleDecision(s, 'LIVE');
    expect(pipeline(s.candidates.BUY, 'BUY', d.confirmed).map((x) => x.state)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'DONE']);
    expect(pipeline(s.candidates.BUY, 'BUY', false).map((x) => x.state)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'ACTIVE']);
    const noM5 = snap(F.breakNoReclaim());
    expect(pipeline({ ...noM5.candidates.BUY, stage: 1, invalidated: true }, 'BUY', false).map((x) => x.state)).toEqual(['DEAD', 'PENDING', 'PENDING', 'PENDING', 'PENDING']);
    expect(pipeline(null, 'SELL', false).every((x) => x.state === 'PENDING')).toBe(true);
  });
  it('overlays: engine outputs only; Entry / SL / TP appear only when confirmed on a live feed; toggles respected', () => {
    const s = snap();
    const live = hleDecision(s, 'LIVE');
    const o = hleOverlays({ levels: s.levels, setup: live.setup, decision: live, chartTf: 'M15', decimals: 2, tools: ALL });
    expect(o.drawables.some((x) => x.kind === 'zone')).toBe(true);
    expect(o.drawables.some((x) => x.kind === 'structure')).toBe(true);
    expect(o.markers.map((m) => m.text).join(' ')).toMatch(/SSL Sweep/);
    const stale = hleDecision(s, 'STALE');
    const w = hleOverlays({ levels: s.levels, setup: stale.setup, decision: stale, chartTf: 'M15', decimals: 2, tools: ALL });
    expect(w.drawables.some((x) => x.kind === 'zone' || x.kind === 'stop' || x.kind === 'tp')).toBe(false);
    const off = hleOverlays({ levels: s.levels, setup: live.setup, decision: live, chartTf: 'M15', decimals: 2, tools: { levels: false, liquidity: false, sweeps: false, structure: false, risk: false } });
    expect(off.drawables).toEqual([]);
    expect(off.markers).toEqual([]);
    const h = headline(s.levels);
    expect(h.ASIA_HIGH?.type).toBe('ASIA_HIGH');
    expect(h.MAJOR_LOW?.major).toBe(true);
  });
});
