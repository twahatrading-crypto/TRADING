import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { HLR_SCORE_WEIGHTS, HLR_TIMEFRAMES, type HLRSettings } from '../../engines/hlReversal/config';
import type { HLREvent, Setup } from '../../engines/hlReversal/types';
import { formatPrice } from '../../utils/format';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import { fmtClock } from './format';
import { DirBadge, StateBadge } from './HLRCards';
import { alertEvents, HLR_VIEW_TITLE, listSetups, nextRequired, STATE_LABEL, type HLRViewState, type SetupFilters } from './hlrView';

export type HLRTab = 'list' | 'active' | 'history' | 'alerts' | 'settings';

interface Props {
  tab: HLRTab;
  onTab: (t: HLRTab) => void;
  viewState: HLRViewState;
  setups: readonly Setup[];
  events: readonly HLREvent[];
  active: Setup | null;
  decimals: number;
  tz: string;
  filters: SetupFilters;
  onFilters: (f: SetupFilters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  symbol: string;
  replayLabel: string | null;
  settings: HLRSettings;
}

function Chip<T extends string>({ value, current, onClick, children, tone }: { value: T; current: T; onClick: (v: T) => void; children: ReactNode; tone?: string }) {
  return (
    <button type="button" className={`srchip ${tone ?? ''}`} aria-pressed={value === current} onClick={() => onClick(value)}>
      {children}
    </button>
  );
}

const zoneText = (s: Setup, d: number) => (s.zone ? `${formatPrice(s.zone.low, d)} – ${formatPrice(s.zone.high, d)}` : formatPrice(s.level, d));

export function HLRPanel(p: Props) {
  const ready = p.viewState === 'LIVE' || p.viewState === 'STALE' || p.viewState === 'REPLAY';
  const open = listSetups(p.setups, { dir: 'ALL', tf: 'ALL' }, 'open');
  const history = listSetups(p.setups, { dir: 'ALL', tf: 'ALL' }, 'history');
  const tabs: { id: HLRTab; label: string }[] = [
    { id: 'list', label: `Setup List${ready ? ` (${open.length})` : ''}` },
    { id: 'active', label: `Active Setup${p.active ? ' (1)' : ''}` },
    { id: 'history', label: 'History' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'settings', label: 'Settings' },
  ];
  const pill = p.replayLabel && ready ? HLR_VIEW_TITLE.REPLAY : HLR_VIEW_TITLE[p.viewState];
  return (
    <section className="panel srpanel hlrpanel" aria-labelledby="hlrpanel-title">
      <header className="srpanel__head">
        <div className="srpanel__title">
          <h2 id="hlrpanel-title">Setups</h2>
          <span className="srpanel__info" title="A setup advances only when each stage is proven by closed candles. Score is descriptive, not a probability, and never replaces a missing stage.">
            <Info size={14} />
          </span>
        </div>
        <div className="srpanel__status">
          <StatusPill tone={p.replayLabel ? 'info' : p.viewState === 'LIVE' ? 'ok' : p.viewState === 'ERROR' || p.viewState === 'OFFLINE' ? 'bad' : 'warn'} label={pill} compact />
          <span className="srpanel__sub">{p.replayLabel ?? (ready ? `${open.length} open · ${history.length} finished · ${p.symbol}` : 'No live data available')}</span>
        </div>
      </header>
      <div className="srtabs" role="tablist" aria-label="Setup views">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={p.tab === t.id} className="srtabs__tab" onClick={() => p.onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="srpanel__body">
        {!ready && p.tab !== 'settings' ? (
          <EmptyState icon={<Info size={18} />} title={HLR_VIEW_TITLE[p.viewState]} message={`No setups for ${p.symbol}. The engine needs real closed H4 · H1 · M15 · M5 · M1 candles.`} />
        ) : p.tab === 'list' || p.tab === 'history' ? (
          <SetupTable {...p} which={p.tab === 'list' ? 'open' : 'history'} />
        ) : p.tab === 'active' ? (
          <ActiveTab {...p} />
        ) : p.tab === 'alerts' ? (
          <AlertsTab {...p} />
        ) : (
          <SettingsTab settings={p.settings} />
        )}
      </div>
    </section>
  );
}

function SetupTable(p: Props & { which: 'open' | 'history' }) {
  const set = (patch: Partial<SetupFilters>) => p.onFilters({ ...p.filters, ...patch });
  const all = listSetups(p.setups, { dir: 'ALL', tf: 'ALL' }, p.which);
  const rows = listSetups(p.setups, p.filters, p.which).slice(0, 60);
  return (
    <>
      <div className="srfilters" aria-label="Setup filters">
        <div className="srfilters__row" role="group" aria-label="Direction">
          <Chip value="ALL" current={p.filters.dir} onClick={(dir) => set({ dir })}>All ({all.length})</Chip>
          <Chip value="BUY" current={p.filters.dir} onClick={(dir) => set({ dir })}>Buy ({all.filter((s) => s.direction === 'BUY').length})</Chip>
          <Chip value="SELL" current={p.filters.dir} onClick={(dir) => set({ dir })}>Sell ({all.filter((s) => s.direction === 'SELL').length})</Chip>
        </div>
        <div className="srfilters__row" role="group" aria-label="Stage timeframe">
          <Chip value="ALL" current={p.filters.tf} onClick={(tf) => set({ tf })} tone="srchip--tf">ALL TF</Chip>
          {HLR_TIMEFRAMES.filter((tf) => tf !== 'H4').map((tf) => (
            <Chip key={tf} value={tf} current={p.filters.tf} onClick={(v) => set({ tf: v })} tone="srchip--tf">{tf}</Chip>
          ))}
        </div>
      </div>
      <div className="srtable-wrap">
        <table className="srtable hlrtable">
          <thead>
            <tr><th className="num-col">#</th><th>Direction</th><th>TF</th><th className="num-col">Level / Zone</th><th>State</th><th className="num-col">Score</th><th>Detected</th></tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr
                key={s.id}
                className={s.id === p.selectedId ? 'is-selected' : ''}
                onClick={() => p.onSelect(s.id)}
                aria-selected={s.id === p.selectedId}
                tabIndex={0}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), p.onSelect(s.id))}
                data-testid={`hlr-row-${s.id}`}
              >
                <td className="num">{i + 1}</td>
                <td><DirBadge dir={s.direction} /></td>
                <td>{s.stageTf}</td>
                <td className="num">{zoneText(s, p.decimals)}</td>
                <td><StateBadge s={s} /></td>
                <td className="num"><span className="srscore">{s.score.total}</span></td>
                <td>{fmtClock(s.sweep?.knownAt ?? s.detectedAt, p.tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="srtable__none">{p.which === 'open' ? 'No open setups match — the engine is waiting for an important H1 high / low.' : 'No finished setups in the analysed history.'}</p>}
      </div>
    </>
  );
}

function ActiveTab(p: Props) {
  const s = p.active;
  if (!s) return <p className="srtable__none">No open setup. WAIT — every stage must be proven by closed candles.</p>;
  return (
    <div className="hlractive" data-testid="hlr-active">
      <div className="hlractive__head">
        <DirBadge dir={s.direction} />
        <strong>{s.direction === 'BUY' ? 'Low' : 'High'} reversal at {formatPrice(s.level, p.decimals)}</strong>
        <StateBadge s={s} />
      </div>
      <p className="hlractive__next">
        <span>Next required</span> {nextRequired(s, p.decimals)}
      </p>
      <button type="button" className="btn-ghost" onClick={() => p.onSelect(s.id)}>Show on chart</button>
    </div>
  );
}

function AlertsTab(p: Props) {
  const ev = alertEvents(p.events);
  return ev.length === 0 ? (
    <p className="srtable__none">No state changes yet.</p>
  ) : (
    <ul className="hlralerts" data-testid="hlr-alerts">
      {ev.map((e) => (
        <li key={`${e.setupId}:${e.time}:${e.to}`}>
          <button type="button" className={e.setupId === p.selectedId ? 'is-selected' : ''} onClick={() => p.onSelect(e.setupId)}>
            <span className="hlralerts__t">{fmtClock(e.time, p.tz)}</span>
            <DirBadge dir={e.direction} />
            <span className={`hlralerts__to hlralerts__to--${e.to.toLowerCase()}`}>{STATE_LABEL[e.to]}</span>
            <span className="hlralerts__r">{e.reason}</span>
          </button>
        </li>
      ))}
      <p className="hlrnote">In-app log of engine state changes (no notifications are sent).</p>
    </ul>
  );
}

function SettingsTab({ settings: s }: { settings: HLRSettings }) {
  const rows: [string, string][] = [
    ['H4 context', `swings ${s.h4SwingLeft}/${s.h4SwingRight}; HH+HL bullish, LH+LL bearish — never blocks a setup`],
    ['H1 important level', `swing ${s.h1SwingLeft}/${s.h1SwingRight}, extreme of ≥ ${s.h1DominanceBars} bars, ≥ ${s.h1MinProminenceAtr} ATR prominence; equal within ${s.equalTolAtr} ATR`],
    ['M15 sweep', `trade beyond the level; > ${s.maxPenetrationAtr} ATR or a close ${s.acceptCloseAtr} ATR beyond = invalid`],
    ['M15 reclaim', `close back by ${s.reclaimMarginAtr} M15 ATR within ${s.reclaimWindowBars} bars`],
    ['M5 confirmation', `CHOCH/BOS close (swings ${s.m5SwingLeft}/${s.m5SwingRight}); displacement ≥ ${s.minDisplacementAtr} ATR, body ≥ ${s.minDisplacementBodyAtr} ATR; within ${s.m5WindowBars} bars`],
    ['M1 entry zone', 'Order Blocks v1 block (M5 / M1) overlapping an M1 FVG › OB › FVG, inside the displacement leg'],
    ['M1 pullback', `within ${s.m1PullbackWindowBars} bars; reaction within ${s.m1TriggerWindowBars} bars`],
    ['Stop / targets', `stop = sweep extreme ∓ ${s.slBufferAtr} M5 ATR; TP1 = nearest untaken M15 swing; TP2 = nearest untaken H1 level`],
    ['History required', Object.entries(s.minBars).map(([tf, n]) => `${tf} ${n}`).join(' · ')],
    ['Score weights (%)', Object.entries(HLR_SCORE_WEIGHTS).map(([k, w]) => `${k} ${w}`).join(' · ')],
  ];
  return (
    <div className="hlrsettings">
      <p className="srmuted">High / Low Reversal v1 uses fixed, documented defaults, independent of the other engines.</p>
      <dl className="srfacts">
        {rows.map(([k, v]) => (
          <div className="srfact" key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}
