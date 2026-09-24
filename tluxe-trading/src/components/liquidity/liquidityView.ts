import { LIQUIDITY_TF_RANK, LIQUIDITY_TF_WEIGHT, type LiquiditySettings } from '../../engines/liquidity/config';
import { isOpenLiquidity } from '../../engines/liquidity/mtf';
import type { LiquidityCluster, LiquidityPool, LiquiditySnapshot, PoolState, SweepEvent } from '../../engines/liquidity/types';
import type { ConnectionState, FeedStatusCode, Timeframe } from '../../types/market';

/* ------------------------------ data state ------------------------------ */

export type LiquidityViewState = 'LIVE' | 'REPLAY' | 'INSUFFICIENT_HISTORY' | 'STALE' | 'OFFLINE' | 'ERROR' | 'UNAVAILABLE';

export const LIQUIDITY_VIEW_TITLE: Record<LiquidityViewState, string> = {
  LIVE: 'LIQUIDITY LIVE',
  REPLAY: 'LIQUIDITY REPLAY',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT HISTORY',
  STALE: 'DATA STALE',
  OFFLINE: 'MARKET DATA OFFLINE',
  ERROR: 'ERROR',
  UNAVAILABLE: 'DATA UNAVAILABLE',
};

/**
 * Truthful page state. Pools are only LIVE with a live/delayed feed; last-known
 * analysis with a stale or lost feed is shown as DATA STALE, never as LIVE.
 */
export function liquidityViewState(o: {
  tradable: boolean;
  connection: ConnectionState;
  feedCode?: FeedStatusCode | null;
  snapshots: readonly (LiquiditySnapshot | undefined)[];
  replay?: boolean;
}): LiquidityViewState {
  if (!o.tradable) return 'UNAVAILABLE';
  const snaps = o.snapshots.filter((s): s is LiquiditySnapshot => !!s);
  const ready = snaps.some((s) => s.state === 'READY');
  if (o.replay) return ready ? 'REPLAY' : 'INSUFFICIENT_HISTORY';
  if (o.feedCode === 'ERROR') return 'ERROR';
  const live = (o.connection === 'LIVE' || o.connection === 'DELAYED') && o.feedCode !== 'STALE';
  if (ready) return live ? 'LIVE' : 'STALE';
  if (snaps.some((s) => s.barsProcessed > 0)) return 'INSUFFICIENT_HISTORY';
  return live ? 'INSUFFICIENT_HISTORY' : 'OFFLINE';
}

export const hasPools = (s: LiquidityViewState) => s === 'LIVE' || s === 'STALE' || s === 'REPLAY';

/* ------------------------------- filtering ------------------------------ */

export type SideFilter = 'all' | 'BSL' | 'SSL';
export type TfFilter = 'ALL' | Timeframe;
export type StateFilter = 'ALL' | 'ACTIVE' | 'TESTED' | 'SWEPT' | 'CONSUMED';
export interface PoolFilters {
  side: SideFilter;
  tf: TfFilter;
  state: StateFilter;
}

/** FORMING candidates and INVALIDATED pools are not liquidity and never listed. */
export const isListed = (p: LiquidityPool) => p.state !== 'FORMING' && p.state !== 'INVALIDATED';

export function filterPools(pools: readonly LiquidityPool[], f: PoolFilters): LiquidityPool[] {
  return pools.filter(
    (p) =>
      isListed(p) &&
      (f.side === 'all' || p.side === f.side) &&
      (f.tf === 'ALL' || p.timeframe === f.tf) &&
      (f.state === 'ALL' ? p.state !== 'CONSUMED' : p.state === f.state),
  );
}

const STATE_RANK: Record<PoolState, number> = { ACTIVE: 0, TESTED: 0, SWEPT: 1, CONSUMED: 2, FORMING: 3, INVALIDATED: 4 };

/**
 * Relevance (display order only — never changes engine output):
 * open liquidity first; then relevance = score − 2 × min(distance in ATR, 20)
 * (strong AND near beats strong but far); then higher timeframe; then id.
 */
export const relevance = (p: LiquidityPool) => p.score.total - 2 * Math.min(p.distanceAtr ?? 20, 20);

export function sortByRelevance(pools: readonly LiquidityPool[]): LiquidityPool[] {
  return [...pools].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      relevance(b) - relevance(a) ||
      (a.distanceAtr ?? Infinity) - (b.distanceAtr ?? Infinity) ||
      LIQUIDITY_TF_RANK[b.timeframe] - LIQUIDITY_TF_RANK[a.timeframe] ||
      (a.id < b.id ? -1 : 1),
  );
}

export type PoolSortKey = 'relevance' | 'score' | 'distance' | 'tests' | 'tf';
export function sortPools(pools: readonly LiquidityPool[], key: PoolSortKey): LiquidityPool[] {
  if (key === 'relevance') return sortByRelevance(pools);
  const by: Record<Exclude<PoolSortKey, 'relevance'>, (p: LiquidityPool) => number> = {
    score: (p) => -p.score.total,
    distance: (p) => p.distanceAtr ?? Infinity,
    tests: (p) => -p.tests.length,
    tf: (p) => -LIQUIDITY_TF_RANK[p.timeframe],
  };
  const f = by[key];
  return [...pools].sort((a, b) => f(a) - f(b) || (a.id < b.id ? -1 : 1));
}

/* -------------------------------- labels -------------------------------- */

export function stateLabel(p: LiquidityPool): string {
  if (p.state === 'SWEPT') return p.reclaimed ? 'SWEPT + RECLAIMED' : 'SWEPT';
  return p.state;
}

/** "EQH ×3" / "EQL ×2" / "SWING HIGH" / "SWING LOW". */
export function sourceLabel(p: LiquidityPool): string {
  if (p.source === 'equal') return `${p.side === 'BSL' ? 'EQH' : 'EQL'} ×${p.contributions.length}`;
  return p.side === 'BSL' ? 'SWING HIGH' : 'SWING LOW';
}

export const chartLabel = (p: LiquidityPool) => `${p.timeframe} ${p.side} | ${p.state === 'ACTIVE' || p.state === 'TESTED' ? p.score.total : stateLabel(p)}`;
export const chartSublabel = (p: LiquidityPool) => `${sourceLabel(p)} | ${p.tests.length} test${p.tests.length === 1 ? '' : 's'} | ${stateLabel(p)}`;

export function sweepLabel(e: SweepEvent): string {
  const base = `${e.side} SWEPT`;
  if (e.outcome === 'reclaimed') return `${base} · RECLAIMED`;
  if (e.outcome === 'accepted') return `${base} · ACCEPTED (continuation)`;
  if (e.outcome === 'returned') return `${base} · returned late`;
  return `${base} · pending`;
}

/* --------------------------- chart drawables ---------------------------- */

export interface LiquidityDrawable {
  id: string;
  side: 'BSL' | 'SSL';
  level: number;
  low: number;
  high: number;
  from: number;
  /** Ended at (consumed) — the band stops there. */
  to: number | null;
  emphasis: number;
  label: string;
  sublabel: string;
  taken: boolean;
  selected: boolean;
  highlighted: boolean;
}

export interface LiquidityMarker {
  time: number;
  side: 'BSL' | 'SSL';
  kind: 'sweep' | 'reclaim';
  text: string;
}

export function liquidityDrawables(o: {
  pools: readonly LiquidityPool[];
  filters: PoolFilters;
  settings: LiquiditySettings;
  selectedId: string | null;
  cluster: LiquidityCluster | null;
}): LiquidityDrawable[] {
  const shown = sortByRelevance(filterPools(o.pools, o.filters))
    .filter((p) => p.id === o.selectedId || p.score.total >= o.settings.minDisplayScore || p.state === 'SWEPT')
    .slice(0, o.settings.maxDisplayedPools);
  const selected = o.pools.find((p) => p.id === o.selectedId);
  if (selected && !shown.includes(selected) && isListed(selected)) shown.push(selected);
  const inCluster = new Set(o.cluster?.poolIds ?? []);
  return shown.map((p) => ({
    id: p.id,
    side: p.side,
    level: p.level,
    low: Math.min(p.rangeLow, p.level - (p.side === 'SSL' ? p.tolerance : 0)),
    high: Math.max(p.rangeHigh, p.level + (p.side === 'BSL' ? p.tolerance : 0)),
    from: p.createdAt,
    to: p.consumedAt,
    emphasis: LIQUIDITY_TF_WEIGHT[p.timeframe] / 100,
    label: chartLabel(p),
    sublabel: chartSublabel(p),
    taken: !isOpenLiquidity(p),
    selected: p.id === o.selectedId,
    highlighted: inCluster.has(p.id),
  }));
}

/**
 * Sweep / reclaim markers — real engine events only, on THIS chart timeframe's own
 * candles, for the pools that are drawn (plus the selected one), newest `max` events.
 * Keeps the chart readable: no marker spam on every candle.
 */
export function liquidityMarkers(pools: readonly LiquidityPool[], timeframe: Timeframe, opts: { poolIds?: ReadonlySet<string>; max?: number } = {}): LiquidityMarker[] {
  const events: LiquidityMarker[] = [];
  for (const p of pools) {
    if (p.timeframe !== timeframe || (opts.poolIds && !opts.poolIds.has(p.id))) continue;
    for (const e of p.sweeps) {
      const sameBarReclaim = e.reclaimed && e.reclaimTime === e.time;
      events.push({ time: e.time, side: e.side, kind: 'sweep', text: `${e.side} SWEPT${sameBarReclaim ? ' · RECLAIM' : ''}` });
      if (e.reclaimed && !sameBarReclaim && e.reclaimTime !== null) events.push({ time: e.reclaimTime, side: e.side, kind: 'reclaim', text: 'RECLAIM' });
    }
  }
  return events.sort((a, b) => a.time - b.time).slice(-(opts.max ?? 12));
}

/** Most recent sweep across the given pools (ties → higher timeframe). */
export function latestSweep(pools: readonly LiquidityPool[]): { pool: LiquidityPool; sweep: SweepEvent } | null {
  let best: { pool: LiquidityPool; sweep: SweepEvent } | null = null;
  for (const pool of pools) for (const sweep of pool.sweeps) {
    if (!best || sweep.time > best.sweep.time || (sweep.time === best.sweep.time && LIQUIDITY_TF_RANK[pool.timeframe] > LIQUIDITY_TF_RANK[best.pool.timeframe])) best = { pool, sweep };
  }
  return best;
}
