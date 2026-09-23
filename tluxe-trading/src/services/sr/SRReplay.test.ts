/**
 * Replay session: knowledge cutoff across timeframes, future isolation, controls,
 * and isolation from the live pipeline. Deterministic TEST-ONLY candles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_START, randomWalk } from '../../engines/sr/fixtures/builders';
import * as F from '../../engines/sr/fixtures/scenarios';
import { analyzeAt, barCloseTime, knownAt, type ReplayDataset } from '../../engines/sr/knowledge';
import { DEFAULT_SR_SETTINGS, TIMEFRAME_SECONDS } from '../../engines/sr/settings';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import type { Candle, Timeframe } from '../../types/market';
import { BridgeOfflineError } from '../mt5/client';
import { sanitizeMt5Config } from '../mt5/config';
import { Mt5Provider } from '../mt5/Mt5Provider';
import { connectServices, createServices, defaultProviders } from '../registry';
import { SRReplaySession } from './SRReplay';

const S = { ...DEFAULT_SR_SETTINGS };
const TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

/** Aggregate a base series into a higher timeframe (bars aligned to the HTF clock). */
function aggregate(base: readonly Candle[], tf: Timeframe): Candle[] {
  const sec = TIMEFRAME_SECONDS[tf];
  const out: Candle[] = [];
  for (const c of base) {
    const t = Math.floor(c.time / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: null });
  }
  return out;
}

/** One consistent multi-timeframe history built from an M5 path (M1 from its own path, same clock). */
function dataset(): ReplayDataset {
  const m5 = randomWalk(3000, { seed: 77, start: 2650, vol: 1.6, tf: 'M5' });
  const m1 = randomWalk(3000 * 5, { seed: 78, start: 2650, vol: 0.7, tf: 'M1' });
  return {
    instrumentId: 'XAUUSD',
    tickSize: 0.01,
    settings: S,
    candles: { M1: m1, M5: m5, M15: aggregate(m5, 'M15'), M30: aggregate(m5, 'M30'), H1: aggregate(m5, 'H1'), H4: aggregate(m5, 'H4'), D1: aggregate(m5, 'D1') },
  };
}

const json = (v: unknown) => JSON.stringify(v);
const ds = dataset();

afterEach(() => vi.useRealTimers());

describe('replay session — equals the no-future oracle', () => {
  it('state at every visited cursor === brand-new engines fed only bars known at K (forward, backward, jumps)', () => {
    const r = new SRReplaySession(ds, 'H1', { startIndex: 60 });
    const moves = [1, 1, 1, 5, -3, 12, -20, 40, 1, -1, 90, -45, 1];
    for (const m of moves) {
      if (m === 1 || m === -1) r.step(m);
      else r.seek(r.store.getState().cursor + m);
      const s = r.store.getState();
      const oracle = analyzeAt(ds, s.knowledgeTime!, s.price);
      expect(json(s.multi)).toBe(json(oracle));
    }
  });

  it.each(TFS)('chart timeframe %s: stepping reveals exactly one closed bar and never a bar beyond K', (tf) => {
    const total = ds.candles[tf]!.length;
    const r = new SRReplaySession(ds, tf, { startIndex: Math.min(total - 5, 55) });
    for (let k = 0; k < 4; k++) {
      const before = r.store.getState();
      r.step(1);
      const s = r.store.getState();
      expect(s.visible.length).toBe(before.visible.length + 1);
      expect(s.knowledgeTime).toBe(barCloseTime(s.visible.at(-1)!, tf));
      for (const t of TFS) {
        const snap = s.byTimeframe[t]!;
        if (snap.lastClosedTime !== null) expect(snap.lastClosedTime + TIMEFRAME_SECONDS[t]).toBeLessThanOrEqual(s.knowledgeTime!);
      }
    }
  });
});

describe('replay session — future candles can never change the past', () => {
  it('replay at K is identical whether the future exists, is missing, or is completely different', () => {
    const cursor = 130;
    const k = barCloseTime(ds.candles.H1![cursor]!, 'H1');
    const truncated: ReplayDataset = { ...ds, candles: Object.fromEntries(TFS.map((tf) => [tf, knownAt(ds.candles[tf]!, tf, k)])) };
    const corrupt: ReplayDataset = {
      ...ds,
      candles: Object.fromEntries(
        TFS.map((tf) => [tf, ds.candles[tf]!.map((c) => (c.time + TIMEFRAME_SECONDS[tf] > k ? { ...c, high: c.high + 500, low: c.low - 500, close: c.close * 1.2 } : c))]),
      ),
    };
    const a = new SRReplaySession(ds, 'H1', { startIndex: cursor }).store.getState();
    const b = new SRReplaySession(truncated, 'H1', { startIndex: cursor }).store.getState();
    const c = new SRReplaySession(corrupt, 'H1', { startIndex: cursor }).store.getState();
    expect(json(a.multi)).toBe(json(b.multi));
    expect(json(a.multi)).toBe(json(c.multi));
    expect(json(a.visible)).toBe(json(b.visible));
  });

  it('MTF: a higher-timeframe bar still forming at K is invisible (no partial H4/D1 bar leaks)', () => {
    // Cursor on the M15 bar that closes 1h into an H4 bar.
    const m15 = ds.candles.M15!;
    const idx = m15.findIndex((c, i) => i > 200 && (c.time + 900) % (4 * 3600) === 3600);
    const r = new SRReplaySession(ds, 'M15', { startIndex: idx });
    const s = r.store.getState();
    const k = s.knowledgeTime!;
    const h4 = s.byTimeframe.H4!;
    const straddling = ds.candles.H4!.find((c) => c.time < k && c.time + 4 * 3600 > k)!;
    expect(straddling).toBeDefined();
    expect(h4.lastClosedTime).toBe(straddling.time - 4 * 3600);
    expect(s.byTimeframe.D1!.lastClosedTime === null || s.byTimeframe.D1!.lastClosedTime! + 86400 <= k).toBe(true);
    expect(s.byTimeframe.M1!.lastClosedTime).toBe(k - 60);
    // Confluence at K uses only those zones.
    expect(json(s.multi)).toBe(json(analyzeAt(ds, k, s.price)));
  });

  it('changing the replay timeframe keeps the replay time: no current/live bar appears', () => {
    const r = new SRReplaySession(ds, 'M5', { startIndex: 900 });
    const k = r.store.getState().knowledgeTime!;
    for (const tf of ['H1', 'M1', 'H4', 'M15', 'D1', 'M5'] as Timeframe[]) {
      r.setTimeframe(tf);
      const s = r.store.getState();
      expect(s.timeframe).toBe(tf);
      if (s.visible.length) expect(barCloseTime(s.visible.at(-1)!, tf)).toBeLessThanOrEqual(k);
      expect(s.visible.length).toBe(knownAt(ds.candles[tf]!, tf, k).length);
      for (const t of TFS) {
        const snap = s.byTimeframe[t]!;
        if (snap.lastClosedTime !== null) expect(snap.lastClosedTime + TIMEFRAME_SECONDS[t]).toBeLessThanOrEqual(k);
      }
      // Switching timeframe never moves the replay clock.
      expect(s.knowledgeTime).toBe(k);
      expect(json(s.multi)).toBe(json(analyzeAt(ds, k, s.price)));
    }
  });
});

describe('replay session — zones become visible only when knowable', () => {
  const flip = F.supportToResistanceFlip(); // H1 scenario
  // Lower history minimum so the scenario's zone is reported on its own confirmation bar (READY from bar 20).
  const flipDs: ReplayDataset = { instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...S, minHistoryBars: 20 }, candles: { H1: flip } };
  const final = new SRReplaySession(flipDs, 'H1', { startIndex: flip.length - 1 }).store.getState();
  const zone = final.byTimeframe.H1!.zones.find((z) => z.flippedAt !== null)!;
  const indexAt = (t: number) => flip.findIndex((c) => c.time === t);

  it('a zone is absent on the pivot bar and on every confirmation bar until pivotRight bars have closed', () => {
    const r = new SRReplaySession(flipDs, 'H1', { startIndex: 0 });
    const pivotIdx = indexAt(zone.createdAt);
    const confirmIdx = indexAt(zone.confirmedAt);
    expect(confirmIdx - pivotIdx).toBe(S.pivotRight);
    for (let i = pivotIdx; i < confirmIdx; i++) {
      r.seek(i);
      expect(r.store.getState().byTimeframe.H1!.zones.some((z) => z.id === zone.id)).toBe(false);
    }
    r.seek(confirmIdx);
    expect(r.store.getState().byTimeframe.H1!.zones.some((z) => z.id === zone.id)).toBe(true);
  });

  it('touches, the break and the flip appear exactly on their bars — not one bar earlier', () => {
    const r = new SRReplaySession(flipDs, 'H1', { startIndex: 0 });
    const at = (i: number) => (r.seek(i), r.store.getState().byTimeframe.H1!.zones.find((z) => z.id === zone.id)!);
    const b = indexAt(zone.statusHistory.find((h) => h.to === 'BROKEN')!.time);
    expect(at(b - 1).statusHistory.some((h) => h.to === 'BROKEN')).toBe(false);
    expect(at(b).statusHistory.some((h) => h.to === 'BROKEN')).toBe(true);
    const f = indexAt(zone.roleHistory[0]!.time);
    expect(at(f - 1).roleHistory).toEqual([]);
    expect(at(f).roleHistory).toHaveLength(1);
    for (const it of zone.interactions) {
      const s = indexAt(it.startTime);
      expect(at(s - 1).interactions.some((x) => x.id === it.id)).toBe(false);
      expect(at(s).interactions.some((x) => x.id === it.id)).toBe(true);
    }
  });

  it('the score at each step equals the score from data up to that step only', () => {
    const r = new SRReplaySession(flipDs, 'H1', { startIndex: 0 });
    for (let i = 60; i < flip.length; i += 7) {
      r.seek(i);
      const s = r.store.getState();
      const oracle = analyzeAt(flipDs, s.knowledgeTime!, s.price);
      expect(json(s.byTimeframe.H1!.zones.map((z) => [z.id, z.score]))).toBe(json(oracle.byTimeframe.H1!.zones.map((z) => [z.id, z.score])));
    }
  });
});

describe('replay session — controls', () => {
  it('play advances one bar per tick at the chosen speed, pauses, and stops at the end', () => {
    vi.useFakeTimers();
    const r = new SRReplaySession(ds, 'H4', { startIndex: 40 });
    r.setSpeed(5);
    r.play();
    vi.advanceTimersByTime(1000); // 5 bars at 5×
    expect(r.store.getState().cursor).toBe(45);
    r.pause();
    vi.advanceTimersByTime(3000);
    expect(r.store.getState().cursor).toBe(45);
    r.setSpeed(10);
    r.seek(r.store.getState().total - 3);
    r.play();
    vi.advanceTimersByTime(5000);
    const s = r.store.getState();
    expect(s.cursor).toBe(s.total - 1);
    expect(s.playing).toBe(false);
    r.dispose();
  });

  it('start / end / step back clamp to the available history', () => {
    const r = new SRReplaySession(ds, 'D1', { startIndex: 3 });
    r.toStart();
    expect(r.store.getState().cursor).toBe(0);
    r.step(-1);
    expect(r.store.getState().cursor).toBe(0);
    r.toEnd();
    expect(r.store.getState().cursor).toBe(r.store.getState().total - 1);
  });
});

describe('replay is isolated from the live pipeline', () => {
  function live() {
    const provider = new ManualPriceProvider('mt5');
    const services = createServices({ ...defaultProviders(), price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    connectServices(services);
    const h1 = randomWalk(300, { seed: 9, start: 2650, vol: 4 }).map((c, i, a) => ({ ...c, isClosed: i < a.length - 1 }));
    provider.sink.connection('XAUUSD', 'LIVE');
    provider.sink.candles('XAUUSD', 'H1', h1, 'replace');
    return { provider, services, h1 };
  }

  it('entering, stepping and exiting replay never touches the live store, candles or provider', () => {
    const { provider, services, h1 } = live();
    const liveBefore = services.sr.store('XAUUSD').getState();
    const candlesBefore = json(services.market.getCandles('XAUUSD', 'H1'));
    const requests = provider.requestCandles.mock.calls.length;
    const subscribed = provider.subscribed.length;

    const r = services.sr.createReplay('H1', 100)!;
    r.step(1);
    r.seek(50);
    r.setTimeframe('M15');
    r.dispose();

    expect(services.sr.store('XAUUSD').getState()).toBe(liveBefore);
    expect(json(services.market.getCandles('XAUUSD', 'H1'))).toBe(candlesBefore);
    expect(provider.requestCandles.mock.calls.length).toBe(requests);
    expect(provider.subscribed.length).toBe(subscribed);
    expect(provider.unsubscribe).not.toHaveBeenCalled();
    // The replay used closed bars only (the forming bar is excluded) and froze its copy.
    expect(r.dataset.candles.H1!.length).toBe(h1.length - 1);
    expect(Object.isFrozen(r.dataset.candles.H1![0])).toBe(true);
  });

  it('live candles arriving during replay update the live store but never the replay', () => {
    const { provider, services, h1 } = live();
    const r = services.sr.createReplay('H1', 150)!;
    const replayBefore = json(r.store.getState().multi);
    const next = { ...h1.at(-1)!, time: h1.at(-1)!.time + 3600, isClosed: false };
    provider.sink.candles('XAUUSD', 'H1', [{ ...h1.at(-1)!, isClosed: true }, next], 'upsert');
    expect(services.sr.store('XAUUSD').getState().byTimeframe.H1!.barsProcessed).toBe(h1.length);
    expect(json(r.store.getState().multi)).toBe(replayBefore);
    expect(r.dataset.candles.H1!.length).toBe(h1.length - 1);
    r.dispose();
  });

  it('replay playback adds no MT5 polling, subscriptions or timers to the provider', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 23, 12) });
    const offline = () => Promise.reject(new BridgeOfflineError());
    const client = { health: vi.fn(offline), symbols: vi.fn(offline), quote: vi.fn(offline), rates: vi.fn(offline) };
    const mt5 = new Mt5Provider(sanitizeMt5Config({ enabled: true, token: 'x'.repeat(32), healthMs: 1000, quoteMs: 1000, candleMs: 1000 }), { client });
    const services = createServices({ ...defaultProviders(), price: [mt5] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    const stop = connectServices(services);
    await vi.advanceTimersByTimeAsync(3000);
    const baseline = client.health.mock.calls.length;
    client.health.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    const without = client.health.mock.calls.length;

    const r = new SRReplaySession(ds, 'H1', { startIndex: 60 });
    r.setSpeed(10);
    r.play();
    client.health.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.health.mock.calls.length).toBe(without);
    expect(client.rates).not.toHaveBeenCalled();
    r.dispose();
    stop();
    expect(baseline).toBeGreaterThan(0);
  });
});

void FIXTURE_START;
