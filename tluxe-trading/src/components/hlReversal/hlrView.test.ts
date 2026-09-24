import { describe, expect, it } from 'vitest';
import { analyzeHighLowReversal } from '../../engines/hlReversal/engine';
import * as F from '../../engines/hlReversal/fixtures/scenarios';
import { activeSetup, defaultSetup, hlrOverlays, hlrViewState, listSetups, nextRequired, stages } from './hlrView';

const snap = (c = F.buyReversal()) => analyzeHighLowReversal({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: c });

describe('page state', () => {
  const s = snap();
  it.each([
    [{ connection: 'LIVE' as const }, 'LIVE'],
    [{ connection: 'DELAYED' as const }, 'LIVE'],
    [{ connection: 'LIVE' as const, feedCode: 'STALE' as const }, 'STALE'],
    [{ connection: 'DISCONNECTED' as const }, 'STALE'],
    [{ connection: 'LIVE' as const, feedCode: 'ERROR' as const }, 'ERROR'],
  ])('%o → %s', (o, want) => expect(hlrViewState({ tradable: true, snapshot: s, ...o })).toBe(want));
  it('offline without data → MARKET DATA OFFLINE; a missing timeframe → DEPENDENCY DATA UNAVAILABLE; short history → INSUFFICIENT HISTORY', () => {
    expect(hlrViewState({ tradable: true, connection: 'DISCONNECTED', snapshot: null })).toBe('OFFLINE');
    expect(hlrViewState({ tradable: true, connection: 'DISCONNECTED', snapshot: snap({}) })).toBe('OFFLINE');
    const noM1 = { ...F.buyReversal() };
    delete noM1.M1;
    expect(hlrViewState({ tradable: true, connection: 'LIVE', snapshot: snap(noM1) })).toBe('DEPENDENCY_UNAVAILABLE');
    const short = { ...F.buyReversal(), M15: F.buyReversal().M15!.slice(0, 20) };
    expect(hlrViewState({ tradable: true, connection: 'LIVE', snapshot: snap(short) })).toBe('INSUFFICIENT_HISTORY');
    expect(hlrViewState({ tradable: false, connection: 'LIVE', snapshot: s })).toBe('UNAVAILABLE');
  });
});

describe('list, sequence and overlays', () => {
  const s = snap();
  it('open list puts the most advanced setup first; history holds finished ones', () => {
    const e = snap(F.buyEntryReady());
    const open = listSetups(e.setups, { dir: 'ALL', tf: 'ALL' }, 'open');
    expect(open.every((x) => !['TRIGGERED', 'EXPIRED', 'INVALIDATED', 'MISSED', 'FAILED_RECLAIM'].includes(x.state))).toBe(true);
    expect(listSetups(s.setups, { dir: 'ALL', tf: 'ALL' }, 'history').some((x) => x.state === 'TRIGGERED')).toBe(true);
    expect(listSetups(s.setups, { dir: 'SELL', tf: 'ALL' }, 'history').every((x) => x.direction === 'SELL')).toBe(true);
  });
  it('the five stages reflect only recorded evidence; next required condition is explicit', () => {
    const t = s.setups.find((x) => x.state === 'TRIGGERED')!;
    expect(stages(t, s.h4, 2).map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    const noM5 = snap(F.reclaimNoM5()).setups.find((x) => x.state === 'EXPIRED' && x.reclaim)!;
    expect(stages(noM5, s.h4, 2).map((x) => x.status)).toEqual(['done', 'done', 'done', 'failed', 'failed']);
    const w = s.setups.find((x) => x.state === 'WATCHING_LEVEL')!;
    expect(nextRequired(w, 2)).toMatch(/M15 must trade (below|above)/);
    expect(activeSetup(s.setups)?.state).toBe('WATCHING_LEVEL');
    // With only a watched level open, the page follows the latest real (finished) setup instead.
    expect(defaultSetup(s.setups)?.state).toBe('TRIGGERED');
  });
  it('overlays: selected setup level (gold), M5 structure (blue), entry zone (purple), SL / TP lines; markers only for recorded events', () => {
    const t = s.setups.find((x) => x.state === 'TRIGGERED')!;
    const o = hlrOverlays({ levels: s.levels, setups: s.setups, selected: t, price: s.price, chartTf: 'M5', decimals: 2 });
    const kinds = o.drawables.map((x) => `${x.kind}:${x.tone}`);
    expect(kinds).toContain('level:gold');
    expect(kinds).toContain('structure:structure');
    expect(kinds).toContain('zone:zone');
    expect(kinds).toContain('stop:sell');
    expect(kinds).toContain('tp:buy');
    expect(o.markers.map((m) => m.text).join(' ')).toMatch(/SSL Sweep.*Reclaim|Reclaim/);
    expect(o.markers.every((m) => m.time % 300 === 0)).toBe(true);
    const none = hlrOverlays({ levels: s.levels, setups: s.setups, selected: null, price: s.price, chartTf: 'M5', decimals: 2 });
    expect(none.markers).toEqual([]);
    expect(none.drawables.every((x) => x.kind === 'level')).toBe(true);
  });
});
