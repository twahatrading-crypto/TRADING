/** TEST DATA ONLY: hand-built engine-shaped objects to exercise the explanation layer — never shown as market data. */
import { describe, expect, it } from 'vitest';
import type { LiquidityPool } from '../liquidity/types';
import type { OrderBlock } from '../orderBlocks/types';
import { DEFAULT_SR_SETTINGS } from '../sr/settings';
import type { Interaction, SRZone } from '../sr/types';
import type { SmcSnapshot } from '../smc/types';
import type { Candle } from '../../types/market';
import type { QualityResult } from './dataQuality';
import type { FeedStatus } from './feedState';
import type { KeyLevel } from './keyLevels';
import { beyondZone, currentZone, meaningfulZones, mtfMap, scenarios, tierCounts, tierOf, zoneEvidence, type AnalysisInput } from './analysis';

const T = 1_793_000_000;
const ix = (o: Partial<Interaction>): Interaction =>
  ({ id: 'i', role: 'support', phase: 'hold', startTime: T, endTime: T + 900, extremeTime: T, extremePrice: 0, penetration: 0, penetrationRatio: 0.2, closeLocation: 1, swept: false, sweepTime: null, sweepDepth: 0, closedThrough: false, broke: false, rejected: true, rejectionDistance: 20, rejectionAtr: 1.6, maxExcursion: 20, maxExcursionAtr: 1.6, barsToRejection: 3, atr: 12, outcome: 'rejection', resolvedTime: T + 2700, ...o }) as Interaction;

function zone(o: Partial<SRZone> & { id: string }): SRZone {
  const role = o.role ?? o.type ?? 'support';
  const total = (o as { total?: number }).total ?? 70;
  return {
    instrumentId: 'GC',
    timeframe: 'M15',
    type: role,
    role,
    zoneLow: 3870,
    zoneHigh: 3880,
    midPrice: 3875,
    width: 10,
    pivotId: 'p',
    createdAt: T,
    confirmedAt: T + 2700,
    confirmedIndex: 10,
    atrAtConfirmation: 12,
    status: 'TESTED',
    statusHistory: [],
    roleHistory: [],
    sourcePivotIds: ['p'],
    interactions: [ix({ extremeTime: T + 9000 })],
    touchCount: 1,
    rejectionCount: 1,
    sweepCount: 0,
    closeThroughCount: 0,
    brokenAt: null,
    breakEvidence: null,
    flippedAt: null,
    lastInteractionAt: T + 9000,
    inZone: false,
    score: { components: { timeframe: 50, reaction: 60, touchQuality: 80, freshness: 80, structure: 60, confluence: 0 }, weights: {} as never, weighted: total, statusFactor: 1, total },
    distanceFromPrice: -5,
    distanceAtr: 0.4,
    confluenceIds: [],
    ...o,
  } as SRZone;
}

const LIVE: FeedStatus = { state: 'LIVE', label: 'LIVE', detail: '', ageSec: 10, current: true };
const CLOSED: FeedStatus = { state: 'MARKET_CLOSED', label: 'MARKET CLOSED', detail: '', ageSec: 40_000, current: false };
const Q: QualityResult = { state: 'OK', source: 'D1', referenceVolume: 100_000, activeSince: T - 86_400, activeSinceDay: '2026-10-21', perThreshold: [], stable: true, thinDays: 300, totalDays: 400, explanation: '' };

const smc = (h1: string, m15Break?: 'bullish' | 'bearish'): SmcSnapshot =>
  ({
    byTimeframe: {
      M15: { dataState: 'READY', state: 'RANGING', breaks: m15Break ? [{ kind: 'CHOCH', direction: m15Break, confirmedAt: T + 10_000 }] : [] },
      H1: { dataState: 'READY', state: h1, breaks: [] },
      H4: { dataState: 'READY', state: 'BULLISH', breaks: [] },
    },
  }) as unknown as SmcSnapshot;

function input(o: Partial<AnalysisInput>): AnalysisInput {
  return {
    zones: [],
    confluences: [],
    byTf: { M15: { atr: 12, lastClosedTime: T + 20_000 } as never },
    candles: {},
    settings: DEFAULT_SR_SETTINGS,
    quality: Q,
    levels: [],
    smc: smc('BULLISH', 'bullish'),
    pools: [],
    blocks: [],
    vp: null,
    feed: LIVE,
    price: 3882,
    sources: { feedLabel: 'LIVE', candleSource: 'Databento · GLBX.MDP3 · GCZ6', decimals: 1 },
    ...o,
  };
}

describe('tiers', () => {
  it('score bands, inactive, unrated (thin history)', () => {
    expect(tierOf(zone({ id: 'a', total: 85 } as never), Q)).toBe('STRONG');
    expect(tierOf(zone({ id: 'b', total: 60 } as never), Q)).toBe('MEDIUM');
    expect(tierOf(zone({ id: 'c', total: 59 } as never), Q)).toBe('WEAK');
    expect(tierOf(zone({ id: 'd', total: 30 } as never), Q)).toBe('MINOR');
    expect(tierOf(zone({ id: 'e', status: 'BROKEN' }), Q)).toBe('INACTIVE');
    expect(tierOf(zone({ id: 'f', total: 95, createdAt: Q.activeSince! - 1 } as never), Q)).toBe('UNRATED');
    expect(tierOf(zone({ id: 'g', total: 95, createdAt: Q.activeSince! - 1 } as never), null)).toBe('STRONG');
    expect(tierCounts([zone({ id: 'a', total: 85 } as never), zone({ id: 'e', status: 'BROKEN' })], Q)).toMatchObject({ STRONG: 1, INACTIVE: 1 });
  });

  it('thin-history zones never feed the chart selection or the current-zone panel', () => {
    const thin = zone({ id: 'thin', total: 99, createdAt: Q.activeSince! - 10, inZone: true } as never);
    const ok = zone({ id: 'ok', total: 55 } as never);
    const a = input({ zones: [thin, ok] });
    expect(meaningfulZones(a, 'M15').map((z) => z.id)).toEqual(['ok']);
    expect(currentZone(a, 'M15')?.id).toBe('ok');
  });
});

describe('price beyond a zone that no closed candle has broken', () => {
  it('is flagged, and the current-zone panel prefers zones on the correct side of price', () => {
    const above = zone({ id: 'd1', timeframe: 'D1', zoneLow: 3990, zoneHigh: 4010, distanceFromPrice: 115 } as never);
    const below = zone({ id: 'm15', zoneLow: 3860, zoneHigh: 3870, distanceFromPrice: -20 } as never);
    const a = input({ zones: [above, below], price: 3885 });
    expect(beyondZone(above, 3885)).toBe(true);
    expect(beyondZone(below, 3885)).toBe(false);
    expect(currentZone(a, 'M15')?.id).toBe('m15');
    expect(zoneEvidence(above, a).beyond).toMatch(/no closed D1 candle has broken it yet/);
    expect(beyondZone({ ...above, status: 'BROKEN' }, 3885)).toBe(false);
  });
});

describe('zone evidence', () => {
  const candles: Candle[] = Array.from({ length: 60 }, (_, i) => ({ time: T + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1000, isClosed: true }) as Candle);
  candles[10]!.volume = 3000; // the reaction bar (T + 9000)
  const levels: KeyLevel[] = [{ kind: 'PDL', label: 'Prev Day Low', price: 3872, time: T, windowFrom: T, windowTo: T, windowLabel: 'W', sourceTf: 'M5', status: 'COMPLETE', note: '' }];
  const pools = [{ side: 'SSL', level: 3866, state: 'ACTIVE', timeframe: 'M15', source: 'equal' }] as unknown as LiquidityPool[];
  const blocks = [{ type: 'bullish', low: 3868, high: 3874, state: 'FRESH', timeframe: 'H1' }] as unknown as OrderBlock[];
  const ev = zoneEvidence(zone({ id: 'z' }), input({ candles: { M15: candles }, levels, pools, blocks }));

  it('measures real reaction-bar volume against the timeframe median', () => {
    expect(ev.items.find((i) => i.kind === 'volume')!.text).toMatch(/volume 3,000 = 3\.0× the M15 median/);
    expect(ev.items.find((i) => i.kind === 'volume')!.source).toMatch(/not order ownership/);
  });

  it('key levels, inferred liquidity and order blocks are attributed and labelled', () => {
    expect(ev.items.find((i) => i.kind === 'level')!.text).toMatch(/Prev Day Low 3,872\.0/);
    const liq = ev.items.find((i) => i.kind === 'liquidity')!;
    expect(liq).toMatchObject({ inferred: true });
    expect(liq.source).toMatch(/INFERRED from price structure, not order-book data/);
    expect(ev.items.find((i) => i.kind === 'orderBlock')!.text).toMatch(/H1 bullish order block/);
  });

  it('confirmation / invalidation quote the engine rules exactly', () => {
    expect(ev.invalidationPrice).toBeCloseTo(3870 - 0.1 * 12);
    expect(ev.invalidation[0]).toBe('2 consecutive M15 closes below 3,868.8');
    expect(ev.invalidation[1]).toMatch(/displacement close below 3,858\.0 \(a wick alone never breaks the zone\)/);
    expect(ev.confirmation[0]).toMatch(/closed candle above 3,892\.0 \(1 ATR beyond the zone\) within 12 bars/);
    expect(ev.scoreLines.reduce((s, l) => s + l.contribution, 0)).toBeGreaterThan(0);
  });
});

describe('scenarios — checklists, never probabilities', () => {
  const sup = zone({ id: 'sup', zoneLow: 3870, zoneHigh: 3880, interactions: [ix({ startTime: T + 9000 })] });
  const res = zone({ id: 'res', role: 'resistance', type: 'resistance', zoneLow: 3920, zoneHigh: 3930, distanceAtr: 3, distanceFromPrice: 43 });

  it('all bullish conditions met → CONDITIONS MET, with levels and no signal wording', () => {
    const [bull, , no] = scenarios(input({ zones: [sup, res] }), 'M15');
    expect(bull!.conditions.map((c) => c.state)).toEqual(['MET', 'MET', 'MET', 'MET', 'MET', 'MET']);
    expect(bull!.status).toBe('CONDITIONS MET');
    expect(bull!.levels.map((l) => l.label)).toEqual(['Zone', 'Invalidation (engine break level)', 'Next opposing M15 zone']);
    expect(bull!.note).toMatch(/not an order or a signal/);
    expect(no!.status).toBe('NOT ACTIVE');
  });

  it('stale / closed data → bullish WAITING and No-Trade ACTIVE', () => {
    const [bull, , no] = scenarios(input({ zones: [sup, res], feed: CLOSED }), 'M15');
    expect(bull!.status).toBe('WAITING');
    expect(bull!.conditions[0]).toMatchObject({ state: 'NOT_MET' });
    expect(no!.status).toBe('ACTIVE');
  });

  it('H1 against the side, or no M15 confirmation, keeps it WAITING', () => {
    expect(scenarios(input({ zones: [sup, res], smc: smc('BEARISH', 'bullish') }), 'M15')[0]!.status).toBe('WAITING');
    expect(scenarios(input({ zones: [sup, res], smc: smc('BULLISH') }), 'M15')[0]!.status).toBe('WAITING');
  });

  it('an untested zone can never have a confirming structure break', () => {
    const untested = zone({ id: 'u', interactions: [], touchCount: 0, rejectionCount: 0 });
    const bull = scenarios(input({ zones: [untested, res] }), 'M15')[0]!;
    expect(bull.conditions[2]).toMatchObject({ state: 'NOT_MET' });
    expect(bull.conditions[3]).toMatchObject({ state: 'NOT_MET' });
    expect(bull.status).toBe('WAITING');
  });

  it('no rated zones → NOT AVAILABLE and No-Trade ACTIVE', () => {
    const [bull, bear, no] = scenarios(input({ zones: [zone({ id: 'thin', createdAt: 0 })] }), 'M15');
    expect([bull!.status, bear!.status, no!.status]).toEqual(['NOT AVAILABLE', 'NOT AVAILABLE', 'ACTIVE']);
  });

  it('no percentage or confidence anywhere in the output', () => {
    const out = JSON.stringify([scenarios(input({ zones: [sup, res] }), 'M15'), zoneEvidence(sup, input({})), mtfMap(input({ zones: [sup, res] }))]);
    expect(out).not.toMatch(/%|confidence|probab/i);
  });
});
