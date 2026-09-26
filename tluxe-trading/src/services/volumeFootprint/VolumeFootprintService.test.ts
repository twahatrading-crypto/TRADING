import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FP_SETTINGS } from '../../engines/volumeFootprint/config';
import { FULL_FP_CAPS, generatedStream } from '../../engines/volumeFootprint/testing/stream';
import { ScriptedFootprintProvider } from '../../providers/footprint/testing/ScriptedFootprintProvider';
import { memoryStorage } from '../../test/providers';
import { connectServices, createServices, defaultProviders } from '../registry';

/* TEST DATA ONLY — a scripted synthetic trade stream through the real provider boundary. */

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

const SCRIPT = generatedStream({ minutes: 40, seed: 5 });
const TRADES = SCRIPT.filter((m) => m.type === 'trade').length;

function setup(o: { instrument?: string; provider?: ScriptedFootprintProvider | null; allowTest?: boolean } = {}) {
  const provider = o.provider === undefined ? new ScriptedFootprintProvider(SCRIPT, FULL_FP_CAPS) : o.provider;
  const services = createServices({ ...defaultProviders(), footprint: provider }, { storage: memoryStorage({ 'tluxe.instrument.v1': o.instrument ?? 'GC' }), allowTestProviders: o.allowTest ?? true });
  teardown = connectServices(services);
  act(() => services.volumeFootprint.flush());
  return { services, provider, fp: services.volumeFootprint };
}

describe('VolumeFootprintService', () => {
  it('no provider → FOOTPRINT DATA UNAVAILABLE with the missing capability named; nothing built', () => {
    const { fp } = setup({ provider: null });
    const s = fp.store.getState();
    expect(s.provider).toBeNull();
    expect(s.reason).toMatch(/No exchange trade provider connected/);
    expect(s.snapshot!.status).toBe('UNAVAILABLE');
    expect(fp.engine()!.candles('M1')).toHaveLength(0);
  });

  it('a TEST provider is refused unless test providers are explicitly allowed', () => {
    const { fp, provider } = setup({ allowTest: false });
    expect(fp.store.getState().provider).toBeNull();
    expect(provider!.connects).toBe(0);
  });

  it('spot / MT5 instruments are never footprinted (XAUUSD): no subscription, reason explains why', () => {
    const { fp, provider } = setup({ instrument: 'XAUUSD' });
    const s = fp.store.getState();
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/not an exchange-traded future/);
    expect(s.reason).toMatch(/never converted into Bid × Ask/);
    expect(provider!.subscriptions).toBe(0);
    expect(fp.engine()).toBeNull();
  });

  it('GC with an exchange trade feed → ACTIVE footprint, integrity GOOD, every message recorded once', () => {
    const { fp } = setup();
    const s = fp.store.getState().snapshot!;
    expect(s.status).toBe('ACTIVE');
    expect(s.contract).toBe('GCZ6');
    expect(s.integrity.state).toBe('GOOD');
    expect(s.integrity.accepted).toBe(TRADES);
    expect(fp.engine()!.candles('M1').length).toBeGreaterThan(30);
    expect(fp.recording().filter((m) => m.type === 'trade')).toHaveLength(TRADES);
  });

  it('store updates are batched (never one per trade)', () => {
    const { fp } = setup();
    expect(fp.received).toBeGreaterThan(TRADES);
    expect(fp.publishes).toBeLessThan(5);
  });

  it('HMR dispose + reconnect: one subscription, trades never double-counted', () => {
    const { services, provider, fp } = setup();
    teardown!();
    teardown = connectServices(services);
    act(() => fp.flush());
    expect(provider!.subscriptions).toBe(2); // one per connect, the previous one torn down
    expect(fp.store.getState().snapshot!.integrity.accepted).toBe(TRADES);
    connectServices(services); // idempotent
    expect(provider!.subscriptions).toBe(2);
  });

  it('analysis settings re-aggregate the RECORDED trades; the recorded evidence never changes', () => {
    const { fp } = setup();
    const rec = JSON.stringify(fp.recording());
    const before = JSON.stringify(fp.engine()!.fullState());
    const rowsBefore = fp.engine()!.candles('M5').reduce((n, c) => n + c.rows.length, 0);
    act(() => fp.setSettings({ ...DEFAULT_FP_SETTINGS, rowTicks: 5 }));
    const rowsAfter = fp.engine()!.candles('M5').reduce((n, c) => n + c.rows.length, 0);
    expect(rowsAfter).toBeLessThan(rowsBefore);
    expect(JSON.stringify(fp.recording())).toBe(rec);
    act(() => fp.setSettings({ ...DEFAULT_FP_SETTINGS }));
    expect(JSON.stringify(fp.engine()!.fullState())).toBe(before);
  });

  it('provider without aggressor side → UNCLASSIFIED: volume stays UNKNOWN, no bid / ask, no CVD', () => {
    const p = new ScriptedFootprintProvider(SCRIPT, { ...FULL_FP_CAPS, aggressor: 'NONE' });
    const { fp } = setup({ provider: p });
    const s = fp.store.getState().snapshot!;
    expect(s.status).toBe('UNCLASSIFIED');
    expect(s.cvdAvailability).toBe('UNAVAILABLE');
    for (const c of fp.engine()!.candles('M5')) expect(c.bid + c.ask).toBe(0);
  });

  it('replay of the recorded stream: parity MATCH, never shows later trades', () => {
    const { fp } = setup();
    const r = fp.createReplay('M5')!;
    for (let k = 0; k < 4; k++) {
      r.step(1);
      const s = r.store.getState();
      expect(s.parity?.ok).toBe(true);
      expect(s.snapshot!.integrity.accepted).toBe(fp.recording().filter((m) => m.type === 'trade' && m.recvTime <= s.knowledgeTime!).length);
    }
    r.dispose();
  });

  it('symbol switch GC → XAUUSD clears the footprint; back to GC re-subscribes once', () => {
    const { services, fp, provider } = setup();
    act(() => services.instruments.select('XAUUSD'));
    expect(fp.store.getState().supported).toBe(false);
    expect(fp.store.getState().snapshot).toBeNull();
    act(() => services.instruments.select('GC'));
    act(() => fp.flush());
    expect(provider!.subscriptions).toBe(2);
    expect(fp.store.getState().snapshot!.integrity.accepted).toBe(TRADES);
  });
});
