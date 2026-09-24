import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { TIMEFRAMES } from '../../config/instrument';
import { LIQUIDITY_SCORE_WEIGHTS, type LiquiditySettings } from '../../engines/liquidity/config';
import type { LiquidityCluster, LiquidityPool, LiquiditySnapshot } from '../../engines/liquidity/types';
import { formatPrice, formatSigned } from '../../utils/format';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import { fmtTime } from './format';
import {
  filterPools,
  hasPools,
  isListed,
  LIQUIDITY_VIEW_TITLE,
  sortPools,
  sourceLabel,
  stateLabel,
  sweepLabel,
  type LiquidityViewState,
  type PoolFilters,
  type PoolSortKey,
  type StateFilter,
} from './liquidityView';

export type LiquidityTab = 'pools' | 'sweeps' | 'mtf' | 'analysis' | 'settings';
const TABS: { id: LiquidityTab; label: string }[] = [
  { id: 'pools', label: 'Pools' },
  { id: 'sweeps', label: 'Sweeps' },
  { id: 'mtf', label: 'Multi-Timeframe' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'settings', label: 'Settings' },
];
const STATES: StateFilter[] = ['ALL', 'ACTIVE', 'TESTED', 'SWEPT', 'CONSUMED'];
const VISIBLE_ROWS = 15;

interface Props {
  tab: LiquidityTab;
  onTab: (t: LiquidityTab) => void;
  viewState: LiquidityViewState;
  pools: readonly LiquidityPool[];
  clusters: readonly LiquidityCluster[];
  byTimeframe: Partial<Record<string, LiquiditySnapshot>>;
  decimals: number;
  tz: string;
  filters: PoolFilters;
  onFilters: (f: PoolFilters) => void;
  sort: PoolSortKey;
  onSort: (k: PoolSortKey) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  selectedClusterId: string | null;
  onSelectCluster: (id: string) => void;
  symbol: string;
  replayLabel: string | null;
  settings: LiquiditySettings;
}

function Chip<T extends string>({ value, current, onClick, children, tone }: { value: T; current: T; onClick: (v: T) => void; children: ReactNode; tone?: string }) {
  return (
    <button type="button" className={`srchip ${tone ?? ''}`} aria-pressed={value === current} onClick={() => onClick(value)}>
      {children}
    </button>
  );
}

export const SideBadge = ({ side }: { side: 'BSL' | 'SSL' }) => <span className={`lqside lqside--${side.toLowerCase()}`}>{side}</span>;
export const StateBadge = ({ pool }: { pool: LiquidityPool }) => <span className={`lqstate lqstate--${pool.state.toLowerCase()}${pool.reclaimed ? ' is-reclaimed' : ''}`}>{stateLabel(pool)}</span>;

export function LiquidityPanel(p: Props) {
  const ready = hasPools(p.viewState);
  const listed = p.pools.filter(isListed);
  const pill = p.replayLabel && ready ? 'LIQUIDITY REPLAY' : LIQUIDITY_VIEW_TITLE[p.viewState];
  return (
    <section className="panel srpanel lqpanel" aria-labelledby="lqpanel-title">
      <header className="srpanel__head">
        <div className="srpanel__title">
          <h2 id="lqpanel-title">Liquidity</h2>
          <span className="srpanel__info" title="Price/candle liquidity (resting stops above highs and below lows). Not order-book depth. Liquidity taken is not a reversal and never a signal.">
            <Info size={14} />
          </span>
        </div>
        <div className="srpanel__status">
          <StatusPill tone={p.replayLabel ? 'info' : p.viewState === 'LIVE' ? 'ok' : p.viewState === 'ERROR' || p.viewState === 'OFFLINE' ? 'bad' : 'warn'} label={pill} compact />
          <span className="srpanel__sub">{p.replayLabel ?? (ready ? `${listed.length} pools · ${p.symbol}${p.viewState === 'STALE' ? ' · last received candles' : ''}` : 'No live data available')}</span>
        </div>
      </header>
      <div className="srtabs" role="tablist" aria-label="Liquidity views">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={p.tab === t.id} className="srtabs__tab" onClick={() => p.onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="srpanel__body">
        {p.tab === 'pools' && <PoolsTab {...p} ready={ready} />}
        {p.tab === 'sweeps' && <SweepsTab {...p} ready={ready} />}
        {p.tab === 'mtf' && <MtfTab {...p} ready={ready} />}
        {p.tab === 'analysis' && <AnalysisTab {...p} ready={ready} />}
        {p.tab === 'settings' && <SettingsTab settings={p.settings} />}
      </div>
    </section>
  );
}

function NotReady({ p }: { p: Props }) {
  return <EmptyState icon={<Info size={18} />} title={LIQUIDITY_VIEW_TITLE[p.viewState]} message={`No liquidity for ${p.symbol}. Pools appear only after real candle history is analysed.`} />;
}

function PoolsTab(p: Props & { ready: boolean }) {
  const set = (patch: Partial<PoolFilters>) => p.onFilters({ ...p.filters, ...patch });
  const count = (pred: (x: LiquidityPool) => boolean) => p.pools.filter((x) => isListed(x) && pred(x)).length;
  const rows = sortPools(filterPools(p.pools, p.filters), p.sort);
  const visible = p.showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  const th = (key: PoolSortKey, label: string, cls = '') => (
    <th className={cls} aria-sort={p.sort === key ? 'descending' : 'none'}>
      <button type="button" onClick={() => p.onSort(p.sort === key ? 'relevance' : key)}>{label}</button>
    </th>
  );
  return (
    <>
      <div className="srfilters" aria-label="Pool filters">
        <div className="srfilters__row" role="group" aria-label="Side">
          <Chip value="all" current={p.filters.side} onClick={(side) => set({ side })}>All ({count(() => true)})</Chip>
          <Chip value="BSL" current={p.filters.side} onClick={(side) => set({ side })}>BSL ({count((x) => x.side === 'BSL')})</Chip>
          <Chip value="SSL" current={p.filters.side} onClick={(side) => set({ side })}>SSL ({count((x) => x.side === 'SSL')})</Chip>
        </div>
        <div className="srfilters__row" role="group" aria-label="Timeframe">
          <Chip value="ALL" current={p.filters.tf} onClick={(tf) => set({ tf })} tone="srchip--tf">ALL TF</Chip>
          {TIMEFRAMES.map((tf) => (
            <Chip key={tf} value={tf} current={p.filters.tf} onClick={(v) => set({ tf: v })} tone="srchip--tf">{tf}</Chip>
          ))}
        </div>
        <div className="srfilters__row" role="group" aria-label="State">
          {STATES.map((s) => (
            <Chip key={s} value={s} current={p.filters.state} onClick={(state) => set({ state })}>
              {s === 'ALL' ? 'All open & swept' : s[0] + s.slice(1).toLowerCase()}
              {s !== 'ALL' && ` (${count((x) => x.state === s)})`}
            </Chip>
          ))}
        </div>
      </div>
      {!p.ready ? (
        <NotReady p={p} />
      ) : (
        <div className="srtable-wrap">
          <table className="srtable lqtable">
            <thead>
              <tr>
                <th>Type</th>
                {th('tf', 'TF')}
                <th className="num-col">Price / Range</th>
                {th('score', 'Score', 'num-col')}
                {th('tests', 'Tests', 'num-col')}
                <th>State</th>
                {th('distance', 'Distance', 'num-col')}
              </tr>
            </thead>
            <tbody>
              {visible.map((x) => (
                <tr
                  key={x.id}
                  className={x.id === p.selectedId ? 'is-selected' : ''}
                  onClick={() => p.onSelect(x.id)}
                  aria-selected={x.id === p.selectedId}
                  tabIndex={0}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), p.onSelect(x.id))}
                  data-testid={`pool-row-${x.id}`}
                >
                  <td><SideBadge side={x.side} /></td>
                  <td>{x.timeframe}</td>
                  <td className="num">
                    {x.rangeLow === x.rangeHigh ? formatPrice(x.level, p.decimals) : `${formatPrice(x.rangeLow, p.decimals)} – ${formatPrice(x.rangeHigh, p.decimals)}`}
                    {x.source === 'equal' && <span className="lqsrc">{sourceLabel(x)}</span>}
                  </td>
                  <td className="num"><span className="srscore">{x.score.total}</span></td>
                  <td className="num">{x.tests.length}</td>
                  <td><StateBadge pool={x} /></td>
                  <td className={`num ${(x.distance ?? 0) >= 0 ? 'up' : 'down'}`}>{formatSigned(x.distance, p.decimals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="srtable__none">No liquidity matches these filters.</p>}
          {!p.showAll && rows.length > VISIBLE_ROWS && (
            <button type="button" className="btn-ghost srtable__more" onClick={() => p.onShowAll(true)}>
              Showing the {VISIBLE_ROWS} most relevant of {rows.length} pools · Show all
            </button>
          )}
        </div>
      )}
    </>
  );
}

function SweepsTab(p: Props & { ready: boolean }) {
  if (!p.ready) return <NotReady p={p} />;
  const events = p.pools
    .flatMap((pool) => pool.sweeps.map((sweep) => ({ pool, sweep })))
    .filter((x) => p.filters.tf === 'ALL' || x.pool.timeframe === p.filters.tf)
    .sort((a, b) => b.sweep.time - a.sweep.time)
    .slice(0, p.showAll ? 500 : 40);
  return events.length === 0 ? (
    <p className="srtable__none">No sweeps recorded{p.filters.tf === 'ALL' ? '' : ` on ${p.filters.tf}`}.</p>
  ) : (
    <div className="srtable-wrap">
      <table className="srtable lqtable" data-testid="sweeps-table">
        <thead>
          <tr><th>Time</th><th>TF</th><th>Side</th><th className="num-col">Level</th><th className="num-col">Extreme</th><th>Kind</th><th>Outcome</th></tr>
        </thead>
        <tbody>
          {events.map(({ pool, sweep }) => (
            <tr key={sweep.id} className={pool.id === p.selectedId ? 'is-selected' : ''} onClick={() => p.onSelect(pool.id)} tabIndex={0}>
              <td>{fmtTime(sweep.time, p.tz)}</td>
              <td>{pool.timeframe}</td>
              <td><SideBadge side={sweep.side} /></td>
              <td className="num">{formatPrice(sweep.level, p.decimals)}</td>
              <td className="num">{formatPrice(sweep.extremePrice, p.decimals)}</td>
              <td>{sweep.kind === 'wick' ? 'Wick' : 'Close-through'}{sweep.sequence > 1 ? ` · #${sweep.sequence}` : ''}</td>
              <td className={`lqout lqout--${sweep.outcome}`}>{sweepLabel(sweep).replace(`${sweep.side} SWEPT · `, '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="lqnote">LIQUIDITY SWEPT ≠ REVERSAL CONFIRMED. Sweeps and reclaims are recorded facts, not trade signals.</p>
    </div>
  );
}

function MtfTab(p: Props & { ready: boolean }) {
  if (!p.ready) return <NotReady p={p} />;
  const byId = new Map(p.pools.map((x) => [x.id, x]));
  return p.clusters.length === 0 ? (
    <p className="srtable__none">No overlapping liquidity between independently analysed timeframes.</p>
  ) : (
    <ul className="lqclusters" data-testid="lq-clusters">
      {[...p.clusters].sort((a, b) => b.score - a.score).map((c) => (
        <li key={c.id}>
          <button type="button" className={`lqcluster ${c.id === p.selectedClusterId ? 'is-selected' : ''}`} onClick={() => p.onSelectCluster(c.id)}>
            <SideBadge side={c.side} />
            <span className="lqcluster__tfs">{c.timeframes.join(' · ')}</span>
            <span className="num">{formatPrice(c.low, p.decimals)}{c.high !== c.low ? ` – ${formatPrice(c.high, p.decimals)}` : ''}</span>
            <span className="srscore num">{c.score}</span>
            <span className="lqcluster__near num">{formatSigned(Math.min(...c.poolIds.map((id) => Math.abs(byId.get(id)?.distance ?? Infinity))), p.decimals)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AnalysisTab(p: Props & { ready: boolean }) {
  if (!p.ready) return <NotReady p={p} />;
  const listed = p.pools.filter(isListed);
  const open = listed.filter((x) => x.state === 'ACTIVE' || x.state === 'TESTED');
  const sweeps = listed.flatMap((x) => x.sweeps);
  return (
    <dl className="srfacts lqfacts">
      <div className="srfact"><dt>Open BSL / SSL</dt><dd className="num">{open.filter((x) => x.side === 'BSL').length} / {open.filter((x) => x.side === 'SSL').length}</dd></div>
      <div className="srfact"><dt>Equal highs / lows pools</dt><dd className="num">{listed.filter((x) => x.source === 'equal' && x.side === 'BSL').length} / {listed.filter((x) => x.source === 'equal' && x.side === 'SSL').length}</dd></div>
      <div className="srfact"><dt>Sweeps (reclaimed · accepted)</dt><dd className="num">{sweeps.length} ({sweeps.filter((e) => e.reclaimed).length} · {sweeps.filter((e) => e.outcome === 'accepted').length})</dd></div>
      <div className="srfact"><dt>MTF clusters</dt><dd className="num">{p.clusters.length}</dd></div>
      {TIMEFRAMES.map((tf) => {
        const s = p.byTimeframe[tf];
        return (
          <div className="srfact" key={tf}>
            <dt>{tf}</dt>
            <dd className="num">{s ? (s.state === 'READY' ? `${s.pools.filter(isListed).length} pools · ${s.barsProcessed} bars` : `${s.state === 'INSUFFICIENT_HISTORY' ? 'insufficient history' : 'no data'} (${s.barsProcessed})`) : '—'}</dd>
          </div>
        );
      })}
      <p className="lqnote">Context only. Liquidity v1 produces no trade signals, entries, targets or stops.</p>
    </dl>
  );
}

function SettingsTab({ settings }: { settings: LiquiditySettings }) {
  const rows: [string, string][] = [
    ['Swing confirmation', `${settings.swingLeft} bars left · ${settings.swingRight} closed bars right`],
    ['Equal-level tolerance', `max(${settings.equalTolAtr} × ATR, ${settings.equalMinTicks} ticks)`],
    ['Qualification', `close ${settings.qualifyDisplacementAtr} ATR away (or equal highs/lows) within ${settings.qualifyWindowBars} bars`],
    ['Test band', `${settings.testTolAtr} ATR · ends ${settings.testSeparationAtr} ATR away`],
    ['Sweep', 'closed bar beyond level ± tolerance'],
    ['Reclaim', `close back on the resting side within ${settings.reclaimWindowBars} bars`],
    ['Acceptance (consumed)', `${settings.acceptCloses} closes beyond ${settings.acceptTolAtr} ATR, or 1 close beyond ${settings.acceptDisplacementAtr} ATR`],
    ['History required', `${settings.minHistoryBars} closed bars`],
    ['Score weights', Object.entries(LIQUIDITY_SCORE_WEIGHTS).map(([k, w]) => `${k} ${w}`).join(' · ')],
  ];
  return (
    <div className="lqsettings">
      <p className="srmuted">Liquidity v1 uses fixed, documented defaults, independent of the S&amp;R settings.</p>
      <dl className="srfacts">
        {rows.map(([k, v]) => (
          <div className="srfact" key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}
