import { OB_TF_RANK, OB_TF_WEIGHT, type OBSettings } from '../../engines/orderBlocks/config';
import { isLiveBlock } from '../../engines/orderBlocks/mtf';
import type { OBConfluence, OBSnapshot, OBState, OBTest, OBType, OrderBlock } from '../../engines/orderBlocks/types';
import type { Candle, ConnectionState, FeedStatusCode, Timeframe } from '../../types/market';

/* ------------------------------ data state ------------------------------ */

export type OBViewState = 'LIVE' | 'REPLAY' | 'INSUFFICIENT_HISTORY' | 'STALE' | 'OFFLINE' | 'ERROR' | 'UNAVAILABLE';

export const OB_VIEW_TITLE: Record<OBViewState, string> = {
  LIVE: 'ORDER BLOCKS LIVE',
  REPLAY: 'ORDER BLOCKS REPLAY',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT HISTORY',
  STALE: 'DATA STALE',
  OFFLINE: 'MARKET DATA OFFLINE',
  ERROR: 'ERROR',
  UNAVAILABLE: 'DATA UNAVAILABLE',
};

/** Truthful page state: blocks are LIVE only with a live/delayed feed; last-known analysis is DATA STALE. */
export function obViewState(o: {
  tradable: boolean;
  connection: ConnectionState;
  feedCode?: FeedStatusCode | null;
  snapshots: readonly (OBSnapshot | undefined)[];
  replay?: boolean;
}): OBViewState {
  if (!o.tradable) return 'UNAVAILABLE';
  const snaps = o.snapshots.filter((s): s is OBSnapshot => !!s);
  const ready = snaps.some((s) => s.state === 'READY');
  if (o.replay) return ready ? 'REPLAY' : 'INSUFFICIENT_HISTORY';
  if (o.feedCode === 'ERROR') return 'ERROR';
  const live = (o.connection === 'LIVE' || o.connection === 'DELAYED') && o.feedCode !== 'STALE';
  if (ready) return live ? 'LIVE' : 'STALE';
  if (snaps.some((s) => s.barsProcessed > 0)) return 'INSUFFICIENT_HISTORY';
  return live ? 'INSUFFICIENT_HISTORY' : 'OFFLINE';
}

export const hasBlocks = (s: OBViewState) => s === 'LIVE' || s === 'STALE' || s === 'REPLAY';

/* ------------------------------- filtering ------------------------------ */

export type TypeFilter = 'all' | OBType;
export type TfFilter = 'ALL' | Timeframe;
export type StateFilter = 'ALL' | Exclude<OBState, 'EXPIRED'>;
export interface BlockFilters {
  type: TypeFilter;
  tf: TfFilter;
  state: StateFilter;
}
export const STATE_FILTERS: readonly StateFilter[] = ['ALL', 'FRESH', 'ACTIVE', 'TESTED', 'MITIGATED', 'INVALIDATED'];

/** EXPIRED blocks are history only and never listed. */
export const isListed = (b: OrderBlock) => b.state !== 'EXPIRED';

export function filterBlocks(blocks: readonly OrderBlock[], f: BlockFilters): OrderBlock[] {
  return blocks.filter((b) => isListed(b) && (f.type === 'all' || b.type === f.type) && (f.tf === 'ALL' || b.timeframe === f.tf) && (f.state === 'ALL' || b.state === f.state));
}

const STATE_RANK: Record<OBState, number> = { FRESH: 0, ACTIVE: 0, TESTED: 0, MITIGATED: 1, INVALIDATED: 2, EXPIRED: 3 };

/**
 * Relevance (display order only — never changes engine output): live blocks first,
 * then score − 2 × min(distance in ATR, 20), then higher timeframe, then id.
 */
export const relevance = (b: OrderBlock) => b.score.total - 2 * Math.min(Math.abs(b.distanceAtr ?? 20), 20);

export function sortByRelevance(blocks: readonly OrderBlock[]): OrderBlock[] {
  return [...blocks].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      relevance(b) - relevance(a) ||
      OB_TF_RANK[b.timeframe] - OB_TF_RANK[a.timeframe] ||
      (a.id < b.id ? -1 : 1),
  );
}

export type BlockSortKey = 'relevance' | 'score' | 'distance' | 'tests' | 'tf' | 'mitigation';
export function sortBlocks(blocks: readonly OrderBlock[], key: BlockSortKey): OrderBlock[] {
  if (key === 'relevance') return sortByRelevance(blocks);
  const by: Record<Exclude<BlockSortKey, 'relevance'>, (b: OrderBlock) => number> = {
    score: (b) => -b.score.total,
    distance: (b) => Math.abs(b.distanceAtr ?? Infinity),
    tests: (b) => -b.tests.length,
    tf: (b) => -OB_TF_RANK[b.timeframe],
    mitigation: (b) => -b.mitigationPct,
  };
  const f = by[key];
  return [...blocks].sort((a, b) => f(a) - f(b) || (a.id < b.id ? -1 : 1));
}

/* -------------------------------- labels -------------------------------- */

export const typeShort = (t: OBType) => (t === 'bullish' ? 'BULL' : 'BEAR');
/** "BULL OB H1 · 82". */
export const chartLabel = (b: OrderBlock) => `${typeShort(b.type)} OB ${b.timeframe} · ${b.score.total}`;
export const chartSublabel = (b: OrderBlock) => `${b.breakKind} · ${b.state}${b.tests.length ? ` · ${b.tests.length} test${b.tests.length === 1 ? '' : 's'}` : ''}${b.mitigationPct > 0 ? ` · ${Math.round(b.mitigationPct)}%` : ''}`;

/* --------------------------- chart drawables ---------------------------- */

export interface OBDrawable {
  id: string;
  type: OBType;
  low: number;
  high: number;
  from: number;
  /** The zone stops at invalidation / expiry. */
  to: number | null;
  emphasis: number;
  label: string;
  sublabel: string;
  /** MITIGATED / INVALIDATED: drawn dimmer. */
  spent: boolean;
  selected: boolean;
  highlighted: boolean;
}

/** Blocks drawn on the chart: live blocks above the score floor, capped; the selected block is always drawn. */
export function obDrawables(o: { blocks: readonly OrderBlock[]; filters: BlockFilters; settings: OBSettings; selectedId: string | null; confluence: OBConfluence | null }): OBDrawable[] {
  const shown = sortByRelevance(filterBlocks(o.blocks, o.filters))
    .filter((b) => b.id === o.selectedId || ((isLiveBlock(b) || (o.filters.state !== 'ALL' && b.state === o.filters.state)) && b.score.total >= o.settings.minDisplayScore))
    .slice(0, o.settings.maxDisplayedBlocks);
  const selected = o.blocks.find((b) => b.id === o.selectedId);
  if (selected && !shown.includes(selected) && isListed(selected)) shown.push(selected);
  const inConfluence = new Set(o.confluence?.blockIds ?? []);
  return shown.map((b) => ({
    id: b.id,
    type: b.type,
    low: b.low,
    high: b.high,
    from: b.createdAt,
    to: b.invalidatedAt ?? b.expiredAt,
    emphasis: OB_TF_WEIGHT[b.timeframe] / 100,
    label: chartLabel(b),
    sublabel: chartSublabel(b),
    spent: !isLiveBlock(b),
    selected: b.id === o.selectedId,
    highlighted: inConfluence.has(b.id),
  }));
}

/* ------------------------------ mitigations ----------------------------- */

export interface MitigationEvent {
  block: OrderBlock;
  test: OBTest;
  /** Sequence number of this test for the block (1-based). */
  n: number;
}

/** Every recorded test (return into a zone), newest first. */
export function mitigationEvents(blocks: readonly OrderBlock[]): MitigationEvent[] {
  return blocks
    .flatMap((block) => block.tests.map((test, k) => ({ block, test, n: k + 1 })))
    .sort((a, b) => b.test.time - a.test.time || OB_TF_RANK[b.block.timeframe] - OB_TF_RANK[a.block.timeframe] || (a.block.id < b.block.id ? -1 : 1));
}

/** Candles for the Recent Mitigation excerpt: origin → a few bars after the test, at most `max` bars. */
export function excerptCandles(candles: readonly Candle[], block: OrderBlock, testTime: number, max = 40): Candle[] {
  const iTest = candles.findIndex((c) => c.time === testTime);
  if (iTest < 0) return [];
  const iOrigin = candles.findIndex((c) => c.time === block.originTime);
  const end = Math.min(candles.length - 1, iTest + 4);
  const start = Math.max(iOrigin >= 0 ? iOrigin - 2 : 0, end - max + 1, 0);
  return candles.slice(start, end + 1);
}
