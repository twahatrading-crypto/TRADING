import { BarChart3, Clock3, Grid3x3, Layers, ListOrdered, ScrollText, Target, Waypoints } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { VP_SCORE_LABEL, VP_SCORE_WEIGHTS, type VPScoreKey } from '../../engines/volumeProfile/config';
import type { ConfluenceItem, KeyLevel, MtfRow, VPEvent, VPScore, VPSnapshot, VolumeNode, VolumeProfile } from '../../engines/volumeProfile/types';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { IMPORTANT_EVENT_TYPES, acceptanceTone, engineBadge, eventTone, fmtAtr, fmtHm, fmtVol, locationTone, sourceBadge, windowLabel } from './vpView';

export function Panel({ title, icon, right, children, testId, className }: { title: string; icon: ReactNode; right?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={`panel smcpanel ${className ?? ''}`} data-testid={testId} aria-label={title}>
      <div className="smcpanel__head">
        <h2>
          {icon} {title}
        </h2>
        {right}
      </div>
      <div className="smcpanel__body">{children}</div>
    </section>
  );
}
export const Tag = ({ v, tone }: { v: string; tone?: string }) => <span className={`smctag smctag--${tone ?? 'muted'}`}>{v}</span>;
const Empty = ({ children }: { children: ReactNode }) => <p className="smcempty">{children}</p>;
/** Concise provenance badge; the full provenance is the tooltip. */
export const SrcBadge = ({ text, title }: { text: string; title: string }) => (
  <span className="vpbadge" title={title}>
    {text}
  </span>
);

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="smctable-wrap">
      <table className="smctable">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="vpkv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------- profile statistics --------------------------- */

export function StatsPanel({ profile, snapshot, d }: { profile: VolumeProfile | null; snapshot: VPSnapshot | null; d: number }) {
  const f = (p: number | null) => (p === null ? '—' : formatPrice(p, d));
  const price = snapshot?.price ?? null;
  const atr = snapshot?.atr ?? null;
  const dist = (v: number | null) => (v === null || price === null ? '—' : `${formatPrice(v - price, d)}${atr ? ` (${fmtAtr((v - price) / atr)})` : ''}`);
  return (
    <Panel title="Profile Statistics" icon={<BarChart3 size={15} />} testId="vp-stats">
      {!profile ? (
        <Empty>NO PROFILE — no closed candles in this window.</Empty>
      ) : profile.source.mode === 'NONE' ? (
        <Empty>{profile.source.label}</Empty>
      ) : (
        <>
          <KV
            rows={[
              ['Profile', `${profile.label}${profile.complete ? '' : ' · developing'}${profile.partial ? ' · partial' : ''}`],
              ['Window', windowLabel(profile)],
              ['Resolution / row', `${profile.resolution} · ${formatPrice(profile.binSize, d)}`],
              ['POC', <span key="p" className="num vppoc">{f(profile.poc)}</span>],
              ['VAH', <span key="h" className="num vpva">{f(profile.vah)}</span>],
              ['VAL', <span key="l" className="num vpva">{f(profile.val)}</span>],
              ['Value area', `${Math.round(profile.vaShare * 100)}% achieved (target ${Math.round(profile.valueAreaTarget * 100)}%)`],
              ['Total volume', fmtVol(profile.total)],
              ['POC volume', `${fmtVol(profile.pocVolume)}${profile.total ? ` (${((profile.pocVolume / profile.total) * 100).toFixed(1)}%)` : ''}`],
              ['Range', `${f(profile.low)} – ${f(profile.high)}`],
              ['Bars used', `${profile.source.usedBars}${profile.source.missingBars ? ` (${profile.source.missingBars} without volume excluded)` : ''}`],
              ['Dist. to POC', dist(profile.poc)],
              ['Dist. to VAH', dist(profile.vah)],
              ['Dist. to VAL', dist(profile.val)],
            ]}
          />
          <p className="smcnote">
            <SrcBadge text={sourceBadge(profile.source.label)} title={`${profile.source.label} — ${profile.source.detail}`} />
          </p>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------- HVN / LVN ------------------------------- */

const NODE_FILTERS = ['All', 'HVN', 'LVN'] as const;
export function NodesPanel({ nodes, d }: { nodes: VolumeNode[]; d: number }) {
  const [flt, setFlt] = useState<(typeof NODE_FILTERS)[number]>('All');
  const rows = nodes.filter((n) => flt === 'All' || n.type === flt);
  return (
    <Panel
      title={`HVN / LVN (${nodes.length})`}
      icon={<Layers size={15} />}
      testId="vp-nodes"
      right={
        <div className="smcseg" role="group" aria-label="Node filter">
          {NODE_FILTERS.map((x) => (
            <button key={x} type="button" aria-pressed={flt === x} onClick={() => setFlt(x)}>
              {x}
            </button>
          ))}
        </div>
      }
    >
      {!rows.length ? (
        <Empty>No volume nodes.</Empty>
      ) : (
        <Table head={['Type', 'Zone', 'Profile', 'Strength', 'Rel. vol', 'State', 'Confirmed']}>
          {rows.map((n) => (
            <tr key={n.id} data-testid="vp-node-row" title={n.evidence}>
              <td className={n.type === 'HVN' ? 'vphvn' : 'vplvn'}>{n.type}</td>
              <td className="num">
                {formatPrice(n.low, d)} – {formatPrice(n.high, d)}
              </td>
              <td>{n.profileKind.replace(/_/g, ' ')}</td>
              <td>{n.strengthLabel}</td>
              <td className="num">{Math.round(n.relVolume * 100)}%</td>
              <td>
                <Tag v={n.developing ? 'DEVELOPING' : n.state} tone={n.state === 'ACTIVE' ? 'bull' : n.state === 'TESTED' ? 'warn' : 'muted'} />
              </td>
              <td>{fmtHm(n.confirmedAt)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

/* ------------------------------- MTF matrix ------------------------------- */

export function MtfPanel({ rows, chartTf, onTf, d }: { rows: MtfRow[]; chartTf: Timeframe; onTf: (tf: Timeframe) => void; d: number }) {
  const f = (p: number | null) => (p === null ? '—' : formatPrice(p, d));
  const src = rows.find((r) => r.available)?.source ?? null;
  return (
    <Panel title="Multi-Timeframe Volume Profile" icon={<Grid3x3 size={15} />} testId="vp-mtf" right={src ? <SrcBadge text={sourceBadge(src.label)} title={`${src.label} — ${src.detail}`} /> : undefined}>
      {!rows.length ? (
        <Empty>DATA UNAVAILABLE</Empty>
      ) : (
        <Table head={['TF', 'POC', 'VAH', 'VAL', 'Location', 'HVN', 'LVN', 'Context']}>
          {rows.map((r) => (
            <tr key={r.timeframe} className={r.timeframe === chartTf ? 'is-active' : ''} data-testid="vp-mtf-row" onClick={() => onTf(r.timeframe)} title={`${r.timeframe}: ${r.bars} closed bars · ${r.source.label}`}>
              <td>
                <button type="button" className="vptf" aria-pressed={r.timeframe === chartTf}>
                  {r.timeframe}
                </button>
              </td>
              <td className="num vppoc">{f(r.poc)}</td>
              <td className="num">{f(r.vah)}</td>
              <td className="num">{f(r.val)}</td>
              <td>{r.available && r.location ? <Tag v={r.location} tone={locationTone(r.location)} /> : <Tag v={r.available ? '—' : 'NO DATA'} />}</td>
              <td className="num vphvn">{f(r.nearestHvn)}</td>
              <td className="num vplvn">{f(r.nearestLvn)}</td>
              <td className="vpctx">{r.context}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="smcnote">Each timeframe is its own profile over its own last N closed candles — independent, never merged. Hover a row for bars and source.</p>
    </Panel>
  );
}

/* ----------------------------- session profiles ----------------------------- */

export function SessionsPanel({ snapshot, d }: { snapshot: VPSnapshot | null; d: number }) {
  const f = (p: number | null) => (p === null ? '—' : formatPrice(p, d));
  const list = (['ASIA', 'LONDON', 'NEW_YORK', 'CURRENT_SESSION', 'PREVIOUS_SESSION'] as const).map((k) => [k, snapshot?.profiles[k]] as const);
  return (
    <Panel title="Session Profiles" icon={<Clock3 size={15} />} testId="vp-sessions">
      <Table head={['Session', 'POC', 'VAH', 'VAL', 'Volume', 'State']}>
        {list.map(([k, p]) => (
          <tr key={k} data-testid="vp-session-row">
            <td>
              <span className="vpsess">{p?.label ?? k.replace(/_/g, ' ')}</span>
              <span className="vpsess__win">{windowLabel(p)} UTC</span>
            </td>
            <td className="num vppoc">{f(p?.poc ?? null)}</td>
            <td className="num">{f(p?.vah ?? null)}</td>
            <td className="num">{f(p?.val ?? null)}</td>
            <td className="num">{p ? fmtVol(p.total) : '—'}</td>
            <td>{!p ? <Tag v="NO DATA" /> : p.poc === null ? <Tag v={p.source.mode === 'NONE' && p.bars ? 'VOLUME UNAVAILABLE' : 'NO DATA'} /> : <Tag v={p.complete ? 'COMPLETE' : 'DEVELOPING'} tone={p.complete ? 'muted' : 'warn'} />}</td>
          </tr>
        ))}
      </Table>
      <p className="smcnote">Asia / London / New York windows from the shared session calendar (DST-aware); trading day starts 17:00 New York.</p>
    </Panel>
  );
}

/* ------------------------------- confluence ------------------------------- */

export function ConfluencePanel({ items, d }: { items: ConfluenceItem[]; d: number }) {
  return (
    <Panel title={`Confluence (${items.length})`} icon={<Waypoints size={15} />} testId="vp-confluence" className="vpconf">
      {!items.length ? (
        <Empty>No confluence with other engines' published output.</Empty>
      ) : (
        <Table head={['VP level', 'Price', 'With', 'Source', 'Detail', 'Strength']}>
          {items.slice(0, 40).map((c) => (
            <tr key={c.id} data-testid="vp-conf-row">
              <td title={c.level}>{c.level}</td>
              <td className="num">{formatPrice(c.price, d)}</td>
              <td title={c.with}>{c.with}</td>
              <td>
                <SrcBadge text={engineBadge(c.engine)} title={c.engine} />
              </td>
              <td className="vpclip" title={c.detail}>
                {c.detail}
              </td>
              <td>
                <Tag v={c.strength} tone={c.strength === 'High' ? 'warn' : 'muted'} />
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="smcnote">Read-only: other engines are never changed. Confluence is information, not a trade signal.</p>
    </Panel>
  );
}

/* ------------------------------ important levels ------------------------------ */

export function LevelsPanel({ levels, d }: { levels: KeyLevel[]; d: number }) {
  return (
    <Panel title="Important Volume Levels" icon={<ListOrdered size={15} />} testId="vp-levels">
      {!levels.length ? (
        <Empty>No levels.</Empty>
      ) : (
        <Table head={['#', 'Level', 'Price', 'Distance', 'State', 'Rank']}>
          {levels.slice(0, 15).map((l, i) => (
            <tr key={l.id} data-testid="vp-level-row">
              <td className="num">{i + 1}</td>
              <td className={l.kind === 'POC' ? 'vppoc' : l.kind === 'HVN' ? 'vphvn' : l.kind === 'LVN' ? 'vplvn' : 'vpva'}>{l.label}</td>
              <td className="num">{formatPrice(l.price, d)}</td>
              <td className="num">{fmtAtr(l.distanceAtr)}</td>
              <td>{l.state}</td>
              <td className="num">{l.importance}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="smcnote">Rank = profile weight × level weight × freshness (documented in the engine). Not a trade rating.</p>
    </Panel>
  );
}

/* ---------------------------------- score ---------------------------------- */

export function ScorePanel({ score }: { score: VPScore | null }) {
  const total = score?.total ?? null;
  return (
    <Panel title="Volume Profile Score" icon={<Target size={15} />} testId="vp-score" className="vpscore">
      <div className="smcscore">
        <div className="smcscore__ring" style={{ ['--p' as string]: `${total ?? 0}` }} aria-label={total === null ? 'No score' : `Score ${total} of 100`}>
          <strong data-testid="vp-score-total">{total === null ? '—' : total}</strong>
          <span>/100</span>
        </div>
        <ul className="smcscore__list">
          {(Object.keys(VP_SCORE_WEIGHTS) as VPScoreKey[]).map((k) => (
            <li key={k} title={score?.evidence[k] ?? ''} data-testid="vp-score-row">
              <span>{VP_SCORE_LABEL[k]}</span>
              <b className="num">
                {score ? Math.round((score.components[k] * VP_SCORE_WEIGHTS[k]) / 100) : 0}/{VP_SCORE_WEIGHTS[k]}
              </b>
            </li>
          ))}
        </ul>
      </div>
      {score && score.uncapped !== null && score.total !== score.uncapped && <p className="smcnote smcnote--warn">Capped from {score.uncapped}.</p>}
      {!!score?.missing.length && <p className="smcnote smcnote--warn">Missing mandatory evidence: {score.missing.join('; ')}.</p>}
      <p className="vpnot">Analysis / confluence score · NOT a probability of winning · NOT expected profit · NOT a trade signal</p>
      <p className="smcnote">{score?.note ?? 'No score.'}</p>
    </Panel>
  );
}

/* -------------------------------- event log -------------------------------- */

const RECENT_EVENTS = 8;
export function EventLogPanel({ log, d }: { log: VPEvent[]; d: number }) {
  const [type, setType] = useState('All');
  const [open, setOpen] = useState(false);
  const types = useMemo(() => ['All', ...new Set(log.map((e) => e.type))], [log]);
  const newest = useMemo(() => [...log].reverse(), [log]);
  const rows = useMemo(
    () => (open ? newest.filter((e) => type === 'All' || e.type === type).slice(0, 200) : newest.filter((e) => IMPORTANT_EVENT_TYPES.has(e.type)).slice(0, RECENT_EVENTS)),
    [newest, type, open],
  );
  return (
    <Panel
      title={`Event Log (${log.length})`}
      icon={<ScrollText size={15} />}
      testId="vp-log"
      className="smclog vplog"
      right={
        <button type="button" className="srtool" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="vp-log-toggle">
          {open ? 'Show recent important' : `Show all (${log.length})`}
        </button>
      }
    >
      {open && (
        <div className="vpchips" role="group" aria-label="Event type filter">
          {types.map((x) => (
            <button key={x} type="button" aria-pressed={type === x} onClick={() => setType(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      {!open && <p className="smcnote">Most recent important events (POC / value-area changes, rejections, reclaims, revisions). Tests and node events are in the full log.</p>}
      {!rows.length ? (
        <Empty>No events.</Empty>
      ) : (
        <Table head={['Time (UTC)', 'Event', 'Price', 'Profile', 'Details']}>
          {rows.map((e) => (
            <tr key={e.id} className={e.superseded ? 'is-superseded' : ''} data-testid="vp-log-row" title={e.superseded ? 'No longer produced after a DATA REVISED rebuild (kept for the record).' : e.message}>
              <td>{fmtHm(e.time)}</td>
              <td>
                <Tag v={e.type} tone={eventTone(e)} />
              </td>
              <td className="num">{e.price === null ? '—' : formatPrice(e.price, d)}</td>
              <td>{e.profile}</td>
              <td className="vpclip">{e.message}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

/* ------------------------------- acceptance ------------------------------- */

export function AcceptancePanel({ snapshot }: { snapshot: VPSnapshot | null }) {
  const a = snapshot?.acceptance ?? null;
  const s = snapshot?.sessionAcceptance ?? null;
  return (
    <Panel title="Acceptance / Rejection" icon={<Target size={15} />} testId="vp-acceptance" className="vpaccpanel">
      {!a && !s ? (
        <Empty>NO CONFIRMATION — no completed reference profile yet.</Empty>
      ) : (
        [a, s].map((x, i) =>
          x ? (
            <div key={i} className="vpacc" title={x.evidence}>
              <span className="vpacc__ref">vs {x.referenceLabel}</span>
              <Tag v={x.state} tone={acceptanceTone(x.state)} />
              <p className="smcnote vpclip2">
                {x.evidence}
                {x.at ? ` (${fmtHm(x.at)} UTC)` : ''}
              </p>
            </div>
          ) : null,
        )
      )}
      <p className="smcnote">Closed-candle rules only. Descriptive state — never a BUY / SELL signal.</p>
    </Panel>
  );
}
