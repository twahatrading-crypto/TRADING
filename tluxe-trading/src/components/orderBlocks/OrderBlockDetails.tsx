import { Boxes, Gauge, Layers3, Zap } from 'lucide-react';
import { OB_SCORE_WEIGHTS } from '../../engines/orderBlocks/config';
import { isLiveBlock } from '../../engines/orderBlocks/mtf';
import type { OBConfluence, OBScoreKey, OrderBlock } from '../../engines/orderBlocks/types';
import type { Candle } from '../../types/market';
import { formatPrice, formatSigned } from '../../utils/format';
import { fmtTime, formatBars } from './format';
import { excerptCandles, typeShort, type MitigationEvent } from './obView';
import { OBStateBadge, TypeBadge } from './OrderBlockPanel';

const Empty = ({ text }: { text: string }) => <p className="srdetail__empty">{text}</p>;

export function OrderBlockDetailsPanel({ block, decimals, tz, emptyText }: { block: OrderBlock | null; decimals: number; tz: string; emptyText: string }) {
  const d = block?.displacement;
  return (
    <section className="panel srdetail" aria-labelledby="obd-title" data-testid="ob-details">
      <header className="srdetail__head">
        <Boxes size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="obd-title">Order Block Details</h2>
        {block && (
          <>
            <TypeBadge type={block.type} />
            <span className="srtag">{block.timeframe}</span>
            <OBStateBadge block={block} />
          </>
        )}
      </header>
      {!block || !d ? (
        <Empty text={emptyText} />
      ) : (
        <dl className="srkv">
          <div><dt>Type</dt><dd>{block.type === 'bullish' ? 'Bullish order block' : 'Bearish order block'}</dd></div>
          <div><dt>Zone (low – high)</dt><dd className="num">{formatPrice(block.low, decimals)} – {formatPrice(block.high, decimals)}</dd></div>
          <div><dt>Midpoint · height</dt><dd className="num">{formatPrice(block.mid, decimals)} · {formatPrice(block.high - block.low, decimals)}</dd></div>
          <div><dt>Boundary</dt><dd>{block.boundaryMode === 'wickBody' ? 'Wick + body' : 'Full range'} · frozen at confirmation</dd></div>
          <div><dt>Score</dt><dd className="num srkv__score">{block.score.total} <span>/ 100</span></dd></div>
          <div>
            <dt>Origin candle{block.originCandles > 1 ? 's' : ''}</dt>
            <dd>
              {fmtTime(block.originTime, tz)}
              {block.originCandles > 1 && <span className="srmuted"> · cluster of {block.originCandles}</span>}
              <span className="num obohlc">
                O {formatPrice(block.originOpen, decimals)} H {formatPrice(block.originHigh, decimals)} L {formatPrice(block.originLow, decimals)} C {formatPrice(block.originClose, decimals)}
              </span>
            </dd>
          </div>
          <div><dt>Structure break</dt><dd>{block.breakKind} {block.type === 'bullish' ? 'up' : 'down'} through <span className="num">{formatPrice(block.brokenLevel, decimals)}</span> <span className="srmuted">(close beyond by {formatPrice(block.breakDistance, decimals)})</span></dd></div>
          <div><dt>Confirmed (known)</dt><dd>{fmtTime(block.confirmedAt, tz)}</dd></div>
          <div><dt>Displacement</dt><dd className="num">{d.legAtr.toFixed(2)} ATR leg · max body {d.maxBodyAtr.toFixed(2)} ATR · {formatBars(d.bars)}</dd></div>
          <div><dt>Imbalance in leg</dt><dd>{block.hasImbalance ? 'Yes — fair-value gap' : 'No'}</dd></div>
          <div><dt>Tests</dt><dd className="num">{block.tests.length}{block.firstTestAt !== null && <span className="srmuted"> · first {fmtTime(block.firstTestAt, tz)}</span>}</dd></div>
          <div><dt>Mitigation</dt><dd className="num">{Math.round(block.mitigationPct)}%{block.mitigatedAt !== null && <span className="srmuted"> · mitigated {fmtTime(block.mitigatedAt, tz)}</span>}</dd></div>
          <div><dt>Invalidation</dt><dd>{block.invalidatedAt !== null ? `Closed beyond the far edge · ${fmtTime(block.invalidatedAt, tz)}` : block.expiredAt !== null ? `Expired · ${fmtTime(block.expiredAt, tz)}` : 'Not invalidated'}</dd></div>
          <div><dt>Last interaction</dt><dd>{fmtTime(block.lastInteractionAt, tz)}</dd></div>
          <div><dt>Age</dt><dd>{formatBars(block.ageBars)}</dd></div>
          <div>
            <dt>Distance (mid)</dt>
            <dd className={`num ${(block.distance ?? 0) >= 0 ? 'up' : 'down'}`}>
              {formatSigned(block.distance, decimals)}
              {block.distanceAtr !== null && <span className="srmuted"> ({Math.abs(block.distanceAtr).toFixed(1)} ATR)</span>}
            </dd>
          </div>
          <div><dt>ID</dt><dd><code className="obid">{block.id}</code></dd></div>
        </dl>
      )}
    </section>
  );
}

const LABEL: Record<OBScoreKey, string> = {
  timeframe: 'Timeframe',
  displacement: 'Displacement',
  structure: 'Structure',
  origin: 'Origin quality',
  freshness: 'Freshness',
  mitigation: 'Mitigation',
  imbalance: 'Imbalance',
  confluence: 'MTF confluence',
};

export function ScoreComponentsPanel({ block }: { block: OrderBlock | null }) {
  const keys = Object.keys(OB_SCORE_WEIGHTS) as OBScoreKey[];
  return (
    <section className="panel srdetail" aria-labelledby="obs-title">
      <header className="srdetail__head">
        <Gauge size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="obs-title">Score Components</h2>
      </header>
      <table className="obscore" data-testid="ob-score">
        <thead>
          <tr><th>Component</th><th className="num-col">Raw</th><th className="num-col">Weight</th><th className="num-col" title="Contribution = weight × raw ÷ 100">Contrib.</th></tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const raw = block?.score.components[k] ?? null;
            const c = block?.score.contributions[k] ?? null;
            return (
              <tr key={k} data-testid={`ob-score-${k}`}>
                <td>
                  {LABEL[k]}
                  <span className="obscore__bar" aria-hidden="true"><span style={{ width: `${raw ?? 0}%` }} /></span>
                </td>
                <td className="num">{raw === null ? '—' : Math.round(raw)}</td>
                <td className="num">{OB_SCORE_WEIGHTS[k]}%</td>
                <td className="num">{c === null ? '—' : c.toFixed(1)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td />
            <td className="num">{keys.reduce((a, k) => a + OB_SCORE_WEIGHTS[k], 0)}%</td>
            <td className="num"><strong>{block ? block.score.total : '—'}</strong></td>
          </tr>
        </tfoot>
      </table>
      <p className="obnote">Total = Σ weight × raw ÷ 100, rounded. No hidden adjustments. Descriptive strength — not a probability.</p>
    </section>
  );
}

export function MtfOrderBlocksPanel({ block, blocks, confluences, decimals, onSelect }: { block: OrderBlock | null; blocks: readonly OrderBlock[]; confluences: readonly OBConfluence[]; decimals: number; onSelect: (id: string) => void }) {
  const conf = block ? (confluences.find((c) => c.blockIds.includes(block.id)) ?? null) : null;
  // Independent detections on other timeframes overlapping the selected zone (same type, live).
  const others = block
    ? blocks
        .filter((x) => x.id !== block.id && x.type === block.type && x.timeframe !== block.timeframe && isLiveBlock(x) && Math.min(x.high, block.high) > Math.max(x.low, block.low))
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, 6)
    : [];
  return (
    <section className="panel srdetail" aria-labelledby="obm-title">
      <header className="srdetail__head">
        <Layers3 size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="obm-title">Multi-Timeframe Order Blocks</h2>
        {conf && <span className="srtag srtag--blue">{conf.timeframes.length} TF</span>}
      </header>
      {!block ? (
        <Empty text="Select a block to see independently detected order blocks on other timeframes." />
      ) : (
        <>
          <table className="obmini">
            <tbody>
              {[block, ...others].map((x) => (
                <tr key={x.id} className={x.id === block.id ? 'is-selected' : ''} onClick={() => onSelect(x.id)}>
                  <td>{x.timeframe}</td>
                  <td className="num obmini__zone">{formatPrice(x.low, decimals)} – {formatPrice(x.high, decimals)}</td>
                  <td className="num">{x.score.total}</td>
                  <td><OBStateBadge block={x} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {conf ? (
            <div className="srcfbox obcfbox">
              <span>Overlap ({conf.timeframes.join(' · ')})</span>
              <strong className="num">{formatPrice(conf.low, decimals)} – {formatPrice(conf.high, decimals)}</strong>
              <span>Confluence score</span>
              <strong className="num">{conf.score}</strong>
            </div>
          ) : (
            <p className="srmuted obnote">No overlapping live {typeShort(block.type).toLowerCase()} block on another timeframe.</p>
          )}
          <p className="obnote">Each timeframe is detected from its own candles; confluence is a separate result and never changes a block.</p>
        </>
      )}
    </section>
  );
}

/** Small SVG excerpt: the block's own-timeframe closed candles around the return into the zone. */
export function MitigationExcerpt({ candles, block, testTime }: { candles: readonly Candle[]; block: OrderBlock; testTime: number }) {
  const bars = excerptCandles(candles, block, testTime);
  if (bars.length === 0) return <p className="srmuted obnote">Candles for this excerpt are not loaded.</p>;
  const W = 320;
  const H = 120;
  const lo = Math.min(block.low, ...bars.map((c) => c.low));
  const hi = Math.max(block.high, ...bars.map((c) => c.high));
  const pad = (hi - lo) * 0.06 || 1;
  const y = (p: number) => H - ((p - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const step = W / bars.length;
  const bw = Math.max(1, step * 0.6);
  const iOrigin = bars.findIndex((c) => c.time === block.originTime);
  const x0 = iOrigin >= 0 ? iOrigin * step : 0;
  const bull = block.type === 'bullish';
  return (
    <svg className="obexcerpt" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${bars.length} closed ${block.timeframe} candles around the return into the zone`} data-testid="ob-excerpt">
      <rect x={x0} y={y(block.high)} width={W - x0} height={Math.max(3, y(block.low) - y(block.high))} className={bull ? 'obexcerpt__zone--bull' : 'obexcerpt__zone--bear'} />
      {bars.map((c, i) => {
        const cx = i * step + step / 2;
        const up = c.close >= c.open;
        const isTest = c.time === testTime;
        return (
          <g key={c.time} className={`${up ? 'obexcerpt__up' : 'obexcerpt__down'}${isTest ? ' is-test' : ''}`}>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} />
            <rect x={cx - bw / 2} y={y(Math.max(c.open, c.close))} width={bw} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} />
            {isTest && <circle cx={cx} cy={bull ? y(c.low) + 6 : y(c.high) - 6} r={2.5} className="obexcerpt__mark" />}
          </g>
        );
      })}
    </svg>
  );
}

export function RecentMitigationPanel({ latest, candles, decimals, tz }: { latest: MitigationEvent | null; candles: readonly Candle[]; decimals: number; tz: string }) {
  return (
    <section className="panel srdetail" aria-labelledby="obr-title" data-testid="ob-recent">
      <header className="srdetail__head">
        <Zap size={17} className="srdetail__icon" aria-hidden="true" />
        <h2 id="obr-title">Recent Mitigation</h2>
        {latest && <OBStateBadge block={latest.block} />}
      </header>
      {!latest ? (
        <Empty text="No return into an order block recorded in the analysed history." />
      ) : (
        <>
          <MitigationExcerpt candles={candles} block={latest.block} testTime={latest.test.time} />
          <dl className="srkv">
            <div><dt>Block</dt><dd>{typeShort(latest.block.type)} OB {latest.block.timeframe} · <span className="num">{formatPrice(latest.block.low, decimals)} – {formatPrice(latest.block.high, decimals)}</span></dd></div>
            <div><dt>Time</dt><dd>{fmtTime(latest.test.time, tz)}</dd></div>
            <div><dt>Test</dt><dd className="num">#{latest.n} · depth {Math.round(latest.test.depthPct)}% of the zone</dd></div>
            <div><dt>Mitigation so far</dt><dd className="num">{Math.round(latest.block.mitigationPct)}%</dd></div>
          </dl>
        </>
      )}
    </section>
  );
}
