import { useMemo, useState } from 'react';
import { beyondZone, currentZone, isRated, meaningfulZones, mtfMap, TF_ORDER, tierCounts, tierOf, TIER_LABEL, TIER_RULE, zoneEvidence, type AnalysisInput, type Tier } from '../../engines/srPro/analysis';
import { HOW_TO_EXTEND, VALID_THROUGH } from '../../engines/srPro/cmeCalendar';
import type { QualityResult } from '../../engines/srPro/dataQuality';
import { ASIA_SESSIONS, type AsiaSessionId, type KeyLevelsResult } from '../../engines/srPro/keyLevels';
import type { SRZone, ZoneStatus } from '../../engines/sr/types';
import type { Timeframe } from '../../types/market';
import { fmtP, fmtSigned, OVERLAY_LABELS, roleShort, sessionRules, statusLabel, tierTone, type OverlayKey, type Overlays } from './srProView';
import { ZoneEvidenceView } from './SRProZone';

export type ProTab = 'overview' | 'zones' | 'mtf' | 'analysis' | 'levels' | 'settings';
const TABS: [ProTab, string][] = [
  ['overview', 'Overview'],
  ['zones', 'Zones'],
  ['mtf', 'Multi-TF'],
  ['analysis', 'Analysis'],
  ['levels', 'Key Levels'],
  ['settings', 'Settings'],
];

interface Props {
  tab: ProTab;
  onTab: (t: ProTab) => void;
  input: AnalysisInput;
  chartTf: Timeframe;
  levels: KeyLevelsResult;
  quality: QualityResult;
  asia: AsiaSessionId;
  onAsia: (a: AsiaSessionId) => void;
  overlays: Overlays;
  onToggle: (k: OverlayKey) => void;
  selectedZoneId: string | null;
  onSelectZone: (id: string) => void;
  d: number;
}

type SortKey = 'strength' | 'distance' | 'touches' | 'tf';
type TierFilter = 'ALL' | Tier;
type RoleFilter = 'all' | 'support' | 'resistance';

export function SRProPanel(p: Props) {
  const counts = useMemo(() => tierCounts(p.input.zones, p.quality), [p.input.zones, p.quality]);
  return (
    <aside className="panel srp-panel" aria-label="Support and resistance analysis">
      <div className="srp-panel__head">
        <h2>Support &amp; Resistance Analysis</h2>
        <span className="srp-muted">{p.input.sources.candleSource}</span>
      </div>
      <div className="srp-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={p.tab === k} className={p.tab === k ? 'is-on' : ''} onClick={() => p.onTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="srp-panel__body">
        {p.tab === 'overview' && <Overview {...p} counts={counts} />}
        {p.tab === 'zones' && <Zones {...p} counts={counts} />}
        {p.tab === 'mtf' && <MultiTf {...p} />}
        {p.tab === 'analysis' && <Analysis {...p} />}
        {p.tab === 'levels' && <Levels {...p} />}
        {p.tab === 'settings' && <Settings {...p} />}
      </div>
    </aside>
  );
}

function TierCards({ counts }: { counts: Record<Tier, number> }) {
  return (
    <div className="srp-tiers">
      {(['STRONG', 'MEDIUM', 'WEAK', 'INACTIVE'] as Tier[]).map((t) => (
        <div key={t} className={`srp-tiercard is-${tierTone(t)}`} title={TIER_RULE[t]}>
          <b>{counts[t]}</b>
          <div>
            <span>{TIER_LABEL[t]}</span>
            <small>{TIER_RULE[t]}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function Overview(p: Props & { counts: Record<Tier, number> }) {
  const s = p.levels.stats;
  const near = meaningfulZones(p.input, p.chartTf, 6);
  return (
    <>
      <TierCards counts={p.counts} />
      {p.counts.UNRATED > 0 && (
        <p className="srp-note">
          {p.counts.UNRATED} zone(s) formed in thin contract history are <b>unrated</b> ({p.quality.activeSinceDay ? `before ${p.quality.activeSinceDay}` : ''}). {p.counts.MINOR} minor zone(s) score below 40.
        </p>
      )}
      <div className="srp-two">
        <table className="srp-mini">
          <caption>Session levels</caption>
          <tbody>
            {p.levels.levels.map((l) => (
              <tr key={l.kind} title={`${l.windowLabel} · ${l.note}`}>
                <td>{l.label}</td>
                <td className="num">{l.status === 'COMPLETE' || l.status === 'FORMING' ? fmtP(l.price, p.d) : <span className="srp-warn">{l.status.replace('_', ' ')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="srp-mini">
          <caption>Current price</caption>
          <tbody>
            <tr>
              <td>Last</td>
              <td className="num">{fmtP(p.input.price, p.d)}</td>
            </tr>
            <tr>
              <td>Day open (CME)</td>
              <td className="num">{fmtP(s.dayOpen, p.d)}</td>
            </tr>
            <tr>
              <td>Day range</td>
              <td className="num">{s.dayHigh !== null && s.dayLow !== null ? fmtP(s.dayHigh - s.dayLow, p.d) : '—'}</td>
            </tr>
            <tr title={s.adrNote}>
              <td>ADR ({s.adrDays})</td>
              <td className="num">{fmtP(s.adr, p.d)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3 className="srp-h3">Nearest meaningful zones ({p.chartTf} and higher)</h3>
      <ZoneTable zones={near} {...p} />
    </>
  );
}

function ZoneTable(p: Props & { zones: readonly SRZone[] }) {
  if (!p.zones.length) return <p className="srp-muted">No zones match.</p>;
  return (
    <table className="srp-table" data-testid="srp-zone-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Type</th>
          <th>TF</th>
          <th>Price range</th>
          <th className="num">Score</th>
          <th className="num">Touches</th>
          <th>Status</th>
          <th className="num">Distance</th>
        </tr>
      </thead>
      <tbody>
        {p.zones.map((z, i) => {
          const t = tierOf(z, p.quality);
          return (
            <tr key={z.id} className={`${z.id === p.selectedZoneId ? 'is-sel' : ''} ${z.inZone ? 'is-in' : ''}`} onClick={() => p.onSelectZone(z.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && p.onSelectZone(z.id)}>
              <td className="srp-muted">{i + 1}</td>
              <td className={`is-${z.role}`}>{roleShort(z)}</td>
              <td>{z.timeframe}</td>
              <td className="num">
                {fmtP(z.zoneLow, p.d)} – {fmtP(z.zoneHigh, p.d)}
              </td>
              <td className="num">
                <span className={`srp-score is-${tierTone(t)}`} title={`${TIER_LABEL[t]} · ${TIER_RULE[t]}`}>
                  {t === 'UNRATED' ? '—' : z.score.total}
                </span>
              </td>
              <td className="num">{z.touchCount}</td>
              <td>
                <span className={`srp-status is-${z.status.toLowerCase()}`}>{statusLabel(z.status)}</span>
                {beyondZone(z, p.input.price) && (
                  <span className="srp-tag is-beyond" title={`Price is beyond this zone; a break needs closed ${z.timeframe} candles`}>
                    BEYOND
                  </span>
                )}
              </td>
              <td className="num">{fmtSigned(z.distanceFromPrice, p.d)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const STATUS_FILTERS: ('ALL' | ZoneStatus)[] = ['ALL', 'FRESH', 'TESTED', 'WEAKENING', 'BROKEN', 'FLIPPED'];

function Zones(p: Props & { counts: Record<Tier, number> }) {
  const [role, setRole] = useState<RoleFilter>('all');
  const [tf, setTf] = useState<'ALL' | Timeframe>('ALL');
  const [tier, setTier] = useState<TierFilter>('ALL');
  const [status, setStatus] = useState<'ALL' | ZoneStatus>('ALL');
  const [sort, setSort] = useState<SortKey>('strength');
  const [all, setAll] = useState(false);
  const list = useMemo(() => {
    const f = p.input.zones.filter(
      (z) =>
        (role === 'all' || z.role === role) &&
        (tf === 'ALL' || z.timeframe === tf) &&
        (status === 'ALL' || z.status === status) &&
        (tier === 'ALL' ? tierOf(z, p.quality) !== 'MINOR' : tierOf(z, p.quality) === tier),
    );
    const by: Record<SortKey, (a: SRZone, b: SRZone) => number> = {
      strength: (a, b) => (isRated(tierOf(b, p.quality)) ? 1 : 0) - (isRated(tierOf(a, p.quality)) ? 1 : 0) || b.score.total - a.score.total,
      distance: (a, b) => Math.abs(a.distanceFromPrice ?? 1e12) - Math.abs(b.distanceFromPrice ?? 1e12),
      touches: (a, b) => b.touchCount - a.touchCount,
      tf: (a, b) => TF_ORDER.indexOf(b.timeframe) - TF_ORDER.indexOf(a.timeframe) || b.score.total - a.score.total,
    };
    return [...f].sort(by[sort]);
  }, [p.input.zones, p.quality, role, tf, tier, status, sort]);
  const support = p.input.zones.filter((z) => z.role === 'support').length;
  return (
    <>
      <div className="srp-filters">
        <div className="srp-seg">
          {(['all', 'support', 'resistance'] as RoleFilter[]).map((r) => (
            <button key={r} type="button" aria-pressed={role === r} onClick={() => setRole(r)}>
              {r === 'all' ? `All (${p.input.zones.length})` : r === 'support' ? `Support (${support})` : `Resistance (${p.input.zones.length - support})`}
            </button>
          ))}
        </div>
        <select aria-label="Sort zones" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="strength">Sort: Strength</option>
          <option value="distance">Sort: Distance</option>
          <option value="touches">Sort: Touches</option>
          <option value="tf">Sort: Timeframe</option>
        </select>
      </div>
      <div className="srp-filters">
        <div className="srp-seg">
          {(['ALL', ...TF_ORDER] as ('ALL' | Timeframe)[]).map((x) => (
            <button key={x} type="button" aria-pressed={tf === x} onClick={() => setTf(x)}>
              {x}
            </button>
          ))}
        </div>
      </div>
      <div className="srp-filters">
        <div className="srp-seg">
          {(['ALL', 'STRONG', 'MEDIUM', 'WEAK', 'INACTIVE', 'UNRATED', 'MINOR'] as TierFilter[]).map((x) => (
            <button key={x} type="button" aria-pressed={tier === x} onClick={() => setTier(x)}>
              {x === 'ALL' ? 'All tiers' : `${TIER_LABEL[x as Tier]} (${p.counts[x as Tier]})`}
            </button>
          ))}
        </div>
        <select aria-label="Zone status" value={status} onChange={(e) => setStatus(e.target.value as 'ALL' | ZoneStatus)}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === 'ALL' ? 'Any status' : statusLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <ZoneTable zones={all ? list : list.slice(0, 25)} {...p} />
      {list.length > 25 && (
        <button type="button" className="srp-link" onClick={() => setAll((v) => !v)}>
          {all ? 'Show the first 25' : `Show all ${list.length}`}
        </button>
      )}
    </>
  );
}

function MultiTf(p: Props) {
  const rows = mtfMap(p.input);
  const conf = [...p.input.confluences].filter((c) => c.timeframes.length > 1).sort((a, b) => b.score - a.score).slice(0, 8);
  return (
    <>
      <table className="srp-table">
        <thead>
          <tr>
            <th>TF</th>
            <th>Structure (SMC)</th>
            <th>Nearest rated zone</th>
            <th>Last break</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tf} onClick={() => r.zone && p.onSelectZone(r.zone.id)}>
              <td>{r.tf}</td>
              <td className={`is-${r.trend}`}>{r.structure}</td>
              <td>{r.zone ? `${roleShort(r.zone)} ${fmtP(r.zone.zoneLow, p.d)}–${fmtP(r.zone.zoneHigh, p.d)} · ${r.zone.score.total}` : '—'}</td>
              <td className="srp-muted">{r.lastBreak}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="srp-h3">Multi-timeframe confluence (S&amp;R engine)</h3>
      {conf.length ? (
        <table className="srp-table">
          <tbody>
            {conf.map((c) => (
              <tr key={c.id} onClick={() => c.zoneIds[0] && p.onSelectZone(c.zoneIds[0])}>
                <td className={`is-${c.role}`}>{c.role === 'support' ? 'Support' : 'Resistance'}</td>
                <td>{c.timeframes.join(' · ')}</td>
                <td className="num">
                  {fmtP(c.overlapLow, p.d)} – {fmtP(c.overlapHigh, p.d)}
                </td>
                <td className="num">{Math.round(c.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="srp-muted">No overlapping zones across timeframes.</p>
      )}
    </>
  );
}

function Analysis(p: Props) {
  const z = p.input.zones.find((x) => x.id === p.selectedZoneId) ?? currentZone(p.input, p.chartTf);
  if (!z) return <p className="srp-muted">No rated zone to analyse yet.</p>;
  return (
    <>
      {!p.selectedZoneId && <p className="srp-note">Showing the zone at / nearest to price. Select any zone in the table or on the chart.</p>}
      <ZoneEvidenceView ev={zoneEvidence(z, p.input)} d={p.d} />
    </>
  );
}

function Levels(p: Props) {
  return (
    <>
      <AsiaSelect {...p} />
      <table className="srp-table">
        <thead>
          <tr>
            <th>Level</th>
            <th className="num">Price</th>
            <th>Status</th>
            <th>Window</th>
          </tr>
        </thead>
        <tbody>
          {p.levels.levels.map((l) => (
            <tr key={l.kind}>
              <td>{l.label}</td>
              <td className="num">{fmtP(l.price, p.d)}</td>
              <td>
                <span className={l.status === 'COMPLETE' ? 'srp-ok' : l.status === 'FORMING' ? 'srp-tag' : 'srp-warn'}>{l.status.replace('_', ' ')}</span>
              </td>
              <td className="srp-muted">
                {l.windowLabel}
                {l.sourceTf ? ` · ${l.sourceTf} bars` : ''}
                <div>{l.note}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="srp-muted">
        CME trading day: 18:00 ET (previous day) → 17:00 ET, maintenance break 17:00–18:00 ET; weekends and CME holidays skipped. Sessions:{' '}
        {sessionRules()
          .map((s) => `${s.name} ${s.rule}`)
          .join(' · ')}
        .
      </p>
    </>
  );
}

function AsiaSelect(p: Props) {
  return (
    <div className="srp-filters">
      <span className="srp-muted">Asia session</span>
      <div className="srp-seg">
        {(Object.keys(ASIA_SESSIONS) as AsiaSessionId[]).map((id) => (
          <button key={id} type="button" aria-pressed={p.asia === id} onClick={() => p.onAsia(id)}>
            {ASIA_SESSIONS[id].label} · {ASIA_SESSIONS[id].rule}
          </button>
        ))}
      </div>
    </div>
  );
}

function Settings(p: Props) {
  const s = p.input.settings;
  return (
    <>
      <h3 className="srp-h3">Chart overlays</h3>
      <div className="srp-checks">
        {OVERLAY_LABELS.map(([k, label, help]) => (
          <label key={k} className="srp-check" title={help}>
            <input type="checkbox" checked={p.overlays[k]} onChange={() => p.onToggle(k)} /> {label}
            <small>{help}</small>
          </label>
        ))}
      </div>
      <h3 className="srp-h3">Sessions</h3>
      <AsiaSelect {...p} />
      <h3 className="srp-h3">Data quality — contract liquidity</h3>
      <p className="srp-muted">{p.quality.explanation}</p>
      {p.quality.perThreshold.length > 0 && (
        <table className="srp-mini">
          <tbody>
            {p.quality.perThreshold.map((t) => (
              <tr key={t.threshold}>
                <td>Liquid day = volume ≥ {Math.round(t.threshold * 100)}% of reference</td>
                <td className="num">{t.activeSinceDay ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="srp-h3">CME calendar</h3>
      <p className="srp-muted">
        Holidays verified through <b>{VALID_THROUGH}</b>. After that date the page shows CALENDAR EXPIRED and withholds session levels and scenarios. {HOW_TO_EXTEND}
      </p>
      <h3 className="srp-h3">Engine rules in use (S&amp;R engine settings)</h3>
      <p className="srp-muted">
        Swing confirmed after {s.pivotRight} closed bars ({s.pivotLeft} left). Rejection: a close ≥ {s.rejectionMinAtr} ATR beyond the zone within {s.rejectionWindowBars} bars. Break: {s.breakConfirmCloses} consecutive closes
        beyond the far edge by &gt; {s.breakToleranceAtr} ATR, or one close &gt; {s.breakDisplacementAtr} ATR beyond. Flip: a rejecting retest within {s.flipWindowBars} bars after a break. Engine settings are edited on the classic
        view; this page never changes them.
      </p>
    </>
  );
}
