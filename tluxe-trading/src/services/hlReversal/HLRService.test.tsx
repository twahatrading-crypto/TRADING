import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HLR_SETTINGS, HLR_TIMEFRAMES } from '../../engines/hlReversal/config';
import * as F from '../../engines/hlReversal/fixtures/scenarios';
import { analyzeHLRAt, type HLRDataset } from '../../engines/hlReversal/knowledge';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import { HLRReplaySession } from './HLRReplay';
import { runHLRAudit } from './replayAudit';

const ds: HLRDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...DEFAULT_HLR_SETTINGS }, candles: F.buyReversal() };
const norm = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'price' || k === 'distance' ? null : x));

describe('High / Low Reversal replay', () => {
  it('every visited step (forward, back, jumps) matches a clean recomputation (parity OK)', () => {
    const r = new HLRReplaySession(ds, 'M5', { startIndex: 60, verify: true });
    for (const m of [1, 1, 5, -3, 30, -50, 70, 1, -1, 12]) {
      if (Math.abs(m) === 1) r.step(m);
      else r.seek(r.store.getState().cursor + m);
      const s = r.store.getState();
      expect(s.parity).toEqual({ ok: true, mismatches: [] });
      expect(norm(s.snapshot)).toBe(norm(analyzeHLRAt(ds, s.knowledgeTime!)));
    }
  });
  it('replay is deterministic: two sessions stepping the same path hold identical state', () => {
    const a = new HLRReplaySession(ds, 'M1', { startIndex: 100 });
    const b = new HLRReplaySession(ds, 'M1', { startIndex: 100 });
    for (let k = 0; k < 20; k++) {
      a.step(7);
      b.step(7);
    }
    expect(JSON.stringify(a.store.getState().snapshot)).toBe(JSON.stringify(b.store.getState().snapshot));
  });
  it('ENTRY READY appears in replay exactly when its M1 bar closes, never earlier', () => {
    const full = analyzeHLRAt(ds, Infinity).setups.find((s) => s.entry)!;
    const m1 = ds.candles.M1!;
    const idx = m1.findIndex((c) => c.time === full.entry!.time);
    const r = new HLRReplaySession(ds, 'M1', { startIndex: idx - 1 });
    expect(r.store.getState().snapshot!.setups.find((s) => s.id === full.id)!.state).toBe('M1_PULLBACK_PENDING');
    r.step(1);
    expect(r.store.getState().snapshot!.setups.find((s) => s.id === full.id)!.state).toBe('ENTRY_READY');
  });
  it('in-app audit runner: PASS on the BUY reversal', async () => {
    const rep = await runHLRAudit(ds, 'M5');
    expect(rep.audit.violations).toEqual([]);
    expect(rep.replay.mismatches).toEqual([]);
    expect(rep.passed).toBe(true);
  });
});

describe('High / Low Reversal service', () => {
  it('feeds H4/H1/M15/M5/M1 of the selected instrument; another instrument stays empty (instrument isolation)', () => {
    const provider = new ManualPriceProvider('mt5');
    const { services } = renderWithServices(<></>, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    act(() => {
      provider.sink.connection('XAUUSD', 'LIVE');
      const c = F.buyReversal();
      for (const tf of HLR_TIMEFRAMES) provider.sink.candles('XAUUSD', tf, [...(c[tf] ?? [])].map((x) => ({ ...x, isClosed: true })), 'replace');
    });
    const snap = services.hlReversal.store('XAUUSD').getState().snapshot!;
    expect(snap.state).toBe('READY');
    expect(snap.setups.some((s) => s.state === 'TRIGGERED')).toBe(true);
    expect(services.hlReversal.store('XAGUSD').getState().snapshot).toBeNull();
  });
});
