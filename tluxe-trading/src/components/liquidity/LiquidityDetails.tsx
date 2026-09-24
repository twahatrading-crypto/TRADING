import { Gauge, Layers3, Target, Zap } from 'lucide-react';
import { LIQUIDITY_SCORE_WEIGHTS } from '../../engines/liquidity/config';
import type { LiquidityCluster, LiquidityPool, LiquidityScoreKey, SweepEvent } from '../../engines/liquidity/types';
import { formatPrice, formatSigned } from '../../utils/format';
import { fmtTime, formatBars, sessionsAt } from './format';
import { SideBadge, StateBadge } from './LiquidityPanel';
import { sourceLabel } from './liquidityView';

const Empty = ({ text }: { text: string }) => <p className="srdetail__empty">{text}</p>;

export function LiquidityDetailsPanel({ pool, decimals, tz, emptyText }: { pool: LiquidityPool | null; decimals: number; tz: string; emptyText: string }) {
  const last = pool?.sweeps.at(-1) ?? null;
  return (
    <section className="panel srdetail" aria-labelledby="ld-title" data-testid="lq-details">
      <header className="srdetail__head">
        <Target size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="ld-title">Liquidity Details</h2>
        {pool && (
          <>
            <SideBadge side={pool.side} />
            <span className="srtag">{pool.timeframe}</span>
            <StateBadge pool={pool} />
          </>
        )}
      </header>
      {!pool ? (
        <Empty text={emptyText} />
      ) : (
        <dl className="srkv">
          <div><dt>{pool.side === 'BSL' ? 'Buy-side liquidity' : 'Sell-side liquidity'}</dt><dd>{pool.side === 'BSL' ? 'resting above the highs' : 'resting below the lows'}</dd></div>
          <div><dt>Level (to be taken)</dt><dd className="num">{formatPrice(pool.level, decimals)}</dd></div>
          <div><dt>Range</dt><dd className="num">{formatPrice(pool.rangeLow, decimals)} – {formatPrice(pool.rangeHigh, decimals)} <span className="srmuted">± {formatPrice(pool.tolerance, decimals)}</span></dd></div>
          <div><dt>Score</dt><dd className="num srkv__score">{pool.score.total} <span>/ 100</span></dd></div>
          <div><dt>Source</dt><dd>{sourceLabel(pool)}</dd></div>
          <div><dt>Contributing {pool.side === 'BSL' ? 'highs' : 'lows'}</dt><dd className="num">{pool.contributions.map((c) => formatPrice(c.price, decimals)).join(' · ')}</dd></div>
          <div><dt>Tests</dt><dd className="num">{pool.tests.length}</dd></div>
          <div><dt>Swing bar</dt><dd>{fmtTime(pool.createdAt, tz)}</dd></div>
          <div><dt>Confirmed (known)</dt><dd>{fmtTime(pool.confirmedAt, tz)}</dd></div>
          <div><dt>Last interaction</dt><dd>{fmtTime(pool.lastInteractionAt, tz)}</dd></div>
          <div><dt>Age</dt><dd>{formatBars(pool.ageBars)}</dd></div>
          <div>
            <dt>Distance</dt>
            <dd className={`num ${(pool.distance ?? 0) >= 0 ? 'up' : 'down'}`}>
              {formatSigned(pool.distance, decimals)}
              {pool.distanceAtr !== null && <span className="srmuted"> ({pool.distanceAtr.toFixed(1)} ATR)</span>}
            </dd>
          </div>
          <div><dt>Sweep status</dt><dd>{pool.sweeps.length === 0 ? 'Not swept' : `${pool.sweeps.length} sweep${pool.sweeps.length > 1 ? 's' : ''} · last ${fmtTime(last!.time, tz)}`}{pool.liveProbe && <span className="lqprobe"> · forming bar beyond (unconfirmed)</span>}</dd></div>
          <div><dt>Reclaim status</dt><dd>{pool.reclaimed ? 'RECLAIMED' : pool.sweeps.length ? 'Not reclaimed' : '—'}</dd></div>
          <div><dt>ID</dt><dd><code className="lqid">{pool.id}</code></dd></div>
        </dl>
      )}
    </section>
  );
}

const LABEL: Record<LiquidityScoreKey, string> = {
  timeframe: 'Timeframe',
  equalLevels: 'Equal H / L',
  significance: 'Significance',
  displacement: 'Displacement',
  tests: 'Tests',
  freshness: 'Freshness',
  confluence: 'MTF',
};

export function StrengthComponentsPanel({ pool }: { pool: LiquidityPool | null }) {
  return (
    <section className="panel srdetail" aria-labelledby="ls-title">
      <header className="srdetail__head">
        <Gauge size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="ls-title">Strength Components</h2>
      </header>
      <ul className="srbars">
        {(Object.keys(LIQUIDITY_SCORE_WEIGHTS) as LiquidityScoreKey[]).map((k) => {
          const v = pool?.score.components[k] ?? null;
          return (
            <li key={k} data-testid={`lq-score-${k}`}>
              <span className="srbars__label">{LABEL[k]}</span>
              <span className="srbars__track" aria-hidden="true">
                <span className={`srbars__fill ${k === 'confluence' || k === 'equalLevels' ? 'is-blue' : ''}`} style={{ width: `${v ?? 0}%` }} />
              </span>
              <span className="srbars__val num">{v === null ? '—' : Math.round(v)}</span>
              <span className="srbars__w num">×{LIQUIDITY_SCORE_WEIGHTS[k]}</span>
            </li>
          );
        })}
      </ul>
      <p className="srbars__total">
        {pool ? (
          <>
            Σ weighted <strong className="num">{pool.score.weighted}</strong> × state {pool.score.stateFactor} = <strong className="num">{pool.score.total}</strong>
          </>
        ) : (
          <span className="srmuted">Select a pool to see the values the engine used. Strength is not a probability.</span>
        )}
      </p>
    </section>
  );
}

export function MtfLiquidityPanel({ pool, pools, clusters, decimals, onSelect }: { pool: LiquidityPool | null; pools: readonly LiquidityPool[]; clusters: readonly LiquidityCluster[]; decimals: number; onSelect: (id: string) => void }) {
  const cluster = pool ? (clusters.find((c) => c.poolIds.includes(pool.id)) ?? null) : null;
  // Nearby independent detections on other timeframes (same side, within 1 ATR of the selected level).
  const nearby = pool
    ? pools
        .filter((x) => x.id !== pool.id && x.side === pool.side && x.timeframe !== pool.timeframe && (x.state === 'ACTIVE' || x.state === 'TESTED') && Math.abs(x.level - pool.level) <= pool.atrAtConfirmation)
        .sort((a, b) => Math.abs(a.level - pool.level) - Math.abs(b.level - pool.level))
        .slice(0, 6)
    : [];
  return (
    <section className="panel srdetail" aria-labelledby="lm-title">
      <header className="srdetail__head">
        <Layers3 size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="lm-title">Multi-Timeframe Liquidity</h2>
        {cluster && <span className="srtag srtag--blue">{cluster.timeframes.length} TF</span>}
      </header>
      {!pool ? (
        <Empty text="Select a pool to see independently detected liquidity on other timeframes." />
      ) : (
        <>
          <table className="lqmini">
            <tbody>
              {[pool, ...nearby].map((x) => (
                <tr key={x.id} className={x.id === pool.id ? 'is-selected' : ''} onClick={() => onSelect(x.id)}>
                  <td>{x.timeframe}</td>
                  <td><SideBadge side={x.side} /></td>
                  <td className="num">{formatPrice(x.level, decimals)}</td>
                  <td className="num">{x.score.total}</td>
                  <td><StateBadge pool={x} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {cluster ? (
            <div className="srcfbox lqcfbox">
              <span>MTF Cluster ({cluster.side})</span>
              <strong className="num">
                {formatPrice(cluster.low, decimals)}
                {cluster.high !== cluster.low && ` – ${formatPrice(cluster.high, decimals)}`}
              </strong>
              <span>Combined strength</span>
              <strong className="num">{cluster.score}</strong>
            </div>
          ) : (
            <p className="srmuted lqnote">No overlapping detection on another timeframe{nearby.length ? ' (nearby levels listed above do not overlap within tolerance)' : ''}.</p>
          )}
        </>
      )}
    </section>
  );
}

export function RecentSweepPanel({ latest, decimals, tz }: { latest: { pool: LiquidityPool; sweep: SweepEvent } | null; decimals: number; tz: string }) {
  return (
    <section className="panel srdetail" aria-labelledby="rs-title" data-testid="lq-recent-sweep">
      <header className="srdetail__head">
        <Zap size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="rs-title">Recent Sweep</h2>
        {latest && <span className={`lqstate lqstate--swept`}>{latest.sweep.side} SWEPT</span>}
      </header>
      {!latest ? (
        <Empty text="No sweep recorded in the analysed history." />
      ) : (
        <dl className="srkv">
          <div><dt>Side swept</dt><dd>{latest.sweep.side === 'BSL' ? 'Buy-side (above highs)' : 'Sell-side (below lows)'}</dd></div>
          <div><dt>Timeframe</dt><dd>{latest.pool.timeframe}</dd></div>
          <div><dt>Liquidity price</dt><dd className="num">{formatPrice(latest.sweep.level, decimals)}</dd></div>
          <div><dt>Sweep extreme</dt><dd className="num">{formatPrice(latest.sweep.extremePrice, decimals)}</dd></div>
          <div><dt>Penetration</dt><dd className="num">{formatPrice(latest.sweep.penetration, decimals)} <span className="srmuted">({latest.sweep.penetrationAtr.toFixed(2)} ATR)</span></dd></div>
          <div><dt>Time</dt><dd>{fmtTime(latest.sweep.time, tz)}</dd></div>
          <div><dt>Session</dt><dd>{sessionsAt(latest.sweep.time).join(' · ') || '—'}</dd></div>
          <div><dt>Kind</dt><dd>{latest.sweep.kind === 'wick' ? 'Wick sweep' : 'Close-through'}{latest.sweep.sequence > 1 ? ` · repeated #${latest.sweep.sequence}` : ' · single'}</dd></div>
          <div><dt>Reclaim</dt><dd>{latest.sweep.reclaimed ? `Yes (${latest.sweep.barsToReclaim} bar${latest.sweep.barsToReclaim === 1 ? '' : 's'})` : latest.sweep.outcome === 'pending' ? 'Pending' : 'No'}</dd></div>
          <div><dt>Outcome</dt><dd>{latest.sweep.outcome === 'accepted' ? 'Accepted beyond — continuation' : latest.sweep.outcome === 'reclaimed' ? 'Reclaimed (information only)' : latest.sweep.outcome === 'returned' ? 'Returned after the reclaim window' : 'Pending'}</dd></div>
          <div><dt>Current state</dt><dd><StateBadge pool={latest.pool} /></dd></div>
          <p className="lqnote">Liquidity swept ≠ reversal confirmed.</p>
        </dl>
      )}
    </section>
  );
}
