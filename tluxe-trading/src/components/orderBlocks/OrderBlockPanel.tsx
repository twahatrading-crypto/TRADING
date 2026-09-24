import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { TIMEFRAMES } from '../../config/instrument';
import { OB_SCORE_WEIGHTS, type OBSettings } from '../../engines/orderBlocks/config';
import type { OBConfluence, OBSnapshot, OBType, OrderBlock } from '../../engines/orderBlocks/types';
import { formatPrice, formatSigned } from '../../utils/format';
import { fmtTime } from './format';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import {
  filterBlocks,
  hasBlocks,
  isListed,
  mitigationEvents,
  OB_VIEW_TITLE,
  sortBlocks,
  STATE_FILTERS,
  typeShort,
  type BlockFilters,
  type BlockSortKey,
  type OBViewState,
} from './obView';

export type OBTab = 'blocks' | 'mitigations' | 'mtf' | 'analysis' | 'settings';
const TABS: { id: OBTab; label: string }[] = [
  { id: 'blocks', label: 'Blocks' },
  { id: 'mitigations', label: 'Mitigations' },
  { id: 'mtf', label: 'Multi-Timeframe' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'settings', label: 'Settings' },
];
const VISIBLE_ROWS = 15;

interface Props {
  tab: OBTab;
  onTab: (t: OBTab) => void;
  viewState: OBViewState;
  blocks: readonly OrderBlock[];
  confluences: readonly OBConfluence[];
  byTimeframe: Partial<Record<string, OBSnapshot>>;
  decimals: number;
  tz: string;
  filters: BlockFilters;
  onFilters: (f: BlockFilters) => void;
  sort: BlockSortKey;
  onSort: (k: BlockSortKey) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  selectedConfluenceId: string | null;
  onSelectConfluence: (id: string) => void;
  symbol: string;
  replayLabel: string | null;
  settings: OBSettings;
  onBoundaryMode: (m: OBSettings['boundaryMode']) => void;
  settingsLocked: boolean;
}

function Chip<T extends string>({ value, current, onClick, children, tone }: { value: T; current: T; onClick: (v: T) => void; children: ReactNode; tone?: string }) {
  return (
    <button type="button" className={`srchip ${tone ?? ''}`} aria-pressed={value === current} onClick={() => onClick(value)}>
      {children}
    </button>
  );
}

export const TypeBadge = ({ type }: { type: OBType }) => <span className={`obtype obtype--${type}`}>{typeShort(type)}</span>;
export const OBStateBadge = ({ block }: { block: OrderBlock }) => <span className={`obstate obstate--${block.state.toLowerCase()}`}>{block.state}</span>;

export function OrderBlockPanel(p: Props) {
  const ready = hasBlocks(p.viewState);
  const listed = p.blocks.filter(isListed);
  const pill = p.replayLabel && ready ? 'ORDER BLOCKS REPLAY' : OB_VIEW_TITLE[p.viewState];
  return (
    <section className="panel srpanel obpanel" aria-labelledby="obpanel-title">
      <header className="srpanel__head">
        <div className="srpanel__title">
          <h2 id="obpanel-title">Order Blocks</h2>
          <span className="srpanel__info" title="Zones where a displacement began that broke confirmed structure (BOS / CHOCH). Descriptive context only — never a trade signal.">
            <Info size={14} />
          </span>
        </div>
        <div className="srpanel__status">
          <StatusPill tone={p.replayLabel ? 'info' : p.viewState === 'LIVE' ? 'ok' : p.viewState === 'ERROR' || p.viewState === 'OFFLINE' ? 'bad' : 'warn'} label={pill} compact />
          <span className="srpanel__sub">{p.replayLabel ?? (ready ? `${listed.length} blocks · ${p.symbol}${p.viewState === 'STALE' ? ' · last received candles' : ''}` : 'No live data available')}</span>
        </div>
      </header>
      <div className="srtabs" role="tablist" aria-label="Order Block views">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={p.tab === t.id} className="srtabs__tab" onClick={() => p.onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="srpanel__body">
        {p.tab === 'blocks' && <BlocksTab {...p} ready={ready} />}
        {p.tab === 'mitigations' && <MitigationsTab {...p} ready={ready} />}
        {p.tab === 'mtf' && <MtfTab {...p} ready={ready} />}
        {p.tab === 'analysis' && <AnalysisTab {...p} ready={ready} />}
        {p.tab === 'settings' && <SettingsTab {...p} />}
      </div>
    </section>
  );
}

function NotReady({ p }: { p: Props }) {
  return <EmptyState icon={<Info size={18} />} title={OB_VIEW_TITLE[p.viewState]} message={`No order blocks for ${p.symbol}. Blocks appear only after real candle history is analysed.`} />;
}

function Filters(p: Props) {
  const set = (patch: Partial<BlockFilters>) => p.onFilters({ ...p.filters, ...patch });
  const count = (pred: (x: OrderBlock) => boolean) => p.blocks.filter((x) => isListed(x) && pred(x)).length;
  return (
    <div className="srfilters" aria-label="Order Block filters">
      <div className="srfilters__row" role="group" aria-label="Type">
        <Chip value="all" current={p.filters.type} onClick={(type) => set({ type })}>All ({count(() => true)})</Chip>
        <Chip value="bullish" current={p.filters.type} onClick={(type) => set({ type })}>Bullish ({count((x) => x.type === 'bullish')})</Chip>
        <Chip value="bearish" current={p.filters.type} onClick={(type) => set({ type })}>Bearish ({count((x) => x.type === 'bearish')})</Chip>
      </div>
      <div className="srfilters__row" role="group" aria-label="Timeframe">
        <Chip value="ALL" current={p.filters.tf} onClick={(tf) => set({ tf })} tone="srchip--tf">ALL TF</Chip>
        {TIMEFRAMES.map((tf) => (
          <Chip key={tf} value={tf} current={p.filters.tf} onClick={(v) => set({ tf: v })} tone="srchip--tf">{tf}</Chip>
        ))}
      </div>
      <div className="srfilters__row" role="group" aria-label="State">
        {STATE_FILTERS.map((s) => (
          <Chip key={s} value={s} current={p.filters.state} onClick={(state) => set({ state })}>
            {s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase()}
            {s !== 'ALL' && ` (${count((x) => x.state === s)})`}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function BlocksTab(p: Props & { ready: boolean }) {
  const rows = sortBlocks(filterBlocks(p.blocks, p.filters), p.sort);
  const visible = p.showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  const th = (key: BlockSortKey, label: string, cls = '') => (
    <th className={cls} aria-sort={p.sort === key ? 'descending' : 'none'}>
      <button type="button" onClick={() => p.onSort(p.sort === key ? 'relevance' : key)}>{label}</button>
    </th>
  );
  return (
    <>
      <Filters {...p} />
      {!p.ready ? (
        <NotReady p={p} />
      ) : (
        <div className="srtable-wrap">
          <table className="srtable obtable">
            <thead>
              <tr>
                <th>Type</th>
                {th('tf', 'TF')}
                <th className="num-col">Zone Low</th>
                <th className="num-col">Zone High</th>
                {th('score', 'Score', 'num-col')}
                {th('tests', 'Tests', 'num-col')}
                {th('mitigation', 'Mitigation', 'num-col')}
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
                  data-testid={`ob-row-${x.id}`}
                >
                  <td><TypeBadge type={x.type} /></td>
                  <td>{x.timeframe}</td>
                  <td className="num">{formatPrice(x.low, p.decimals)}</td>
                  <td className="num">{formatPrice(x.high, p.decimals)}</td>
                  <td className="num"><span className="srscore">{x.score.total}</span></td>
                  <td className="num">{x.tests.length}</td>
                  <td className="num">{Math.round(x.mitigationPct)}%</td>
                  <td><OBStateBadge block={x} /></td>
                  <td className={`num ${(x.distance ?? 0) >= 0 ? 'up' : 'down'}`}>{formatSigned(x.distance, p.decimals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="srtable__none">No order blocks match these filters.</p>}
          {!p.showAll && rows.length > VISIBLE_ROWS && (
            <button type="button" className="btn-ghost srtable__more" onClick={() => p.onShowAll(true)}>
              Showing the {VISIBLE_ROWS} most relevant of {rows.length} blocks · Show all
            </button>
          )}
        </div>
      )}
    </>
  );
}

function MitigationsTab(p: Props & { ready: boolean }) {
  if (!p.ready) return <NotReady p={p} />;
  const events = mitigationEvents(filterBlocks(p.blocks, { ...p.filters, state: 'ALL' })).slice(0, p.showAll ? 500 : 40);
  return events.length === 0 ? (
    <p className="srtable__none">No returns into an order block recorded{p.filters.tf === 'ALL' ? '' : ` on ${p.filters.tf}`}.</p>
  ) : (
    <div className="srtable-wrap">
      <table className="srtable obtable" data-testid="ob-mitigations">
        <thead>
          <tr><th>Time</th><th>TF</th><th>Type</th><th className="num-col">Zone</th><th className="num-col">Test</th><th className="num-col">Depth</th><th>State now</th></tr>
        </thead>
        <tbody>
          {events.map(({ block, test, n }) => (
            <tr key={`${block.id}:${test.time}`} className={block.id === p.selectedId ? 'is-selected' : ''} onClick={() => p.onSelect(block.id)} tabIndex={0}>
              <td>{fmtTime(test.time, p.tz)}</td>
              <td>{block.timeframe}</td>
              <td><TypeBadge type={block.type} /></td>
              <td className="num">{formatPrice(block.low, p.decimals)} – {formatPrice(block.high, p.decimals)}</td>
              <td className="num">#{n}</td>
              <td className="num">{Math.round(test.depthPct)}%</td>
              <td><OBStateBadge block={block} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="obnote">Depth = deepest wick into the zone from its facing edge, % of the zone height. A return into a zone is a recorded fact, not a signal.</p>
    </div>
  );
}

function MtfTab(p: Props & { ready: boolean }) {
  if (!p.ready) return <NotReady p={p} />;
  const byId = new Map(p.blocks.map((x) => [x.id, x]));
  return p.confluences.length === 0 ? (
    <p className="srtable__none">No overlapping order blocks between independently analysed timeframes.</p>
  ) : (
    <ul className="obconfs" data-testid="ob-confluences">
      {[...p.confluences].sort((a, b) => b.score - a.score).map((c) => (
        <li key={c.id}>
          <button type="button" className={`obconf ${c.id === p.selectedConfluenceId ? 'is-selected' : ''}`} onClick={() => p.onSelectConfluence(c.id)}>
            <TypeBadge type={c.type} />
            <span className="obconf__tfs">{c.timeframes.join(' · ')}</span>
            <span className="num">{formatPrice(c.low, p.decimals)} – {formatPrice(c.high, p.decimals)}</span>
            <span className="srscore num">{c.score}</span>
            <span className="obconf__near num">{formatSigned(Math.min(...c.blockIds.map((id) => Math.abs(byId.get(id)?.distance ?? Infinity))), p.decimals)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AnalysisTab(p: Props & { ready: boolean }) {
  if (!p.ready) return <NotReady p={p} />;
  const listed = p.blocks.filter(isListed);
  const live = listed.filter((x) => x.state === 'FRESH' || x.state === 'ACTIVE' || x.state === 'TESTED');
  const snaps = Object.values(p.byTimeframe).filter((s): s is OBSnapshot => !!s);
  const breaks = snaps.flatMap((s) => s.breaks);
  const withBlock = breaks.filter((b) => b.orderBlockId).length;
  const reasons = new Map<string, number>();
  for (const b of breaks) if (b.noBlockReason) {
    const k = b.noBlockReason.replace(/\s*\(.*\)$/, '');
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  return (
    <dl className="srfacts obfacts">
      <div className="srfact"><dt>Live bullish / bearish</dt><dd className="num">{live.filter((x) => x.type === 'bullish').length} / {live.filter((x) => x.type === 'bearish').length}</dd></div>
      <div className="srfact"><dt>Tested · Mitigated · Invalidated</dt><dd className="num">{listed.filter((x) => x.state === 'TESTED').length} · {listed.filter((x) => x.state === 'MITIGATED').length} · {listed.filter((x) => x.state === 'INVALIDATED').length}</dd></div>
      <div className="srfact"><dt>Structure breaks (BOS · CHOCH)</dt><dd className="num">{breaks.length} ({breaks.filter((b) => b.kind === 'BOS').length} · {breaks.filter((b) => b.kind === 'CHOCH').length})</dd></div>
      <div className="srfact"><dt>Breaks that produced a block</dt><dd className="num">{withBlock} / {breaks.length}</dd></div>
      {[...reasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
        <div className="srfact" key={k}><dt className="obreason">No block: {k}</dt><dd className="num">{n}</dd></div>
      ))}
      <div className="srfact"><dt>MTF confluences</dt><dd className="num">{p.confluences.length}</dd></div>
      {TIMEFRAMES.map((tf) => {
        const s = p.byTimeframe[tf];
        return (
          <div className="srfact" key={tf}>
            <dt>{tf}</dt>
            <dd className="num">
              {s
                ? s.state === 'READY'
                  ? `${s.blocks.filter(isListed).length} blocks · ${s.barsProcessed} bars · trend ${s.trend ?? '—'}${s.rejectedBars ? ` · ${s.rejectedBars} rejected` : ''}${s.gaps.length ? ` · ${s.gaps.length} gap${s.gaps.length > 1 ? 's' : ''}` : ''}`
                  : `${s.state === 'INSUFFICIENT_HISTORY' ? 'insufficient history' : 'no data'} (${s.barsProcessed}/${s.requiredBars})`
                : '—'}
            </dd>
          </div>
        );
      })}
      <p className="obnote">Context only. Order Blocks v1 produces no trade signals, entries, targets or stops.</p>
    </dl>
  );
}

function SettingsTab(p: Props) {
  const s = p.settings;
  const rows: [string, string][] = [
    ['Swing confirmation', `${s.swingLeft} bars left · ${s.swingRight} closed bars right`],
    ['Structure break', `a CLOSE beyond a confirmed swing (+${s.breakTolAtr} ATR); CHOCH against the trend, else BOS`],
    ['Displacement', `leg ≥ ${s.minLegAtr} ATR and one body ≥ ${s.minBodyAtr} ATR`],
    ['Origin', `last opposite candle within ${s.originLookback} bars (${s.originMode})`],
    ['Fresh → Active', `${s.freshBars} bars untouched`],
    ['Mitigated', `wick penetration ≥ ${s.mitigationPct}% of the zone height`],
    ['Invalidated', `a CLOSE beyond the far edge (+${s.invalidTolAtr} ATR)`],
    ['Expiry', s.expiryBars ? `${s.expiryBars} bars` : 'disabled'],
    ['History required', `${s.minHistoryBars} closed bars`],
    ['Score weights (%)', Object.entries(OB_SCORE_WEIGHTS).map(([k, w]) => `${k} ${w}`).join(' · ')],
  ];
  return (
    <div className="obsettings">
      <div className="obsettings__mode" role="group" aria-label="Boundary mode">
        <span className="obsettings__label">Boundary mode</span>
        <div className="seg">
          {(['wickBody', 'fullRange'] as const).map((m) => (
            <button key={m} type="button" className="seg__btn" aria-selected={s.boundaryMode === m} disabled={p.settingsLocked} onClick={() => p.onBoundaryMode(m)}>
              {m === 'wickBody' ? 'Wick + body (default)' : 'Full range'}
            </button>
          ))}
        </div>
      </div>
      <p className="srmuted obnote">
        {s.boundaryMode === 'wickBody' ? 'Bullish: origin low → body top. Bearish: body bottom → origin high.' : 'The full high–low range of the origin candle.'} Changing the mode recomputes every
        timeframe from the same real candles; boundaries are always frozen at confirmation.{p.settingsLocked ? ' Exit replay to change it.' : ''}
      </p>
      <dl className="srfacts">
        {rows.map(([k, v]) => (
          <div className="srfact" key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}
