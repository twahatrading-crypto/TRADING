import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { historyContract, resetSeedCache, usableSeed } from '../components/orderFlowPro/liquidityHistory';
import { offlineStatus } from '../engines/orderFlowPro/engine';
import type { GatewayProvenance, OfpFrame, OfpRoot, SourceStatus, StreamLiveness } from '../engines/orderFlowPro/types';
import { BackendSource } from '../providers/orderFlowPro/BackendSource';
import { installOfpController, OfpController } from '../providers/orderFlowPro/controller';
import type { OfpSource, SourceSink } from '../providers/orderFlowPro/source';
import { OrderFlowProPage } from './OrderFlowProPage';
import type * as Activation from '../providers/orderFlowPro/activation';

// Website gateway path ON for this file only (the one-time recorded-depth read only runs there).
vi.mock('../providers/orderFlowPro/activation', async (orig) => ({ ...(await orig<typeof Activation>()), gatewaySourceEnabled: () => true }));

/*
 * Contract-safe liquidity history. The fake gateway answers /api/ibkr/heatmap with recorded depth LABELLED with a
 * contract chosen by each test (constructed here, test only) - e.g. GCG7 during a roll, as the real gateway would.
 */
const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  for (let i = 0; i < 3; i++) await act(async () => {});
};
const T = Date.UTC(2026, 9, 14, 14, 0, 0);
const TICK: Record<OfpRoot, number> = { GC: 0.1, SI: 0.005 };
const MID: Record<OfpRoot, number> = { GC: 4195, SI: 60.5 };

function heatmapBody(root: OfpRoot, contract: string) {
  const columns: unknown[] = [];
  for (let t = T - 30 * 60_000; t < T; t += 15_000) {
    const bids = Array.from({ length: 6 }, (_, i) => [+(MID[root] - i * TICK[root]).toFixed(3), 1 + (i % 4)]);
    const asks = Array.from({ length: 6 }, (_, i) => [+(MID[root] + (i + 1) * TICK[root]).toFixed(3), 1 + ((i + 1) % 4)]);
    columns.push([t, 1, bids, asks, [[t, t + 15_000]]]);
  }
  return { root, contract, depthType: 'PRICE_LEVEL', mbo: false, bucketMs: 15_000, from: T - 30 * 60_000, to: T, firstRecordedMs: T - 3600_000, columns };
}

let served: Record<OfpRoot, string>;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const heatmapCalls = () => fetchSpy.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('/api/ibkr/heatmap'));

function scripted() {
  const sinks = new Map<OfpRoot, SourceSink>();
  const src: OfpSource = {
    info: { id: 'scripted', name: 'scripted', demo: false },
    subscribe: (root, sink) => {
      sinks.set(root, sink);
      return () => sinks.delete(root);
    },
    history: async () => [],
  };
  return { src, push: (root: OfpRoot, st: SourceStatus, frames: OfpFrame[] = [], t = T) => act(() => (sinks.get(root)?.status(st), sinks.get(root)?.frames(frames), sinks.get(root)?.time(t))) };
}

const ci = (root: OfpRoot, localSymbol: string) => ({ root, localSymbol, conId: 1, expiry: '20261229', exchange: 'COMEX' as const, tradingClass: root, multiplier: root === 'GC' ? '100' : '5000', verified: true });
function status(root: OfpRoot, trade: string, depth: string | null, depthState: StreamLiveness = 'LIVE', feed: SourceStatus['feed'] = 'LIVE'): SourceStatus {
  const p = (state: StreamLiveness, c: string | null) => ({ state, provider: 'x', timeBasis: 'VPS_DEPTH_UPDATE' as const, contract: c, lastMs: T, ageMs: 0, lastPollMs: Date.now(), detail: null });
  const prov: GatewayProvenance = { trades: p('LIVE', trade), depth: p(depthState, depth), bars: p('LIVE', trade), aggressor: 'EXCHANGE', quality: { tradesAccepted: 0, tradesDuplicate: 0, tradesRejected: 0, tradesOutOfOrder: 0, unknownSide: 0, depthChanges: 0, depthResyncs: 0, depthSeqGaps: 0, depthRejected: 0, gaps: 0, requestErrors: 0, rateLimited: 0 }, requests: 0 };
  return { ...offlineStatus(root, feed, []), marketDataType: 'REALTIME', contract: ci(root, trade), depthRows: 10, provenance: prov } as SourceStatus;
}
const book = (root: OfpRoot, t: number): OfpFrame => ({ root, seq: 1, events: [{ kind: 'book', t, bids: [[MID[root], 2], [+(MID[root] - TICK[root]).toFixed(3), 1], [+(MID[root] - 2 * TICK[root]).toFixed(3), 1]], asks: [[+(MID[root] + TICK[root]).toFixed(3), 1], [+(MID[root] + 2 * TICK[root]).toFixed(3), 1]] }] });
/** "recorded Xs" from the legend: > 0 only when recorded history is in use. */
const recorded = () => /recorded ([^+]+?) \+/.exec(screen.getByTestId('ofp-liq-legend').querySelector('.ofp-liqinfo')!.textContent ?? '')?.[1]?.trim();

async function page(root: OfpRoot) {
  localStorage.setItem('tluxe.ofp.root.v1', JSON.stringify(root));
  const s = scripted();
  installOfpController(new OfpController(s.src));
  render(<OrderFlowProPage />);
  await flush();
  return s;
}

beforeEach(() => {
  localStorage.clear();
  resetSeedCache();
  served = { GC: 'GCZ6', SI: 'SIZ6' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = String(input);
    const root = (/root=(GC|SI)/.exec(u)?.[1] ?? 'GC') as OfpRoot;
    if (u.startsWith('/api/ibkr/heatmap')) return new Response(JSON.stringify(heatmapBody(root, served[root])), { status: 200 });
    return new Response('{}', { status: 404 });
  });
});
afterEach(() => {
  installOfpController(new OfpController(new BackendSource()));
  vi.restoreAllMocks();
});

describe('historyContract / usableSeed (rules)', () => {
  it('only the verified trade contract, equal to the depth contract, well formed, no mismatch', () => {
    expect(historyContract('GC', 'GCZ6', 'GCZ6', false)).toBe('GCZ6');
    expect(historyContract('SI', 'SIZ6', 'SIZ6', false)).toBe('SIZ6');
    expect(historyContract('GC', 'GCZ6', 'GCG7', false)).toBeNull();
    expect(historyContract('SI', 'SIZ6', 'SIH7', false)).toBeNull();
    expect(historyContract('GC', 'GCZ6', 'GCZ6', true)).toBeNull();
    for (const bad of [null, undefined, '', 'GC', 'GCZ6 ', 'gcz6', 'MGCZ6', 'SIZ6', 'GCZ6-GCG7', 'GCA6']) {
      expect(historyContract('GC', bad, 'GCZ6', false), String(bad)).toBeNull();
      expect(historyContract('GC', 'GCZ6', bad, false), String(bad)).toBeNull();
    }
  });
  it('a loaded history is used only for exactly the allowed contract', () => {
    const seed = { contract: 'GCG7', bucketMs: 15_000, columns: [] };
    expect(usableSeed({ state: 'LOADED', seed, validMs: 1 }, 'GCZ6')).toBeNull();
    expect(usableSeed({ state: 'LOADED', seed, validMs: 1 }, null)).toBeNull();
    expect(usableSeed({ state: 'LOADED', seed, validMs: 1 }, 'GCG7')).toBe(seed);
    expect(usableSeed({ state: 'UNAVAILABLE', detail: 'x' }, 'GCG7')).toBeNull();
  });
});

describe('contract-safe liquidity history on the page', () => {
  for (const [root, chart, other] of [['GC', 'GCZ6', 'GCG7'], ['SI', 'SIZ6', 'SIH7']] as const) {
    it(`${chart} chart never displays ${other} liquidity history; no history request while depth is on ${other}`, async () => {
      served[root] = other; // the gateway's recorded depth is the other contract (roll)
      const s = await page(root);
      s.push(root, status(root, chart, other), [book(root, T)], T + 1000);
      await flush();
      s.push(root, status(root, chart, other, 'LIVE', 'CONTRACT_MISMATCH'), [], T + 2000);
      await flush();
      expect(heatmapCalls()).toEqual([]);
      expect(recorded()).toBe('0s');
      expect(screen.getByTestId('ofp-liq-status')).toHaveTextContent(/no current levels/);
    });
  }

  it('a matching contract permits exactly one history request; repeated updates do not repeat it', async () => {
    const s = await page('GC');
    for (let k = 0; k < 6; k++) {
      s.push('GC', status('GC', 'GCZ6', 'GCZ6'), k === 0 ? [book('GC', T)] : [], T + 1000 + k * 1000);
      await flush();
    }
    expect(heatmapCalls()).toHaveLength(1);
    expect(recorded()).not.toBe('0s');
    expect(screen.getByTestId('ofp-liq-status')).toHaveTextContent(/STRONG ≥/);
  });

  it('history whose returned contract differs from the verified contract is rejected', async () => {
    served.GC = 'GCG7';
    const s = await page('GC');
    s.push('GC', status('GC', 'GCZ6', 'GCZ6'), [book('GC', T)], T + 1000);
    await flush();
    expect(heatmapCalls()).toHaveLength(1);
    expect(recorded()).toBe('0s');
    expect(screen.getByTestId('ofp-liq-legend')).toHaveTextContent(/recorded depth contract GCG7 ≠ live GCZ6 - not used/);
  });

  it('stale / disconnected depth reported for another contract never makes that history appear (and requests nothing)', async () => {
    served.GC = 'GCG7';
    const s = await page('GC');
    for (const st of ['STALE', 'DISCONNECTED'] as const) {
      s.push('GC', status('GC', 'GCZ6', 'GCG7', st), [], T + 3000);
      await flush();
      expect(heatmapCalls()).toEqual([]);
      expect(recorded()).toBe('0s');
    }
  });

  it('contract roll: the previous contract history is not reused; the new verified contract gets its own single read', async () => {
    const s = await page('GC');
    s.push('GC', status('GC', 'GCZ6', 'GCZ6'), [book('GC', T)], T + 1000);
    await flush();
    expect(heatmapCalls()).toHaveLength(1);
    expect(recorded()).not.toBe('0s');
    // roll: trades and depth now GCG7, but the gateway's recorded history for it is unavailable
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 503 }));
    s.push('GC', status('GC', 'GCG7', 'GCG7'), [{ root: 'GC', seq: 2, events: [{ kind: 'gap', from: T + 1000, to: T + 2000, reason: 'roll' }] }, book('GC', T + 2000)], T + 2000);
    await flush();
    expect(heatmapCalls()).toHaveLength(2); // one read for GCG7
    expect(recorded()).toBe('0s'); // GCZ6 history never shown on the GCG7 chart
  });

  it('recovery: mismatch -> matching again restores history only for the verified contract', async () => {
    served.GC = 'GCZ6';
    const s = await page('GC');
    s.push('GC', status('GC', 'GCZ6', 'GCG7', 'CONTRACT_MISMATCH', 'CONTRACT_MISMATCH'), [], T + 1000);
    await flush();
    expect(heatmapCalls()).toEqual([]);
    s.push('GC', status('GC', 'GCZ6', 'GCZ6'), [book('GC', T + 2000)], T + 2000);
    await flush();
    expect(heatmapCalls()).toHaveLength(1);
    expect(recorded()).not.toBe('0s');
  });
});
