import { ChevronDown, ChevronRight, Gauge, Layers3, Target } from 'lucide-react';
import { useState } from 'react';
import { SCORE_WEIGHTS } from '../../engines/sr/settings';
import type { ScoreComponentKey, SRConfluence, SRZone } from '../../engines/sr/types';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useNow } from '../../store/clock';
import { formatPrice, formatSigned } from '../../utils/format';
import { zoneLifecycle } from '../../engines/sr/lifecycle';
import { formatAge, roleLabel, STATUS_CLASS } from './srView';

const fmtTime = (sec: number | null, tz: string) =>
  sec === null
    ? '—'
    : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(sec * 1000);

function Empty({ text }: { text: string }) {
  return <p className="srdetail__empty">{text}</p>;
}

export function ZoneDetails({
  zone,
  decimals,
  emptyText,
  clockMs = null,
}: {
  zone: SRZone | null;
  decimals: number;
  emptyText: string;
  /** Replay clock (ms). Ages are measured from it instead of the wall clock. */
  clockMs?: number | null;
}) {
  const tz = useDisplayTimeZone();
  const wall = useNow('minute');
  const now = clockMs ?? wall;
  const [open, setOpen] = useState(false);
  return (
    <section className="panel srdetail" aria-labelledby="zd-title">
      <header className="srdetail__head">
        <Target size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="zd-title">Zone Details</h2>
        {zone && (
          <>
            <span className={`srtype srtype--${zone.role}`}>{zone.role === 'support' ? 'Support' : 'Resistance'}</span>
            <span className="srtag">{zone.timeframe}</span>
            {zone.role !== zone.type && <span className="srtag">was {zone.type}</span>}
          </>
        )}
      </header>
      {!zone ? (
        <Empty text={emptyText} />
      ) : (
        <>
          <dl className="srkv">
            <div><dt>Zone Range</dt><dd className="num">{formatPrice(zone.zoneLow, decimals)} – {formatPrice(zone.zoneHigh, decimals)}</dd></div>
            <div><dt>Midpoint</dt><dd className="num">{formatPrice(zone.midPrice, decimals)}</dd></div>
            <div><dt>Score</dt><dd className="num srkv__score">{zone.score.total} <span>/ 100</span></dd></div>
            <div><dt>Touches</dt><dd className="num">{zone.touchCount} <span className="srmuted">({zone.rejectionCount} rej · {zone.sweepCount} sweep)</span></dd></div>
            <div><dt>Status</dt><dd><span className={`srstatus ${STATUS_CLASS[zone.status]}`}>{zone.status}</span></dd></div>
            <div><dt>Swing bar</dt><dd>{fmtTime(zone.createdAt, tz)}</dd></div>
            <div><dt>Confirmed (known)</dt><dd>{fmtTime(zone.confirmedAt, tz)}</dd></div>
            <div><dt>Last Touch</dt><dd>{fmtTime(zone.lastInteractionAt, tz)}</dd></div>
            <div><dt>Age</dt><dd>{formatAge(zone.confirmedAt, now)}</dd></div>
            <div>
              <dt>Distance from Price</dt>
              <dd className={`num ${(zone.distanceFromPrice ?? 0) >= 0 ? 'up' : 'down'}`}>
                {formatSigned(zone.distanceFromPrice, decimals)}
                {zone.distanceAtr !== null && <span className="srmuted"> ({zone.distanceAtr.toFixed(1)} ATR)</span>}
              </dd>
            </div>
            {zone.brokenAt && <div><dt>Broken</dt><dd>{fmtTime(zone.brokenAt, tz)} · {zone.breakEvidence?.rule === 'displacement' ? 'displacement close' : `${zone.breakEvidence?.closes.length} closes`}</dd></div>}
            {zone.flippedAt && <div><dt>Flipped</dt><dd>{fmtTime(zone.flippedAt, tz)} → {roleLabel(zone)}</dd></div>}
          </dl>
          <button type="button" className="srhist__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Zone lifecycle ({zoneLifecycle(zone).length} events)
          </button>
          {open && (
            <div className="srlife" data-testid="zone-lifecycle">
              <p className="srlife__id">
                <span className="srmuted">ID</span> <code>{zone.id}</code> · <span className="srmuted">source</span> {zone.timeframe} ·{' '}
                <span className="srmuted">original bounds</span>{' '}
                <span className="num">
                  {formatPrice(zone.zoneLow, decimals)} – {formatPrice(zone.zoneHigh, decimals)}
                </span>{' '}
                · <span className="srmuted">role</span> {zone.role} · <span className="srmuted">state</span> {zone.status}
              </p>
              <ol className="srhist">
                {zoneLifecycle(zone).map((e, k) => (
                  <li key={`${e.kind}-${e.barTime}-${k}`}>
                    <span className="srhist__time">{fmtTime(e.barTime, tz)}</span>
                    <span className={`srhist__out life-${e.kind}`}>{e.kind}</span>
                    <span className="srmuted">
                      {e.detail} · known {fmtTime(e.knownAt, tz)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const COMPONENT_LABEL: Record<ScoreComponentKey, string> = {
  timeframe: 'Timeframe Weight',
  reaction: 'Reaction Strength',
  touchQuality: 'Touch Quality',
  freshness: 'Freshness',
  structure: 'Structure',
  confluence: 'Confluence',
};

export function ScoreComponentsPanel({ zone }: { zone: SRZone | null }) {
  return (
    <section className="panel srdetail" aria-labelledby="sc-title">
      <header className="srdetail__head">
        <Gauge size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="sc-title">Score Components</h2>
      </header>
      <ul className="srbars">
        {(Object.keys(SCORE_WEIGHTS) as ScoreComponentKey[]).map((k) => {
          const v = zone?.score.components[k] ?? null;
          return (
            <li key={k} data-testid={`score-${k}`}>
              <span className="srbars__label">{COMPONENT_LABEL[k]}</span>
              <span className="srbars__track" aria-hidden="true">
                <span className={`srbars__fill ${k === 'confluence' || k === 'structure' ? 'is-blue' : ''}`} style={{ width: `${v ?? 0}%` }} />
              </span>
              <span className="srbars__val num">{v === null ? '—' : Math.round(v)}</span>
              <span className="srbars__w num">×{SCORE_WEIGHTS[k]}</span>
            </li>
          );
        })}
      </ul>
      <p className="srbars__total">
        {zone ? (
          <>
            Σ weighted <strong className="num">{zone.score.weighted}</strong> × status {zone.score.statusFactor} = <strong className="num">{zone.score.total}</strong>
          </>
        ) : (
          <span className="srmuted">Select a zone to see the values the engine used.</span>
        )}
      </p>
    </section>
  );
}

export function ConfluencePanel({
  confluences,
  selected,
  zones,
  decimals,
  onSelect,
}: {
  confluences: readonly SRConfluence[];
  selected: SRConfluence | null;
  zones: readonly SRZone[];
  decimals: number;
  onSelect: (id: string) => void;
}) {
  const c = selected ?? confluences[0] ?? null;
  const byId = new Map(zones.map((z) => [z.id, z]));
  return (
    <section className="panel srdetail" aria-labelledby="cf-title">
      <header className="srdetail__head">
        <Layers3 size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="cf-title">Multi-Timeframe Confluence</h2>
        {c && <span className="srtag srtag--blue">{c.timeframes.length} TF</span>}
      </header>
      {!c ? (
        <Empty text="No overlapping zones across independently analysed timeframes." />
      ) : (
        <div className="srcfbox">
          <table className="srmini">
            <tbody>
              {c.members.map((m) => (
                <tr key={m.zoneId}>
                  <td className="srcf__tf">{m.timeframe}</td>
                  <td>{byId.get(m.zoneId)?.role === 'resistance' ? 'Resistance' : 'Support'}</td>
                  <td className="num">{formatPrice(m.zoneLow, decimals)} – {formatPrice(m.zoneHigh, decimals)}</td>
                  <td className="num srcf__score">{byId.get(m.zoneId)?.score.total ?? m.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className={`srcfzone ${selected?.id === c.id ? 'is-selected' : ''}`} onClick={() => onSelect(c.id)} aria-label="Highlight confluence zones on chart">
            <span className="srmuted">Confluence Zone</span>
            <strong className="num">{formatPrice(c.overlapLow, decimals)} – {formatPrice(c.overlapHigh, decimals)}</strong>
            <span className="srmuted">Combined Score</span>
            <strong className="srcfzone__score num">{c.score}</strong>
          </button>
        </div>
      )}
    </section>
  );
}
