import { AlertTriangle, Boxes, CircleDot, GitBranch, Grid3x3, Layers, ListOrdered, Scale, ScrollText, Target, Waypoints } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { SMC_SCORE_LABEL, SMC_SCORE_WEIGHTS, type SmcScoreKey } from '../../engines/smc/config';
import type { MatrixRow, MtfSummary, SmcDirection, SmcEvent, SmcScore, SmcTimeframeSnapshot } from '../../engines/smc/types';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { fmtHm, fmtUtc, stateTone } from './smcView';

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

export const Tag = ({ v, tone }: { v: string; tone?: string }) => <span className={`smctag smctag--${tone ?? stateTone(v)}`}>{v.replace(/_/g, ' ')}</span>;
const Empty = ({ children }: { children: ReactNode }) => <p className="smcempty">{children}</p>;
const cap = (d: SmcDirection) => (d === 'bullish' ? 'Bullish' : 'Bearish');

/* ------------------------------ sequence ------------------------------ */

export function SequencePanel({ tf }: { tf: SmcTimeframeSnapshot | null }) {
  const auto: SmcDirection = tf ? (tf.sequences.bearish.confirmed > tf.sequences.bullish.confirmed ? 'bearish' : 'bullish') : 'bullish';
  const [pick, setPick] = useState<SmcDirection | null>(null);
  const dir = pick ?? auto;
  const q = tf?.sequences[dir];
  return (
    <Panel
      title={`SMC Sequence (${cap(dir)})`}
      icon={<ListOrdered size={15} />}
      testId="smc-seq"
      right={
        <div className="smcseg" role="group" aria-label="Sequence direction">
          {(['bullish', 'bearish'] as const).map((d) => (
            <button key={d} type="button" aria-pressed={dir === d} onClick={() => setPick(d)}>
              {cap(d)}
            </button>
          ))}
        </div>
      }
    >
      {!q || tf?.dataState !== 'READY' ? (
        <Empty>{tf?.dataState === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : 'DATA UNAVAILABLE'}</Empty>
      ) : (
        <>
          <ol className="smcseq">
            {q.stages.map((s, k) => (
              <li key={s.key} className={s.state === 'CONFIRMED' ? 'is-ok' : ''} title={s.evidence ?? 'Not confirmed by the engine yet.'} data-testid="smc-seq-stage">
                <span className="smcseq__n">{k + 1}</span>
                <span className="smcseq__label">{s.label}</span>
                <span className={`smcseq__st ${s.state === 'CONFIRMED' ? 'is-ok' : 'is-wait'}`}>{s.state === 'CONFIRMED' ? '✓ CONFIRMED' : 'WAITING'}</span>
              </li>
            ))}
          </ol>
          <p className="smcnote">
            {tf.timeframe} · {q.confirmed}/7 confirmed{q.anchorTime ? ` · anchored on the sweep of ${fmtUtc(q.anchorTime)}` : ' · no qualifying sweep in the lookback'}. The market does not have to follow this sequence; only confirmed stages are shown as such.
          </p>
        </>
      )}
    </Panel>
  );
}

/* --------------------------- market structure -------------------------- */

export function StructurePanel({ tf, d }: { tf: SmcTimeframeSnapshot | null; d: number }) {
  const f = (p: number) => formatPrice(p, d);
  const lastBos = tf ? [...tf.breaks].reverse().find((b) => b.kind === 'BOS') : undefined;
  const lastChoch = tf ? [...tf.breaks].reverse().find((b) => b.kind === 'CHOCH') : undefined;
  const disp = tf?.displacements[tf.displacements.length - 1];
  const rows: [string, ReactNode][] = tf && tf.dataState === 'READY'
    ? [
        ['Current structure', <Tag key="s" v={tf.state} />],
        ['Last swing high', tf.lastHigh ? `${f(tf.lastHigh.price)} ${tf.lastHigh.label ?? ''}` : '—'],
        ['Last swing low', tf.lastLow ? `${f(tf.lastLow.price)} ${tf.lastLow.label ?? ''}` : '—'],
        ['Swing labels', `${tf.lastHigh?.label ?? '—'} + ${tf.lastLow?.label ?? '—'}`],
        ['Recent BOS', lastBos ? `${cap(lastBos.direction)} ${f(lastBos.level)}` : '—'],
        ['Recent CHOCH', lastChoch ? `${cap(lastChoch.direction)} ${f(lastChoch.level)}` : '—'],
        ['Displacement', disp ? `${cap(disp.direction)} ${disp.netMoveAtr.toFixed(2)} ATR` : '—'],
        ['Break-trend', tf.trend ? cap(tf.trend) : 'none'],
      ]
    : [];
  return (
    <Panel title={`Market Structure${tf ? ` · ${tf.timeframe}` : ''}`} icon={<GitBranch size={15} />} testId="smc-structure">
      {!rows.length ? (
        <Empty>{tf?.dataState === 'INSUFFICIENT_DATA' ? `INSUFFICIENT DATA (${tf.barsProcessed}/${tf.requiredBars} closed candles)` : 'DATA UNAVAILABLE'}</Empty>
      ) : (
        <>
          <dl className="smckv">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="smcnote">{tf!.stateEvidence}</p>
        </>
      )}
    </Panel>
  );
}

/* --------------------------------- MTF --------------------------------- */

export function MatrixPanel({ rows, chartTf, onTf }: { rows: MatrixRow[]; chartTf: Timeframe; onTf: (tf: Timeframe) => void }) {
  return (
    <Panel title="Multi-Timeframe SMC" icon={<Grid3x3 size={15} />} testId="smc-matrix" className="smcmatrix">
      <div className="smctable-wrap">
        <table className="smctable">
          <thead>
            <tr>
              {['TF', 'Structure', 'Last Swing', 'Liquidity', 'Sweep', 'BOS', 'CHOCH', 'Displacement', 'OB', 'FVG', 'P/D'].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.timeframe} className={r.timeframe === chartTf ? 'is-sel' : ''}>
                <td>
                  <button type="button" className="smclink" onClick={() => onTf(r.timeframe)} aria-label={`Show ${r.timeframe} on the chart`}>
                    {r.timeframe}
                  </button>
                </td>
                <td>{r.dataState === 'READY' ? <Tag v={r.state} /> : <Tag v={r.dataState === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT' : 'NO DATA'} tone="muted" />}</td>
                <td>{r.lastSwing}</td>
                <td>{r.liquidity}</td>
                <td>{r.sweep}</td>
                <td>{r.bos}</td>
                <td>{r.choch}</td>
                <td>{r.displacement}</td>
                <td>{r.ob}</td>
                <td>{r.fvg}</td>
                <td>{r.premiumDiscount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function ConflictsPanel({ summary }: { summary: MtfSummary | null }) {
  const list = summary?.conflicts ?? [];
  return (
    <Panel title="Timeframe Conflicts" icon={<AlertTriangle size={15} />} testId="smc-conflicts" right={summary ? <Tag v={summary.verdict} /> : null}>
      {summary && <p className="smcnote">{summary.reason}</p>}
      {!list.length ? (
        <Empty>No conflicts reported.</Empty>
      ) : (
        <ul className="smcconf">
          {list.map((c) => (
            <li key={c.id} className={`is-${c.severity}`}>
              <i aria-hidden="true" /> {c.text}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------ liquidity ------------------------------ */

const LQ_FILTERS = ['All', 'BSL', 'SSL', 'EQH', 'EQL', 'Swept'] as const;
export function LiquidityPanel({ tf, d }: { tf: SmcTimeframeSnapshot | null; d: number }) {
  const [flt, setFlt] = useState<(typeof LQ_FILTERS)[number]>('All');
  const rows = useMemo(() => {
    const all = [...(tf?.liquidity ?? [])].sort((a, b) => b.confirmedAt - a.confirmedAt);
    return all.filter((p) => flt === 'All' || (flt === 'Swept' ? p.status !== 'LIQUIDITY PRESENT' : flt === 'EQH' || flt === 'EQL' ? p.kind === flt : p.side === flt)).slice(0, 40);
  }, [tf, flt]);
  return (
    <Panel title="Liquidity Map" icon={<Waypoints size={15} />} testId="smc-liq" right={<Filters list={LQ_FILTERS} value={flt} onChange={setFlt} />}>
      {!rows.length ? (
        <Empty>{tf?.dataState === 'READY' ? 'No qualified liquidity from the Liquidity engine on this timeframe.' : 'DATA UNAVAILABLE'}</Empty>
      ) : (
        <Table head={['Type', 'Price', 'Status', 'Score', 'Confirmed']}>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className={p.side === 'BSL' ? 'smcbear' : 'smcbull'}>{p.kind}</td>
              <td className="num">{formatPrice(p.level, d)}</td>
              <td>{p.status.replace('LIQUIDITY ', '')}</td>
              <td className="num">{p.score}</td>
              <td>{fmtHm(p.confirmedAt)}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="smcnote">From the Liquidity engine (read-only). LIQUIDITY PRESENT ≠ LIQUIDITY SWEPT ≠ CONFIRMED STRUCTURAL REVERSAL (a CHOCH after the sweep).</p>
    </Panel>
  );
}

export function BreaksPanel({ tf, d }: { tf: SmcTimeframeSnapshot | null; d: number }) {
  const rows = [...(tf?.breaks ?? [])].reverse().slice(0, 30);
  return (
    <Panel title="BOS / CHOCH History" icon={<Layers size={15} />} testId="smc-breaks">
      {!rows.length ? (
        <Empty>{tf?.dataState === 'READY' ? 'No structural break (close through a confirmed swing) yet.' : 'DATA UNAVAILABLE'}</Empty>
      ) : (
        <Table head={['Time', 'Type', 'Swing', 'Close', 'Break', 'Displ.']}>
          {rows.map((b) => (
            <tr key={b.id} title={b.evidence}>
              <td>{fmtHm(b.confirmedAt)}</td>
              <td className={b.direction === 'bullish' ? 'smcbull' : 'smcbear'}>
                {cap(b.direction)} {b.kind}
                {b.initial ? ' (initial)' : ''}
              </td>
              <td className="num">
                {b.swingLabel ?? ''} {formatPrice(b.level, d)}
              </td>
              <td className="num">{formatPrice(b.close, d)}</td>
              <td className="num">{b.breakAtr.toFixed(2)} ATR</td>
              <td>{b.displacementId ? 'yes' : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

const OB_FILTERS = ['All', 'Bullish', 'Bearish', 'Live', 'Mitigated'] as const;
export function ObPanel({ tf, d }: { tf: SmcTimeframeSnapshot | null; d: number }) {
  const [flt, setFlt] = useState<(typeof OB_FILTERS)[number]>('All');
  const rows = [...(tf?.orderBlocks ?? [])]
    .reverse()
    .filter((b) => flt === 'All' || (flt === 'Live' ? b.live : flt === 'Mitigated' ? b.state === 'MITIGATED' : b.direction === flt.toLowerCase()))
    .slice(0, 30);
  return (
    <Panel title="Order Blocks" icon={<Boxes size={15} />} testId="smc-ob" right={<Filters list={OB_FILTERS} value={flt} onChange={setFlt} />}>
      {!rows.length ? (
        <Empty>{tf?.dataState === 'READY' ? 'No order blocks from the Order Block engine on this timeframe.' : 'DATA UNAVAILABLE'}</Empty>
      ) : (
        <Table head={['Type', 'Zone', 'State', 'Mitig.', 'Score']}>
          {rows.map((b) => (
            <tr key={b.id} title={b.evidence}>
              <td className={b.direction === 'bullish' ? 'smcbull' : 'smcbear'}>{cap(b.direction)} OB</td>
              <td className="num">
                {formatPrice(b.low, d)} – {formatPrice(b.high, d)}
              </td>
              <td>{b.state}</td>
              <td className="num">{Math.round(b.mitigationPct)}%</td>
              <td className="num">{b.score}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="smcnote">From the Order Block engine (read-only; its score is its own descriptive strength).</p>
    </Panel>
  );
}

const FVG_FILTERS = ['All', 'Bullish', 'Bearish', 'Open', 'Filled'] as const;
export function FvgPanel({ tf, d }: { tf: SmcTimeframeSnapshot | null; d: number }) {
  const [flt, setFlt] = useState<(typeof FVG_FILTERS)[number]>('All');
  const open = (s: string) => s === 'FRESH' || s === 'ACTIVE' || s === 'PARTIALLY_FILLED';
  const rows = [...(tf?.fvgs ?? [])]
    .reverse()
    .filter((g) => flt === 'All' || (flt === 'Open' ? open(g.state) : flt === 'Filled' ? g.state === 'FILLED' : g.direction === flt.toLowerCase()))
    .slice(0, 30);
  return (
    <Panel title="FVG / Imbalances" icon={<CircleDot size={15} />} testId="smc-fvg" right={<Filters list={FVG_FILTERS} value={flt} onChange={setFlt} />}>
      {!rows.length ? (
        <Empty>{tf?.dataState === 'READY' ? 'No fair-value gaps on this timeframe.' : 'DATA UNAVAILABLE'}</Empty>
      ) : (
        <Table head={['Type', 'Zone', 'State', 'Fill', 'Size', 'Created']}>
          {rows.map((g) => (
            <tr key={g.id} title={g.evidence}>
              <td className={g.direction === 'bullish' ? 'smcbull' : 'smcbear'}>{cap(g.direction)} FVG</td>
              <td className="num">
                {formatPrice(g.lower, d)} – {formatPrice(g.upper, d)}
              </td>
              <td>{g.state.replace('_', ' ')}</td>
              <td className="num">{Math.round(g.fillPct)}%</td>
              <td className="num">{g.sizeAtr.toFixed(2)} ATR</td>
              <td>{fmtHm(g.confirmedAt)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function PremiumDiscountPanel({ tf, d }: { tf: SmcTimeframeSnapshot | null; d: number }) {
  const r = tf?.range;
  const loc = tf?.location;
  const idm = tf ? [...tf.inducements].reverse().find((x) => x.state !== 'VOID') : undefined;
  return (
    <Panel title={`Premium / Discount${tf ? ` · ${tf.timeframe}` : ''}`} icon={<Scale size={15} />} testId="smc-pd">
      {!tf || tf.dataState !== 'READY' ? (
        <Empty>DATA UNAVAILABLE</Empty>
      ) : !loc || !r ? (
        <Empty>{tf.rangeUnavailable ?? 'DEALING RANGE UNAVAILABLE'}</Empty>
      ) : (
        <div className="smcpd">
          <div className="smcpd__bar" aria-hidden="true">
            <span className="smcpd__prem">Premium</span>
            <span className="smcpd__eq">Equilibrium</span>
            <span className="smcpd__disc">Discount</span>
            <i style={{ bottom: `${Math.max(0, Math.min(100, loc.pct))}%` }} />
          </div>
          <dl className="smckv">
            <div><dt>Range high</dt><dd className="num">{formatPrice(r.high, d)}</dd></div>
            <div><dt>Range low</dt><dd className="num">{formatPrice(r.low, d)}</dd></div>
            <div><dt>Equilibrium (50%)</dt><dd className="num">{formatPrice(r.eq, d)}</dd></div>
            <div><dt>Current price</dt><dd className="num">{formatPrice(loc.price, d)}</dd></div>
            <div><dt>Position</dt><dd className="num">{loc.pct.toFixed(0)}%</dd></div>
            <div><dt>Location</dt><dd><Tag v={loc.zone} tone={loc.zone === 'PREMIUM' || loc.zone === 'ABOVE_RANGE' ? 'bear' : loc.zone === 'EQUILIBRIUM' ? 'warn' : 'bull'} /></dd></div>
          </dl>
        </div>
      )}
      {tf?.dataState === 'READY' && (
        <p className="smcnote">
          {r ? `${cap(r.direction)} dealing range: ${r.evidence}. ` : ''}
          {idm ? `INDUCEMENT CANDIDATE ${formatPrice(idm.price, d)} — ${idm.state === 'TAKEN' ? 'taken' : 'untaken'} (${idm.evidence}).` : 'No inducement candidate.'}
        </p>
      )}
    </Panel>
  );
}

/* --------------------------------- score -------------------------------- */

export function ScorePanel({ score }: { score: SmcScore | null }) {
  const total = score?.total ?? null;
  const pct = total === null ? 0 : total;
  return (
    <Panel title="SMC Confluence Score" icon={<Target size={15} />} testId="smc-score">
      <div className="smcscore">
        <div className="smcscore__ring" style={{ ['--p' as string]: `${pct}` }} aria-label={total === null ? 'No score' : `Confluence ${total} of 100`}>
          <strong data-testid="smc-score-total">{total === null ? '—' : total}</strong>
          <span>/100</span>
        </div>
        <ul className="smcscore__list">
          {(Object.keys(SMC_SCORE_WEIGHTS) as SmcScoreKey[]).map((k) => (
            <li key={k} title={score?.evidence[k] ?? ''}>
              <span>{SMC_SCORE_LABEL[k]}</span>
              <b className="num">{score ? Math.round((score.components[k] * SMC_SCORE_WEIGHTS[k]) / 100) : 0}/{SMC_SCORE_WEIGHTS[k]}</b>
            </li>
          ))}
        </ul>
      </div>
      {score?.direction && <p className="smcnote">Direction assessed: {cap(score.direction)}.</p>}
      {!!score?.missing.length && <p className="smcnote smcnote--warn">Missing mandatory evidence: {score.missing.join('; ')}.</p>}
      <p className="smcnote">{score?.note ?? 'No score.'}</p>
    </Panel>
  );
}

/* ------------------------------- event log ------------------------------- */

export function EventLogPanel({ log, d }: { log: SmcEvent[]; d: number }) {
  const [tfFilter, setTf] = useState<string>('All');
  const [hideSwings, setHide] = useState(true);
  const rows = useMemo(
    () => [...log].reverse().filter((e) => (tfFilter === 'All' || e.timeframe === tfFilter || e.timeframe === null) && !(hideSwings && e.type === 'SWING CONFIRMED')).slice(0, 200),
    [log, tfFilter, hideSwings],
  );
  return (
    <Panel
      title={`Event Log (${log.length})`}
      icon={<ScrollText size={15} />}
      testId="smc-log"
      className="smclog"
      right={
        <div className="smcrow">
          <label className="smccheck">
            <input type="checkbox" checked={hideSwings} onChange={(e) => setHide(e.target.checked)} /> hide swings
          </label>
          <select value={tfFilter} onChange={(e) => setTf(e.target.value)} aria-label="Event timeframe filter" className="smcselect">
            {['All', 'D1', 'H4', 'H1', 'M30', 'M15', 'M5', 'M1'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
      }
    >
      {!rows.length ? (
        <Empty>No events.</Empty>
      ) : (
        <Table head={['Time (UTC)', 'TF', 'Event', 'Price', 'Details']}>
          {rows.map((e) => (
            <tr key={e.id} className={e.superseded ? 'is-superseded' : ''} data-testid="smc-log-row" title={e.superseded ? 'No longer produced after a DATA REVISED rebuild (kept for the record).' : undefined}>
              <td>{fmtHm(e.time)}</td>
              <td>{e.timeframe ?? '—'}</td>
              <td className={e.type.includes('DATA') ? 'smcwarn' : ''}>{e.type}</td>
              <td className="num">{e.price === null ? '—' : formatPrice(e.price, d)}</td>
              <td>{e.message}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

/* -------------------------------- helpers -------------------------------- */

function Filters<T extends string>({ list, value, onChange }: { list: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="smcseg" role="group" aria-label="Filter">
      {list.map((x) => (
        <button key={x} type="button" aria-pressed={value === x} onClick={() => onChange(x)}>
          {x}
        </button>
      ))}
    </div>
  );
}

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

