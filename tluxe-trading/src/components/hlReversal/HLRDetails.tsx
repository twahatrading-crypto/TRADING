import { CheckCircle2, Gauge, Layers3, ListChecks, Target, Zap } from 'lucide-react';
import { HLR_SCORE_WEIGHTS } from '../../engines/hlReversal/config';
import type { H4Context, HLRScoreKey, Setup } from '../../engines/hlReversal/types';
import type { Candle } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { fmtTime } from './format';
import { DirBadge, StateBadge } from './HLRCards';
import { nextRequired, snapshotWindow, stages } from './hlrView';

const Empty = ({ text }: { text: string }) => <p className="srdetail__empty">{text}</p>;

export function SetupDetailsPanel({ s, h4, d, tz, emptyText }: { s: Setup | null; h4: H4Context | null; d: number; tz: string; emptyText: string }) {
  const buy = s?.direction === 'BUY';
  return (
    <section className="panel srdetail" aria-labelledby="hlrd-title" data-testid="hlr-details">
      <header className="srdetail__head">
        <Target size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="hlrd-title">Setup Details</h2>
      </header>
      {!s ? (
        <Empty text={emptyText} />
      ) : (
        <>
          <div className="hlrdetail__banner">
            <DirBadge dir={s.direction} />
            <strong>{s.direction === 'BUY' ? 'Low' : 'High'} reversal</strong>
            <StateBadge s={s} />
          </div>
          <dl className="hlrkv">
            <dt>Setup type</dt><dd>{buy ? 'Low sweep reversal (BUY)' : 'High sweep reversal (SELL)'}</dd>
            <dt>Current state</dt><dd>{s.state.replace(/_/g, ' ')}</dd>
            <dt>H4 direction</dt><dd>{s.h4AtSweep ?? h4?.state ?? '—'}{s.counterTrend ? ' (counter-trend)' : ''}</dd>
            <dt>H1 key level</dt><dd className="num">{formatPrice(s.level, d)} ({buy ? 'major low' : 'major high'}{s.levelEquals ? `, equal ×${s.levelEquals + 1}` : ''})</dd>
            <dt>M15 sweep extreme</dt><dd className="num">{s.sweep ? formatPrice(s.sweep.extreme, d) : '—'}</dd>
            <dt>Reclaim</dt><dd className="num">{s.reclaim ? `${formatPrice(s.reclaim.price, d)} · ${s.reclaim.bars} bar(s)` : '—'}</dd>
            <dt>M5 confirmation</dt><dd className="num">{s.m5 ? `${s.m5.kind} at ${formatPrice(s.m5.close, d)}` : '—'}</dd>
            <dt>M1 entry zone</dt><dd className="num">{s.zone ? `${formatPrice(s.zone.low, d)} – ${formatPrice(s.zone.high, d)} (${s.zone.source})` : s.zoneNote ?? '—'}</dd>
            <dt>Stop loss</dt><dd className="num">{s.risk ? formatPrice(s.risk.stop, d) : '—'}</dd>
            <dt>Take profit 1</dt><dd className="num">{s.risk ? `${formatPrice(s.risk.tp1, d)} (R:R ${s.risk.rr1.toFixed(1)})` : '—'}</dd>
            <dt>Take profit 2</dt><dd className="num">{s.risk ? (s.risk.tp2 === null ? `— (${s.risk.tp2Source})` : `${formatPrice(s.risk.tp2, d)} (R:R ${s.risk.rr2!.toFixed(1)})`) : '—'}</dd>
            <dt>Setup score</dt><dd className="num">{s.score.total} / 100</dd>
            <dt>Detected</dt><dd>{fmtTime(s.sweep?.knownAt ?? s.detectedAt, tz)}</dd>
            <dt>Last update</dt><dd>{fmtTime(s.lastUpdate, tz)}</dd>
          </dl>
          <p className="hlrnote">Levels are engine output for analysis only — no order is placed and nothing here guarantees a result.</p>
        </>
      )}
    </section>
  );
}

const LABEL: Record<HLRScoreKey, string> = {
  htfAlignment: 'Higher-TF alignment',
  liquiditySweep: 'Liquidity sweep',
  reclaim: 'Reclaim confirmation',
  m5Structure: 'M5 structure',
  displacement: 'Displacement',
  entryQuality: 'Entry quality (OB/FVG)',
  riskReward: 'Risk to reward',
  freshness: 'Freshness / timing',
};

export function ScorePanel({ s, h4, d }: { s: Setup | null; h4: H4Context | null; d: number }) {
  const keys = Object.keys(HLR_SCORE_WEIGHTS) as HLRScoreKey[];
  const total = s?.score.total ?? null;
  const st = stages(s, h4, d);
  return (
    <section className="panel srdetail hlrscorepanel" aria-labelledby="hlrs-title">
      <header className="srdetail__head">
        <Gauge size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="hlrs-title">Score Components</h2>
      </header>
      <div className="hlrscore">
        <div className="hlrring" aria-label={total === null ? 'No setup selected' : `Score ${total} of 100`}>
          <svg viewBox="0 0 42 42" aria-hidden="true">
            <circle cx="21" cy="21" r="17" className="hlrring__bg" />
            <circle cx="21" cy="21" r="17" className="hlrring__fg" strokeDasharray={`${((total ?? 0) / 100) * 106.8} 106.8`} />
          </svg>
          <strong className="num">{total ?? '—'}</strong>
          <span>/100</span>
        </div>
        <table className="hlrscore__table" data-testid="hlr-score">
          <thead>
            <tr><th>Component</th><th className="num-col">Raw</th><th className="num-col">Wt</th><th className="num-col">Contr.</th></tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} data-testid={`hlr-score-${k}`}>
                <td>
                  {LABEL[k]}
                  <span className="hlrbar" aria-hidden="true"><span style={{ width: `${s?.score.components[k] ?? 0}%` }} /></span>
                </td>
                <td className="num">{s ? Math.round(s.score.components[k]) : '—'}</td>
                <td className="num">{HLR_SCORE_WEIGHTS[k]}%</td>
                <td className="num">{s ? s.score.contributions[k].toFixed(1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hlrnote">Weights total 100%. Descriptive setup quality — not a probability or win rate, and never a substitute for a missing stage.</p>
      <h3 className="hlrsub"><ListChecks size={15} aria-hidden="true" /> Setup Sequence</h3>
      <ol className="hlrseq" data-testid="hlr-sequence">
        {st.map((x) => (
          <li key={x.n} className={`hlrseq__step is-${x.status}`}>
            <span className="hlrseq__n">{x.status === 'done' ? <CheckCircle2 size={14} /> : x.n}</span>
            <span className="hlrseq__t">{x.title}</span>
            <span className="hlrseq__v">{x.value}</span>
          </li>
        ))}
      </ol>
      {s && <p className="hlrnext" data-testid="hlr-next"><span>Next required:</span> {nextRequired(s, d)}</p>}
    </section>
  );
}

export function MtfPanel({ s, h4, d }: { s: Setup | null; h4: H4Context | null; d: number }) {
  const buy = s?.direction === 'BUY';
  const rows: [string, string, string, string][] = [
    ['H4', h4 ? (h4.state === 'INSUFFICIENT_DATA' ? 'Insufficient' : h4.state[0] + h4.state.slice(1).toLowerCase()) : '—', h4?.lastSwingHigh && h4.lastSwingLow ? `${formatPrice(h4.lastSwingLow.price, d)} – ${formatPrice(h4.lastSwingHigh.price, d)}` : '—', h4 ? h4.structure : 'no data'],
    ['H1', s ? (buy ? 'Major low' : 'Major high') : '—', s ? formatPrice(s.level, d) : '—', s ? `significance ${s.levelSignificance}` : '—'],
    ['M15', s?.sweep ? (buy ? 'SSL taken' : 'BSL taken') : '—', s?.sweep ? `${formatPrice(Math.min(s.level, s.sweep.extreme), d)} – ${formatPrice(Math.max(s.level, s.sweep.extreme), d)}` : '—', s ? s.liquidity.replace('_', ' ').toLowerCase() : '—'],
    ['M5', s?.m5 ? `${s.m5.kind} ${buy ? 'up' : 'down'}` : '—', s?.m5 ? formatPrice(s.m5.brokenLevel, d) : '—', s?.m5 ? `${s.m5.displacement.legAtr.toFixed(1)} ATR displacement` : s?.reclaim ? 'pending' : '—'],
    ['M1', s?.zone ? s.zone.source : '—', s?.zone ? `${formatPrice(s.zone.low, d)} – ${formatPrice(s.zone.high, d)}` : '—', s?.entry ? (s.state === 'TRIGGERED' ? 'triggered' : 'entry ready') : s?.zone ? 'pullback wait' : '—'],
  ];
  return (
    <section className="panel srdetail" aria-labelledby="hlrm-title">
      <header className="srdetail__head">
        <Layers3 size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="hlrm-title">Multi-Timeframe Analysis</h2>
      </header>
      <table className="hlrmtf" data-testid="hlr-mtf">
        <thead>
          <tr><th>TF</th><th>Evidence · status</th><th className="num-col">Level / range</th></tr>
        </thead>
        <tbody>
          {rows.map(([tf, ev, lvl, st]) => (
            <tr key={tf}>
              <td>{tf}</td>
              <td>
                {ev}
                <span className="hlrmtf__st">{st}</span>
              </td>
              <td className="num">{lvl}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hlrnote">Each row is independent evidence from its own timeframe's closed candles; "—" means none exists yet. Nothing is inferred.</p>
    </section>
  );
}

function MiniChart({ bars, s }: { bars: readonly Candle[]; s: Setup }) {
  if (bars.length < 3) return <p className="srmuted hlrnote">M5 candles for this snapshot are not loaded.</p>;
  const W = 320;
  const H = 120;
  const prices = [...bars.flatMap((c) => [c.high, c.low]), s.level, ...(s.zone ? [s.zone.low, s.zone.high] : [])];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = (hi - lo) * 0.06 || 1;
  const y = (p: number) => H - ((p - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const step = W / bars.length;
  const bw = Math.max(1, step * 0.6);
  const xAt = (t: number) => {
    const i = bars.findIndex((c) => c.time <= t && t < c.time + 300);
    return i < 0 ? null : i * step + step / 2;
  };
  const buy = s.direction === 'BUY';
  const marks: { x: number | null; y: number; cls: string }[] = [];
  if (s.sweep) marks.push({ x: xAt(s.sweep.extremeTime), y: y(s.sweep.extreme), cls: 'sweep' });
  if (s.m5) marks.push({ x: xAt(s.m5.time), y: y(s.m5.close), cls: 'bos' });
  if (s.entry) marks.push({ x: xAt(s.entry.time), y: y(s.entry.price), cls: 'entry' });
  return (
    <svg className="hlrmini" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${bars.length} closed M5 candles with the setup's level, sweep, confirmation and entry zone`} data-testid="hlr-snapshot-chart">
      <line x1={0} x2={W} y1={y(s.level)} y2={y(s.level)} className={buy ? 'hlrmini__lvl--buy' : 'hlrmini__lvl--sell'} />
      {s.zone && <rect x={xAt(s.zone.definedAt) ?? 0} y={y(s.zone.high)} width={W - (xAt(s.zone.definedAt) ?? 0)} height={Math.max(2, y(s.zone.low) - y(s.zone.high))} className="hlrmini__zone" />}
      {bars.map((c, i) => {
        const cx = i * step + step / 2;
        return (
          <g key={c.time} className={c.close >= c.open ? 'hlrmini__up' : 'hlrmini__down'}>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} />
            <rect x={cx - bw / 2} y={y(Math.max(c.open, c.close))} width={bw} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} />
          </g>
        );
      })}
      {marks.filter((m) => m.x !== null).map((m) => <circle key={m.cls} cx={m.x!} cy={m.y} r={3} className={`hlrmini__mark hlrmini__mark--${m.cls}`} />)}
    </svg>
  );
}

export function RecentSetupPanel({ s, m5, d, tz }: { s: Setup | null; m5: readonly Candle[]; d: number; tz: string }) {
  const last = s?.stateHistory[s.stateHistory.length - 1] ?? null;
  return (
    <section className="panel srdetail" aria-labelledby="hlrr-title" data-testid="hlr-recent">
      <header className="srdetail__head">
        <Zap size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="hlrr-title">Recent Setup / Chart Snapshot</h2>
      </header>
      {!s || !last ? (
        <Empty text="No setup event recorded in the analysed history." />
      ) : (
        <>
          <MiniChart bars={snapshotWindow(m5, s)} s={s} />
          <dl className="hlrkv">
            <dt>Event</dt><dd>{last.to.replace(/_/g, ' ')}</dd>
            <dt>Time</dt><dd>{fmtTime(last.time, tz)}</dd>
            <dt>Price</dt><dd className="num">{s.entry ? formatPrice(s.entry.price, d) : s.m5 ? formatPrice(s.m5.close, d) : s.reclaim ? formatPrice(s.reclaim.price, d) : formatPrice(s.level, d)}</dd>
            <dt>Key zone</dt><dd className="num">{s.zone ? `${formatPrice(s.zone.low, d)} – ${formatPrice(s.zone.high, d)}` : formatPrice(s.level, d)}</dd>
            <dt>Sweep</dt><dd className="num">{s.sweep ? formatPrice(s.sweep.extreme, d) : '—'}</dd>
            <dt>Reclaim</dt><dd className="num">{s.reclaim ? formatPrice(s.reclaim.price, d) : '—'}</dd>
            <dt>Confirmation</dt><dd>{s.m5 ? `M5 ${s.m5.kind}` : '—'}</dd>
            <dt>Status</dt><dd><StateBadge s={s} /></dd>
            <dt>Next condition</dt><dd>{nextRequired(s, d)}</dd>
          </dl>
        </>
      )}
    </section>
  );
}
