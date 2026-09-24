import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HLE_SETTINGS, HLE_TIMEFRAMES } from '../../engines/highLowEngine/config';
import { analyzeHighLow, type HLEInput } from '../../engines/highLowEngine/engine';
import * as F from '../../engines/highLowEngine/fixtures/scenarios';
import { analyzeHLEAt, hleKnownInput, type HLEDataset } from '../../engines/highLowEngine/knowledge';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import { HighLowAlerts } from './alerts';
import { HighLowReplaySession } from './HighLowReplay';
import { runHighLowAudit } from './replayAudit';
import { SignalLog } from './signalLog';

const ds: HLEDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...DEFAULT_HLE_SETTINGS }, candles: F.buyReversal() };
const norm = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'price' || k === 'distance' ? null : x));
const keySetup = () => analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: F.buyReversal() }).setups.find((s) => s.entry)!;

describe('High / Low Engine replay + Verify No-Repaint', () => {
  it('every visited step matches a clean recomputation (parity), forward / back / jumps', () => {
    const r = new HighLowReplaySession(ds, 'M5', { startIndex: 60, verify: true });
    for (const m of [1, 1, 6, -3, 40, -60, 90, 1, -1, 15]) {
      if (Math.abs(m) === 1) r.step(m);
      else r.seek(r.store.getState().cursor + m);
      const s = r.store.getState();
      expect(s.parity).toEqual({ ok: true, mismatches: [] });
      expect(norm(s.snapshot)).toBe(norm(analyzeHLEAt(ds, s.knowledgeTime!)));
    }
  });
  it('ENTRY READY appears in replay exactly on the M1 close that proves it', () => {
    const s = keySetup();
    const idx = ds.candles.M1!.findIndex((c) => c.time === s.entry!.time);
    const r = new HighLowReplaySession(ds, 'M1', { startIndex: idx - 1 });
    expect(r.store.getState().snapshot!.setups.find((x) => x.id === s.id)!.state).toBe('WAITING_M1');
    r.step(1);
    expect(r.store.getState().snapshot!.setups.find((x) => x.id === s.id)!.state).toBe('ENTRY_READY');
  });
  it('Verify No-Repaint runner: PASS with no first mismatch', async () => {
    const rep = await runHighLowAudit(ds, 'M15');
    expect(rep.passed).toBe(true);
    expect(rep.firstMismatch).toBeNull();
  });
});

describe('signal log and alerts', () => {
  it('log merges by deterministic id: repeated polling adds nothing; persisted across instances (refresh)', () => {
    const storage = memoryStorage({});
    const events = analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: F.buyReversal() }).events;
    const a = new SignalLog(storage);
    const n1 = a.merge('XAUUSD', events).length;
    expect(a.merge('XAUUSD', events).length).toBe(n1);
    expect(a.merge('XAUUSD', [...events].reverse()).length).toBe(n1);
    expect(new SignalLog(storage).get('XAUUSD').map((e) => e.id)).toEqual(a.get('XAUUSD').map((e) => e.id));
    expect(new SignalLog(storage).get('XAGUSD')).toEqual([]);
  });
  it('entry alert fires once on the live transition into ENTRY_READY — never on load, never repeated, never for old history', () => {
    const s = keySetup();
    const sounds: number[] = [];
    let now = s.entry!.knownAt * 1000 + 30_000;
    const storage = memoryStorage({});
    const mk = () => new HighLowAlerts(storage, { sound: () => (sounds.push(1), true), desktop: () => true, permission: () => 'granted', now: () => now });
    const before = analyzeHLEAt(ds, s.entry!.knownAt - 60);
    const at = analyzeHLEAt(ds, s.entry!.knownAt);
    const al = mk();
    expect(al.observe('XAUUSD', before)).toEqual([]); // seed
    expect(al.observe('XAUUSD', at)).toEqual([s.id]);
    expect(al.observe('XAUUSD', at)).toEqual([]);
    expect(sounds).toHaveLength(1);
    expect(al.store.getState().last?.channels).toEqual(['sound', 'desktop']);
    // Refresh: a new instance seeing the same ready setup does not alert again.
    const al2 = mk();
    al2.observe('XAUUSD', before);
    expect(al2.observe('XAUUSD', at)).toEqual([]);
    // Old history: a transition observed long after the fact does not alert.
    now = s.entry!.knownAt * 1000 + 60 * 60 * 1000;
    const al3 = new HighLowAlerts(memoryStorage({}), { sound: () => true, desktop: () => true, permission: () => 'granted', now: () => now });
    al3.observe('XAUUSD', before);
    expect(al3.observe('XAUUSD', at)).toEqual([]);
  });
  it('ALARM OFF suppresses sound / desktop but still de-duplicates; email is never faked', () => {
    const s = keySetup();
    const al = new HighLowAlerts(memoryStorage({}), { sound: () => true, desktop: () => true, permission: () => 'granted', now: () => s.entry!.knownAt * 1000 });
    al.setAlarm(false);
    al.observe('XAUUSD', analyzeHLEAt(ds, s.entry!.knownAt - 60));
    al.observe('XAUUSD', analyzeHLEAt(ds, s.entry!.knownAt));
    expect(al.store.getState().last?.channels).toEqual([]);
    expect(al.store.getState().email).toBe('not-configured');
  });
});

describe('High / Low Engine service', () => {
  const feed = (provider: ManualPriceProvider, id: string, data: HLEInput, formingLast?: 'M5') =>
    act(() => {
      provider.sink.connection(id, 'LIVE');
      for (const tf of HLE_TIMEFRAMES) provider.sink.candles(id, tf, (data[tf] ?? []).map((c, i, a) => ({ ...c, isClosed: !(tf === formingLast && i === a.length - 1) })), 'replace');
    });
  it('real provider candles → snapshot + persistent log; another instrument stays empty (symbol isolation)', () => {
    const provider = new ManualPriceProvider('mt5');
    const { services } = renderWithServices(<></>, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    feed(provider, 'XAUUSD', F.buyReversal());
    const st = services.highLow.store('XAUUSD').getState();
    expect(st.snapshot!.state).toBe('READY');
    expect(st.log.length).toBeGreaterThan(0);
    expect(services.highLow.store('XAGUSD').getState().snapshot).toBeNull();
    expect(services.hlReversal.store('XAUUSD').getState().snapshot).not.toBeNull();
  });
  it('a FORMING M5 bar (provider-flagged) cannot confirm structure', () => {
    const s = keySetup();
    const cut = hleKnownInput(ds, s.m5!.knownAt);
    const provider = new ManualPriceProvider('mt5');
    const { services } = renderWithServices(<></>, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    feed(provider, 'XAUUSD', cut, 'M5');
    const snap = services.highLow.store('XAUUSD').getState().snapshot!;
    expect(snap.setups.find((x) => x.id === s.id)!.m5).toBeNull();
  });
});
