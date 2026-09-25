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
const keySetup = () => analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: F.buyReversal() }).setups.find((s) => s.levelType === 'PDL' && s.risk)!;

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
  const s = keySetup();
  const readyAt = s.entry!.knownAt * 1000;
  const before = analyzeHLEAt(ds, s.entry!.knownAt - 60);
  const ready = analyzeHLEAt(ds, s.entry!.knownAt);
  const mk = (clock: { now: number }, storage = memoryStorage({}), log: string[] = []) =>
    new HighLowAlerts(storage, { sound: (k) => (log.push(`sound:${k}`), true), desktop: (t) => (log.push(`desktop:${t}`), true), permission: () => 'granted', now: () => clock.now });
  it('ENTRY READY alerts exactly once per M5-keyed setup — never repeated, never after a refresh (recorded before the alarm)', () => {
    const clock = { now: readyAt - 60_000 };
    const storage = memoryStorage({});
    const log: string[] = [];
    const al = mk(clock, storage, log);
    expect(al.observe('XAUUSD', before, 'LIVE').every((x) => x.kind.startsWith('pre-entry'))).toBe(true); // waiting for the pullback: PRE-ENTRY only
    clock.now = readyAt + 30_000;
    const r = al.observe('XAUUSD', ready, 'LIVE');
    expect(r.map((x) => [x.kind, x.late, x.discovery])).toEqual([['entry-ready', false, null]]);
    expect(ready.setups.filter((x) => x.alertKey === s.alertKey && x.state === 'ENTRY_READY').length).toBeGreaterThan(1); // PDL + swing low: one trade, one alert
    expect(al.observe('XAUUSD', ready, 'LIVE')).toEqual([]);
    expect(log.filter((x) => x === 'sound:entry-ready')).toEqual(['sound:entry-ready']);
    expect(r[0]!.channels).toEqual(['sound', 'desktop', 'banner']);
    expect(JSON.parse(storage.data.get('tluxe.hle.alerts.v2')!).entry[s.alertKey!]).toBe(readyAt + 30_000);
    expect(mk(clock, storage).observe('XAUUSD', ready, 'LIVE')).toEqual([]);
  });
  it('FRESH ≤ 5 min (inclusive); older at first sight → LATE ENTRY DISCOVERED with discovery startup / outage / delayed', () => {
    expect(mk({ now: readyAt + 5 * 60_000 }).observe('XAUUSD', ready, 'LIVE')[0]!.kind).toBe('entry-ready');
    const startup = mk({ now: readyAt + 5 * 60_000 + 1 }).observe('XAUUSD', ready, 'LIVE')[0]!;
    expect([startup.kind, startup.late, startup.discovery]).toEqual(['late-entry', true, 'startup']);
    // Outage: live before, stale while the setup completed, recovery 20 min later.
    const c1 = { now: readyAt - 60_000 };
    const o = mk(c1);
    o.observe('XAUUSD', before, 'LIVE');
    c1.now = readyAt + 60_000;
    expect(o.observe('XAUUSD', ready, 'STALE')).toEqual([]); // an outage in progress never alerts
    c1.now = readyAt + 20 * 60_000;
    expect(o.observe('XAUUSD', ready, 'DISCONNECTED')).toEqual([]);
    c1.now = readyAt + 21 * 60_000;
    const out = o.observe('XAUUSD', ready, 'LIVE')[0]!;
    expect([out.kind, out.discovery]).toEqual(['late-entry', 'outage']);
    // Delayed: live the whole time, but first observed ready > 5 min after its entry time.
    const c2 = { now: readyAt - 60_000 };
    const d = mk(c2);
    d.observe('XAUUSD', before, 'LIVE');
    c2.now = readyAt + 10 * 60_000;
    expect(d.observe('XAUUSD', ready, 'LIVE')[0]!.discovery).toBe('delayed');
  });
  it('mute silences only the sound: desktop + banner still fire; email is never faked', () => {
    const log: string[] = [];
    const al = mk({ now: readyAt }, memoryStorage({}), log);
    al.setAlarm(false);
    const r = al.observe('XAUUSD', ready, 'LIVE');
    expect(r[0]!.channels).toEqual(['desktop', 'banner']);
    expect(log.some((x) => x.startsWith('sound'))).toBe(false);
    expect(al.store.getState().email).toBe('not-configured');
  });
  it('a failing channel never stops the others (the record is already stored)', () => {
    const storage = memoryStorage({});
    const al = new HighLowAlerts(storage, { sound: () => { throw new Error('audio'); }, desktop: () => true, permission: () => 'granted', now: () => readyAt });
    expect(al.observe('XAUUSD', ready, 'LIVE')[0]!.channels).toEqual(['desktop', 'banner']);
    expect(storage.data.get('tluxe.hle.alerts.v2')).toContain(s.alertKey!);
  });
  it('PRE-ENTRY: separate once-only warning when M5 confirmed and the zone waits; never after that setup’s ENTRY alert', () => {
    const preSnap = analyzeHLEAt(ds, s.m5!.knownAt);
    const clock = { now: s.m5!.knownAt * 1000 + 10_000 };
    const al = mk(clock);
    expect(al.observe('XAUUSD', preSnap, 'LIVE').map((x) => x.kind)).toEqual(['pre-entry']);
    expect(al.observe('XAUUSD', preSnap, 'LIVE')).toEqual([]);
    clock.now = readyAt + 10_000;
    expect(al.observe('XAUUSD', ready, 'LIVE').map((x) => x.kind)).toEqual(['entry-ready']); // PRE-ENTRY never blocks ENTRY
    const storage = memoryStorage({});
    const al2 = mk({ now: readyAt }, storage);
    al2.observe('XAUUSD', ready, 'LIVE');
    expect(mk({ now: readyAt }, storage).observe('XAUUSD', preSnap, 'LIVE')).toEqual([]);
    expect(mk({ now: readyAt }).observe('XAUUSD', preSnap, 'STALE')).toEqual([]);
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
