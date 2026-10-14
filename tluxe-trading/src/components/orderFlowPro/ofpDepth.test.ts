import { describe, expect, it } from 'vitest';
import { offlineStatus } from '../../engines/orderFlowPro/engine';
import type { GatewayProvenance, SourceStatus, StreamLiveness } from '../../engines/orderFlowPro/types';
import { depthFreshness } from './ofpFormat';

function st(depth: StreamLiveness | null, feed: SourceStatus['feed'] = 'LIVE', detail: string | null = null): SourceStatus {
  const base = { ...offlineStatus('GC', feed, []), marketDataType: 'REALTIME' } as SourceStatus;
  if (depth === null) return base;
  const prov = (state: StreamLiveness, d: string | null = null) => ({ state, provider: 'x', timeBasis: 'VPS_DEPTH_UPDATE' as const, contract: 'GCZ6', lastMs: 1, ageMs: 0, lastPollMs: 1, detail: d });
  const p: GatewayProvenance = {
    trades: prov('LIVE'),
    depth: prov(depth, detail),
    bars: prov('LIVE'),
    aggressor: 'EXCHANGE',
    quality: { tradesAccepted: 0, tradesDuplicate: 0, tradesRejected: 0, tradesOutOfOrder: 0, unknownSide: 0, depthChanges: 0, depthResyncs: 0, depthSeqGaps: 0, depthRejected: 0, gaps: 0, requestErrors: 0, rateLimited: 0 },
    requests: 0,
  };
  return { ...base, provenance: p };
}

describe('depthFreshness: one rule for the chart overlay, Order Book and Liquidity Strength', () => {
  it('current only for a valid book with LIVE / QUIET depth', () => {
    expect(depthFreshness(st('LIVE'), true)).toMatchObject({ current: true, label: 'DEPTH LIVE' });
    expect(depthFreshness(st('QUIET'), true)).toMatchObject({ current: true, label: 'DEPTH LIVE · QUIET' });
  });
  it('a valid book is NOT current when the stream says otherwise (request failures / stale / unavailable)', () => {
    expect(depthFreshness(st('DISCONNECTED', 'LIVE', 'No IBKR depth confirmation for > 6 s'), true)).toMatchObject({ current: false, state: 'DISCONNECTED', label: 'DEPTH DISCONNECTED', tone: 'bad', detail: 'No IBKR depth confirmation for > 6 s' });
    expect(depthFreshness(st('STALE'), true)).toMatchObject({ current: false, state: 'STALE', tone: 'warn' });
    expect(depthFreshness(st('UNAVAILABLE'), true)).toMatchObject({ current: false, state: 'UNAVAILABLE' });
  });
  it('LIVE stream but no valid book -> re-syncing, not current', () => {
    expect(depthFreshness(st('LIVE'), false)).toMatchObject({ current: false, state: 'NO_BOOK', label: 'DEPTH RE-SYNCING' });
  });
  it('contract mismatch is never current', () => {
    expect(depthFreshness(st('LIVE', 'CONTRACT_MISMATCH'), true)).toMatchObject({ current: false, state: 'CONTRACT_MISMATCH', label: 'DEPTH CONTRACT MISMATCH' });
    expect(depthFreshness(st('CONTRACT_MISMATCH'), true)).toMatchObject({ current: false, state: 'CONTRACT_MISMATCH' });
  });
  it('replay depth is recorded, never current', () => {
    expect(depthFreshness(st('LIVE'), true, true)).toMatchObject({ current: false, state: 'RECORDED' });
  });
  it('local backend (no gateway provenance): the book validity decides', () => {
    expect(depthFreshness(st(null), true).current).toBe(true);
    expect(depthFreshness(st(null), false)).toMatchObject({ current: false, label: 'NO VALID BOOK' });
  });
});
