import { describe, expect, it } from 'vitest';
import { feedLabel } from '../../components/orderFlowPro/ofpFormat';
import { CLASSIFICATION_TEXT, GATEWAY_CLASSIFICATION_TEXT, sourceText } from '../../components/orderFlowPro/ofpSourceText';
import { offlineStatus } from '../../engines/orderFlowPro/engine';
import type { GatewayProvenance, SourceStatus, StreamLiveness } from '../../engines/orderFlowPro/types';
import { gatewaySourceEnabled, OFP_GATEWAY_RELEASED } from './activation';
import { BackendSource } from './BackendSource';
import { defaultOfpSource } from './controller';
import { GatewaySource } from './GatewaySource';

describe('Order Flow Pro gateway activation (website only, off by default)', () => {
  it('is NOT released: the production website keeps BACKEND OFFLINE until an approved release flips it', () => {
    expect(OFP_GATEWAY_RELEASED).toBe(false);
  });
  it('enable matrix: never in local builds; website only when released or in an explicit test build', () => {
    expect(gatewaySourceEnabled(false, true, '1')).toBe(false);
    expect(gatewaySourceEnabled(true, false, undefined)).toBe(false);
    expect(gatewaySourceEnabled(true, false, '0')).toBe(false);
    expect(gatewaySourceEnabled(true, false, 'true')).toBe(false);
    expect(gatewaySourceEnabled(true, false, '1')).toBe(true);
    expect(gatewaySourceEnabled(true, true, undefined)).toBe(true);
  });
  it('the default (this test environment) is the existing BackendSource', () => {
    expect(gatewaySourceEnabled()).toBe(false);
    expect(defaultOfpSource()).toBeInstanceOf(BackendSource);
    expect(defaultOfpSource(true)).toBeInstanceOf(GatewaySource);
  });
});

function gwStatus(trades: StreamLiveness, depth: StreamLiveness, feed: SourceStatus['feed']): SourceStatus {
  const prov = (state: StreamLiveness, detail: string | null = null) => ({ state, provider: 'x', timeBasis: 'EXCHANGE_EVENT' as const, contract: 'GCZ6', lastMs: 1, ageMs: 90_000, lastPollMs: 1, detail });
  const p: GatewayProvenance = {
    trades: prov(trades, trades === 'LIVE' || trades === 'QUIET' ? null : `trades ${trades}`),
    depth: prov(depth, depth === 'LIVE' ? null : `depth ${depth}`),
    bars: prov('LIVE'),
    aggressor: 'EXCHANGE',
    quality: { tradesAccepted: 0, tradesDuplicate: 0, tradesRejected: 0, tradesOutOfOrder: 0, unknownSide: 0, depthChanges: 0, depthResyncs: 0, depthSeqGaps: 0, depthRejected: 0, gaps: 0, requestErrors: 0, rateLimited: 0 },
    requests: 0,
  };
  return { ...offlineStatus('GC', feed, []), marketDataType: feed === 'LIVE' ? 'REALTIME' : null, provenance: p };
}

describe('labels: honest per-source wording', () => {
  it('LIVE only for live trades; depth problems are shown, never hidden', () => {
    expect(feedLabel(gwStatus('LIVE', 'LIVE', 'LIVE'))).toMatchObject({ text: 'LIVE', tone: 'ok' });
    expect(feedLabel(gwStatus('QUIET', 'LIVE', 'LIVE')).text).toBe('LIVE · QUIET');
    expect(feedLabel(gwStatus('LIVE', 'CONTRACT_MISMATCH', 'LIVE'))).toMatchObject({ text: 'LIVE · DEPTH CONTRACT MISMATCH', tone: 'warn' });
    expect(feedLabel(gwStatus('LIVE', 'STALE', 'LIVE')).text).toBe('LIVE · DEPTH STALE');
  });
  it('non-live states are never labelled LIVE', () => {
    expect(feedLabel(gwStatus('DISCONNECTED', 'DISCONNECTED', 'DISCONNECTED'))).toMatchObject({ text: 'DISCONNECTED', tone: 'bad' });
    expect(feedLabel(gwStatus('UNAVAILABLE', 'LIVE', 'UNAVAILABLE'))).toMatchObject({ text: 'DATA UNAVAILABLE', tone: 'bad' });
    expect(feedLabel(gwStatus('CONTRACT_MISMATCH', 'LIVE', 'CONTRACT_MISMATCH'))).toMatchObject({ text: 'CONTRACT MISMATCH', tone: 'bad' });
    expect(feedLabel(gwStatus('STALE', 'LIVE', 'STALE'))).toMatchObject({ text: 'STALE', tone: 'warn' });
    // LIVE feed without REALTIME data type is not green
    expect(feedLabel({ ...gwStatus('LIVE', 'LIVE', 'LIVE'), marketDataType: null }).tone).toBe('warn');
  });
  it('exchange-aggressor wording only with gateway provenance; the IBKR backend keeps "inferred"', () => {
    const gw = sourceText(gwStatus('LIVE', 'LIVE', 'LIVE'), false);
    expect(gw.sideHeader).toBe('Side (exchange)');
    expect(gw.classification).toBe(GATEWAY_CLASSIFICATION_TEXT);
    expect(gw.provider).toBe('Databento + IBKR (read-only)');
    const ib = sourceText(offlineStatus('GC', 'LIVE', []), false);
    expect(ib.sideHeader).toBe('Side (inferred)');
    expect(ib.classification).toBe(CLASSIFICATION_TEXT);
    expect(sourceText(gwStatus('LIVE', 'LIVE', 'LIVE'), true).provider).toBe('DEMO fixture');
  });
});
