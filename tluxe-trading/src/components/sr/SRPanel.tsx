import { Info, RotateCcw } from 'lucide-react';
import { summarize } from '../../engines/sr/analysis';
import { SR_SETTING_SPECS, type SRSettings } from '../../engines/sr/settings';
import type { SRConfluence, SRMultiSnapshot, SRZone } from '../../engines/sr/types';
import type { Timeframe } from '../../types/market';
import { TIMEFRAMES } from '../../config/instrument';
import { formatPrice, formatSigned } from '../../utils/format';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import { roleLabel, SR_VIEW_TITLE, sortZones, STATUS_CLASS, tableRows, type SortKey, type SortSpec, type SRViewState, type ZoneFilters } from './srView';

export type SRTab = 'zones' | 'mtf' | 'analysis' | 'settings';

const PILL: Record<SRViewState, string> = {
  READY: 'S&R LIVE',
  STALE: 'Market Data Stale',
  NOT_CONNECTED: 'Data Not Connected',
  INSUFFICIENT_HISTORY: 'Insufficient History',
  CATEGORY: 'S&R Unavailable',
};

interface PanelProps {
  tab: SRTab;
  onTab: (t: SRTab) => void;
  viewState: SRViewState;
  multi: SRMultiSnapshot | null;
  decimals: number;
  filters: ZoneFilters;
  onFilters: (f: ZoneFilters) => void;
  sort: SortSpec;
  onSort: (s: SortSpec) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  selectedZoneId: string | null;
  onSelectZone: (id: string) => void;
  selectedConfluenceId: string | null;
  onSelectConfluence: (id: string) => void;
  settings: SRSettings;
  onSettings: (patch: Partial<SRSettings>) => void;
  onResetSettings: () => void;
  symbol: string;
  /** Replay: pill/subtitle describe the replay instead of the live feed. */
  replayLabel?: string | null;
}

const TABS: { id: SRTab; label: string }[] = [
  { id: 'zones', label: 'Zones' },
  { id: 'mtf', label: 'Multi-Timeframe' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'settings', label: 'Settings' },
];

export function SRPanel(p: PanelProps) {
  const ready = p.viewState === 'READY';
  const zonesShown = p.viewState === 'READY' || p.viewState === 'STALE';
  return (
    <section className="panel srpanel" aria-labelledby="srpanel-title">
      <header className="srpanel__head">
        <h2 id="srpanel-title" className="srpanel__title">
          Support &amp; Resistance
          <span className="srpanel__info" title="Zones are computed by the S&R engine from real closed candles only.">
            <Info size={14} />
          </span>
        </h2>
        <div className="srpanel__status">
          <StatusPill tone={p.replayLabel ? 'info' : ready ? 'ok' : 'warn'} label={p.replayLabel && ready ? 'S&R REPLAY' : PILL[p.viewState]} compact />
          <span className="srpanel__sub">
            {p.replayLabel
              ? `${p.multi?.zones.length ?? 0} zones · ${p.symbol} · ${p.replayLabel}`
              : zonesShown
                ? `${p.multi?.zones.length ?? 0} zones · ${p.symbol}${ready ? '' : ' · from last received candles'}`
                : 'No live data available'}
          </span>
        </div>
      </header>
      <div className="srtabs" role="tablist" aria-label="S&R views">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={p.tab === t.id} className="srtabs__tab" onClick={() => p.onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="srpanel__body">
        {p.tab === 'zones' && <ZonesTab {...p} />}
        {p.tab === 'mtf' && <MtfTab {...p} />}
        {p.tab === 'analysis' && <AnalysisTab {...p} />}
        {p.tab === 'settings' && <SettingsTab {...p} />}
      </div>
    </section>
  );
}

/* --------------------------------- Zones -------------------------------- */

function Chip<T extends string>({ value, current, onClick, children, tone }: { value: T; current: T; onClick: (v: T) => void; children: React.ReactNode; tone?: string }) {
  return (
    <button type="button" className={`srchip ${tone ?? ''}`} aria-pressed={value === current} onClick={() => onClick(value)}>
      {children}
    </button>
  );
}

const STATUS_FILTERS = ['ALL', 'FRESH', 'ACTIVE', 'TESTED', 'WEAKENING', 'BROKEN', 'FLIPPED'] as const;
const COLS: { key: SortKey; label: string; num?: boolean; cls?: string }[] = [
  { key: 'type', label: 'Type' },
  { key: 'tf', label: 'TF' },
  { key: 'zoneLow', label: 'Zone Low', num: true, cls: 'c-low' },
  { key: 'zoneHigh', label: 'Zone High', num: true, cls: 'c-high' },
  { key: 'mid', label: 'Mid', num: true, cls: 'c-mid' },
  { key: 'score', label: 'Score', num: true },
  { key: 'touches', label: 'Touches', num: true, cls: 'c-touch' },
  { key: 'status', label: 'Status' },
  { key: 'distance', label: 'Distance', num: true, cls: 'c-dist' },
];

function ZonesTab(p: PanelProps) {
  const zones = p.multi?.zones ?? [];
  const counts = (pred: (z: SRZone) => boolean) => zones.filter((z) => z.status !== 'EXPIRED' && pred(z)).length;
  const { rows, total } = tableRows(zones, p.filters, p.settings, p.showAll);
  const sorted = sortZones(rows, p.sort);
  const set = (patch: Partial<ZoneFilters>) => p.onFilters({ ...p.filters, ...patch });
  const ready = p.viewState === 'READY' || p.viewState === 'STALE';
  const sortBy = (key: SortKey) => p.onSort({ key, dir: p.sort.key === key && p.sort.dir === 'desc' ? 'asc' : 'desc' });

  return (
    <>
      <div className="srfilters" aria-label="Zone filters">
        <div className="srfilters__row" role="group" aria-label="Zone type">
          <Chip value="all" current={p.filters.type} onClick={(type) => set({ type })}>All ({counts(() => true)})</Chip>
          <Chip value="support" current={p.filters.type} onClick={(type) => set({ type })}>Support ({counts((z) => z.role === 'support')})</Chip>
          <Chip value="resistance" current={p.filters.type} onClick={(type) => set({ type })}>Resistance ({counts((z) => z.role === 'resistance')})</Chip>
        </div>
        <div className="srfilters__row" role="group" aria-label="Timeframe">
          <Chip value="ALL" current={p.filters.tf} onClick={(tf) => set({ tf })} tone="srchip--tf">ALL TF</Chip>
          {TIMEFRAMES.map((tf) => (
            <Chip key={tf} value={tf} current={p.filters.tf} onClick={(v) => set({ tf: v })} tone="srchip--tf">{tf}</Chip>
          ))}
        </div>
        <div className="srfilters__row" role="group" aria-label="Status">
          {STATUS_FILTERS.map((s) => (
            <Chip key={s} value={s} current={p.filters.status} onClick={(status) => set({ status })}>
              {s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase()}
              {s !== 'ALL' && ` (${counts((z) => z.status === s)})`}
            </Chip>
          ))}
        </div>
      </div>

      {!ready ? (
        <EmptyState
          icon={<Info size={18} />}
          title={p.viewState === 'CATEGORY' ? 'S&R DATA UNAVAILABLE' : SR_VIEW_TITLE[p.viewState]}
          message={`No zones for ${p.symbol}. Zones appear only after real candle history is analysed.`}
        />
      ) : (
        <div className="srtable-wrap">
          <table className="srtable">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} className={`${c.num ? 'num-col' : ''} ${c.cls ?? ''}`} aria-sort={p.sort.key === c.key ? (p.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => sortBy(c.key)}>{c.label}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((z) => (
                <tr
                  key={z.id}
                  className={`${z.id === p.selectedZoneId ? 'is-selected' : ''} role-${z.role}`}
                  onClick={() => p.onSelectZone(z.id)}
                  aria-selected={z.id === p.selectedZoneId}
                  tabIndex={0}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), p.onSelectZone(z.id))}
                  data-testid={`zone-row-${z.id}`}
                >
                  <td>
                    <span className={`srtype srtype--${z.role}`}>
                      <span className="srtype__long">{z.role === 'support' ? 'Support' : 'Resistance'}</span>
                      <span className="srtype__short" aria-hidden="true">{z.role === 'support' ? 'Sup' : 'Res'}</span>
                    </span>
                  </td>
                  <td>{z.timeframe}</td>
                  <td className="num c-low">{formatPrice(z.zoneLow, p.decimals)}</td>
                  <td className="num c-high">{formatPrice(z.zoneHigh, p.decimals)}</td>
                  <td className="num c-mid">{formatPrice(z.midPrice, p.decimals)}</td>
                  <td className="num"><span className="srscore">{z.score.total}</span></td>
                  <td className="num c-touch">{z.touchCount}</td>
                  <td><span className={`srstatus ${STATUS_CLASS[z.status]}`}>{z.status}</span></td>
                  <td className={`num c-dist ${(z.distanceFromPrice ?? 0) >= 0 ? 'up' : 'down'}`}>{formatSigned(z.distanceFromPrice, p.decimals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && <p className="srtable__none">No zones match these filters.</p>}
          {p.filters.tf === 'ALL' && total > rows.length && (
            <button type="button" className="btn-ghost srtable__more" onClick={() => p.onShowAll(true)}>
              Showing the {rows.length} most relevant of {total} zones · Show all
            </button>
          )}
          {p.filters.tf === 'ALL' && p.showAll && (
            <button type="button" className="btn-ghost srtable__more" onClick={() => p.onShowAll(false)}>
              Showing all {total} zones · Show most relevant only
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ----------------------------- Multi-timeframe ---------------------------- */

function MtfTab(p: PanelProps) {
  if ((p.viewState !== 'READY' && p.viewState !== 'STALE') || !p.multi) {
    return <EmptyState icon={<Info size={18} />} title={SR_VIEW_TITLE[p.viewState]} message="Confluence is computed only from independently analysed real timeframes." />;
  }
  return (
    <div className="srmtf">
      <h3 className="srsection">Timeframes</h3>
      <table className="srmini">
        <thead><tr><th>TF</th><th>State</th><th className="num-col">Bars</th><th className="num-col">Holding</th></tr></thead>
        <tbody>
          {TIMEFRAMES.map((tf) => {
            const s = p.multi!.byTimeframe[tf as Timeframe];
            const holding = s?.zones.filter((z) => z.status !== 'BROKEN' && z.status !== 'EXPIRED').length ?? 0;
            return (
              <tr key={tf}>
                <td>{tf}</td>
                <td>{s ? (s.state === 'READY' ? 'Ready' : s.state === 'INSUFFICIENT_HISTORY' ? 'Insufficient history' : 'No data') : 'No data'}</td>
                <td className="num">{s?.barsProcessed ?? 0}</td>
                <td className="num">{holding}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3 className="srsection">Confluence regions ({p.multi.confluences.length})</h3>
      {p.multi.confluences.length === 0 && <p className="srmuted">No overlapping zones across timeframes.</p>}
      <ul className="srcflist">
        {p.multi.confluences.map((c) => (
          <li key={c.id}>
            <button type="button" className={`srcf ${c.id === p.selectedConfluenceId ? 'is-selected' : ''}`} onClick={() => p.onSelectConfluence(c.id)}>
              <span className={`srtype srtype--${c.role}`}>{c.role === 'support' ? 'Support' : 'Resistance'}</span>
              <span>{c.timeframes.join(' + ')}</span>
              <span className="num">{formatPrice(c.overlapLow, p.decimals)} – {formatPrice(c.overlapHigh, p.decimals)}</span>
              <span className="srscore">{c.score}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------- Analysis ------------------------------- */

function Fact({ label, zone, decimals }: { label: string; zone: SRZone | null; decimals: number }) {
  return (
    <div className="srfact">
      <dt>{label}</dt>
      <dd>
        {zone ? (
          <>
            <span className={`srtype srtype--${zone.role}`}>{zone.timeframe} {roleLabel(zone)}</span>{' '}
            <span className="num">{formatPrice(zone.zoneLow, decimals)} – {formatPrice(zone.zoneHigh, decimals)}</span>{' '}
            <span className="srmuted">score {zone.score.total} · {zone.status}</span>
          </>
        ) : (
          <span className="srmuted">None</span>
        )}
      </dd>
    </div>
  );
}

function AnalysisTab(p: PanelProps) {
  if ((p.viewState !== 'READY' && p.viewState !== 'STALE') || !p.multi) {
    return <EmptyState icon={<Info size={18} />} title={SR_VIEW_TITLE[p.viewState]} message="S&R facts appear once real candles are analysed." />;
  }
  // Freshest price: lowest timeframe that has one.
  const price = TIMEFRAMES.map((tf) => p.multi!.byTimeframe[tf]?.currentPrice ?? null).find((x) => x !== null) ?? null;
  const f = summarize(p.multi.zones, p.multi.confluences, price, p.settings);
  return (
    <div className="sranalysis">
      <p className="srmuted">Facts about current support and resistance only — this engine does not produce trade signals.</p>
      <dl>
        <div className="srfact"><dt>Current price{p.viewState === 'STALE' ? ' (stale)' : ''}</dt><dd className="num">{formatPrice(price, p.decimals)}</dd></div>
        <Fact label="Nearest support" zone={f.nearestSupport} decimals={p.decimals} />
        <Fact label="Nearest resistance" zone={f.nearestResistance} decimals={p.decimals} />
        <Fact label={`Strongest support within ${p.settings.nearbyAtr} ATR`} zone={f.strongestNearbySupport} decimals={p.decimals} />
        <Fact label={`Strongest resistance within ${p.settings.nearbyAtr} ATR`} zone={f.strongestNearbyResistance} decimals={p.decimals} />
        <div className="srfact">
          <dt>Price inside zone</dt>
          <dd>{f.insideZones.length ? f.insideZones.map((z) => `${z.timeframe} ${roleLabel(z)}`).join(', ') : <span className="srmuted">No</span>}</dd>
        </div>
        <div className="srfact">
          <dt>MTF confluence nearby</dt>
          <dd>
            {f.nearbyConfluences.length ? (
              f.nearbyConfluences.map((c: SRConfluence) => (
                <div key={c.id}>
                  {c.role === 'support' ? 'Support' : 'Resistance'} {c.timeframes.join('+')} · {formatPrice(c.overlapLow, p.decimals)} – {formatPrice(c.overlapHigh, p.decimals)} · score {c.score}
                </div>
              ))
            ) : (
              <span className="srmuted">None</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* -------------------------------- Settings ------------------------------- */

const EXPOSED: (keyof typeof SR_SETTING_SPECS)[] = [
  'pivotLeft', 'pivotRight', 'zoneAtrMultiplier', 'zoneMinAtr', 'zoneMaxAtr', 'clusterToleranceAtr',
  'touchSeparationAtr', 'rejectionMinAtr', 'breakConfirmCloses', 'breakToleranceAtr', 'breakDisplacementAtr',
  'freshnessDecay', 'expiryBars', 'minHistoryBars', 'minDisplayScore', 'maxDisplayedZones',
];

function SettingsTab(p: PanelProps) {
  const groups = [...new Set(EXPOSED.map((k) => SR_SETTING_SPECS[k].group))];
  return (
    <div className="srsettings">
      <p className="srmuted">Changes recalculate every timeframe deterministically. Defaults are centralised in the engine.</p>
      <label className="srset">
        <span className="srset__label">Zone-width method</span>
        <select value={p.settings.zoneWidthMethod} onChange={(e) => p.onSettings({ zoneWidthMethod: e.target.value as SRSettings['zoneWidthMethod'] })}>
          <option value="wickBody">Wick → body (ATR-clamped)</option>
          <option value="atr">ATR multiple</option>
        </select>
      </label>
      {groups.map((g) => (
        <fieldset key={g} className="srset__group">
          <legend>{g}</legend>
          {EXPOSED.filter((k) => SR_SETTING_SPECS[k].group === g).map((k) => {
            const spec = SR_SETTING_SPECS[k];
            return (
              <label key={k} className="srset" title={spec.help}>
                <span className="srset__label">{spec.label}</span>
                <input
                  type="number"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={p.settings[k]}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) p.onSettings({ [k]: v } as Partial<SRSettings>);
                  }}
                  aria-label={spec.label}
                />
              </label>
            );
          })}
        </fieldset>
      ))}
      <button type="button" className="btn-ghost srset__reset" onClick={p.onResetSettings}>
        <RotateCcw size={13} /> Reset to defaults
      </button>
    </div>
  );
}
