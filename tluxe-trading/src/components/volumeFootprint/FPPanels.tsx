import { Activity, BarChart3, ChevronLeft, ChevronRight, Grid3x3, Layers, ScrollText, ShieldCheck, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { FootprintSettings } from '../../engines/volumeFootprint/config';
import type { FPCandle, FPEvent, FPImbalance, FPTimeframe, FootprintSnapshot } from '../../engines/volumeFootprint/types';
import { formatPrice } from '../../utils/format';
import { FP_CHART_TFS, FP_MODES, candleWindow, deltaTone, eventTone, fmtDelta, fmtHms, fmtRatio, fmtUtc, fmtVol, type FPMode, type FPViewSettings } from './fpView';

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
function KV({ rows, testId }: { rows: [string, ReactNode, string?][]; testId?: string }) {
  return (
    <dl className="vpkv fpkv" data-testid={testId}>
      {rows.map(([k, v, tone]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className={tone ? `fp-${tone}` : ''}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------- current candle analysis --------------------------- */

export function CandlePanel({ candle, d, onPrev, onNext, canPrev, canNext, unavailable }: { candle: FPCandle | null; d: number; onPrev: () => void; onNext: () => void; canPrev: boolean; canNext: boolean; unavailable: string | null }) {
  const f = (p: number) => formatPrice(p, d);
  return (
    <Panel
      title="Current Footprint"
      icon={<Activity size={15} />}
      testId="fp-candle"
      className="fpcandle"
      right={
        <div className="fpnav">
          <button type="button" onClick={onPrev} disabled={!canPrev} aria-label="Previous candle">
            <ChevronLeft size={14} />
          </button>
          <button type="button" onClick={onNext} disabled={!canNext} aria-label="Next candle">
            <ChevronRight size={14} />
          </button>
        </div>
      }
    >
      {!candle ? (
        <Empty>{unavailable ?? 'No footprint candle yet.'}</Empty>
      ) : (
        <>
          <KV
            testId="fp-candle-kv"
            rows={[
              ['Time (UTC)', `${candleWindow(candle)}${candle.closed ? '' : ' · forming'}`],
              ['Open', f(candle.open)],
              ['High', f(candle.high)],
              ['Low', f(candle.low)],
              ['Close', f(candle.close)],
              ['Total Volume', fmtVol(candle.volume)],
              ['Bid Volume', fmtVol(candle.bid), 'bear'],
              ['Ask Volume', fmtVol(candle.ask), 'bull'],
              ['Delta', fmtDelta(candle.delta), deltaTone(candle.delta)],
              ['Delta %', candle.deltaPct === null ? '—' : `${candle.deltaPct > 0 ? '+' : ''}${candle.deltaPct.toFixed(1)}%`, deltaTone(candle.delta)],
              ['Candle POC', f(candle.poc), 'gold'],
              ['Max + / − delta', `${fmtDelta(candle.maxDelta)} / ${fmtDelta(candle.minDelta)}`],
              ['Buy Imbalances', String(candle.buyImbalances), 'bull'],
              ['Sell Imbalances', String(candle.sellImbalances), 'bear'],
              ['Stacked (buy / sell)', `${candle.stackedBuy} / ${candle.stackedSell}`],
              ['Absorption Candidates', String(candle.absorption)],
              ['Exhaustion Candidates', String(candle.exhaustion)],
              ['Unclassified Volume', `${fmtVol(candle.unknown)} (${candle.volume ? Math.round((candle.unknown / candle.volume) * 100) : 0}%)`],
              ['Trades / large', `${candle.trades} / ${candle.largeTrades}`],
            ]}
          />
          {(candle.gap || candle.interrupted || candle.late > 0) && (
            <p className="smcnote smcnote--warn" data-testid="fp-candle-flags">
              {[candle.gap && 'SEQUENCE GAP — exchange trades missing (not filled)', candle.interrupted && 'FEED INTERRUPTED during this candle', candle.late > 0 && `${candle.late} late trade(s) excluded`].filter(Boolean).join(' · ')}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/* --------------------------------- settings --------------------------------- */

const opt = <T extends string | number>(v: T, xs: readonly (readonly [T, string])[], on: (v: T) => void, label: string) => (
  <select value={String(v)} aria-label={label} onChange={(e) => on(xs.find(([k]) => String(k) === e.target.value)![0])}>
    {xs.map(([k, l]) => (
      <option key={String(k)} value={String(k)}>
        {l}
      </option>
    ))}
  </select>
);

export function SettingsPanel(p: { tf: FPTimeframe; onTf: (tf: FPTimeframe) => void; analysis: FootprintSettings; onAnalysis: (s: FootprintSettings) => void; view: FPViewSettings; onView: (v: FPViewSettings) => void; replaySpeed: number; onReplaySpeed: (n: number) => void; tick: number }) {
  const a = p.analysis;
  const v = p.view;
  const set = (x: Partial<FootprintSettings>) => p.onAnalysis({ ...a, ...x });
  const setV = (x: Partial<FPViewSettings>) => p.onView({ ...v, ...x });
  const row = (label: string, ctl: ReactNode) => (
    <label className="fpset">
      <span>{label}</span>
      {ctl}
    </label>
  );
  const check = (label: string, val: boolean, on: (b: boolean) => void) => (
    <label className="fpset fpset--check">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={val} onChange={() => on(!val)} />
    </label>
  );
  return (
    <Panel title="Settings" icon={<SlidersHorizontal size={15} />} testId="fp-settings" className="fpsettings">
      {row('Footprint Mode', opt<FPMode>(v.mode, FP_MODES, (mode) => setV({ mode }), 'Footprint mode'))}
      {row('Timeframe', opt<FPTimeframe>(p.tf, FP_CHART_TFS.map((t) => [t, t] as const), p.onTf, 'Footprint timeframe'))}
      {row('Price Aggregation', opt<number>(a.rowTicks, [1, 2, 5, 10, 20, 50].map((n) => [n, `${n} tick${n > 1 ? 's' : ''} (${formatPrice(n * p.tick, 2)})`] as const), (rowTicks) => set({ rowTicks }), 'Price aggregation'))}
      {row('Imbalance Threshold', opt<number>(a.imbalanceRatio, [1.5, 2, 2.5, 3, 4, 5].map((r) => [r, `${Math.round(r * 100)} %`] as const), (imbalanceRatio) => set({ imbalanceRatio }), 'Imbalance threshold'))}
      {row('Imbalance Method', opt<FootprintSettings['imbalanceMode']>(a.imbalanceMode, [['diagonal', 'Diagonal'], ['horizontal', 'Horizontal']], (imbalanceMode) => set({ imbalanceMode }), 'Imbalance method'))}
      {row('Stacked Min Levels', opt<number>(a.stackedLevels, [2, 3, 4, 5].map((n) => [n, `${n} levels`] as const), (stackedLevels) => set({ stackedLevels }), 'Stacked imbalance minimum levels'))}
      {row('Minimum Volume', opt<number>(a.minVolume, [1, 5, 10, 20, 50, 100].map((n) => [n, String(n)] as const), (minVolume) => set({ minVolume }), 'Minimum volume'))}
      {row('Large Trade', opt<number>(a.largeTrade, [10, 25, 50, 100, 200, 500].map((n) => [n, String(n)] as const), (largeTrade) => set({ largeTrade }), 'Large trade threshold'))}
      {row('Delta Highlight', opt<number>(v.deltaHighlight, [25, 50, 100, 200, 500].map((n) => [n, `|Δ| ≥ ${n}`] as const), (deltaHighlight) => setV({ deltaHighlight }), 'Delta highlight threshold'))}
      {row('Text Density', opt<FPViewSettings['density']>(v.density, [['AUTO', 'Auto'], ['LOW', 'Low'], ['HIGH', 'High']], (density) => setV({ density }), 'Text density'))}
      {row('Cell Scaling', opt<FPViewSettings['cellScale']>(v.cellScale, [['SQRT', 'Square root'], ['LINEAR', 'Linear']], (cellScale) => setV({ cellScale }), 'Cell scaling'))}
      {row('Session', <span className="fpfixed">CME Globex · 18:00 NY</span>)}
      {row('Replay Speed', opt<number>(p.replaySpeed, [1, 2, 5, 10].map((n) => [n, `${n}x`] as const), p.onReplaySpeed, 'Replay speed'))}
      {check('Auto Scale', v.autoScale, (autoScale) => setV({ autoScale }))}
      {check('Show Zero Levels', v.showZero, (showZero) => setV({ showZero }))}
      {check('Show Unknown Volume', v.showUnknown, (showUnknown) => setV({ showUnknown }))}
      <p className="smcnote">Display settings only change the view. Aggregation / threshold settings re-aggregate the RECORDED trades deterministically — the recorded evidence never changes.</p>
    </Panel>
  );
}

/* ------------------------------- delta analysis ------------------------------- */

export function DeltaPanel({ candles, snapshot }: { candles: readonly FPCandle[]; snapshot: FootprintSnapshot | null }) {
  const ss = snapshot?.sessionStart ?? null;
  const session = candles.filter((c) => c.closed && (ss === null || c.time >= ss));
  const cur = candles[candles.length - 1] ?? null;
  const maxP = session.reduce((m, c) => Math.max(m, c.delta), 0);
  const maxN = session.reduce((m, c) => Math.min(m, c.delta), 0);
  const avg = session.length ? session.reduce((s, c) => s + c.delta, 0) / session.length : null;
  const bars = candles.slice(-80);
  const mx = Math.max(1, ...bars.map((c) => Math.abs(c.delta)));
  const cell = (k: string, v: string, tone: string) => (
    <div className="fpstat">
      <span>{k}</span>
      <b className={`fp-${tone}`}>{v}</b>
    </div>
  );
  return (
    <Panel title="Delta Analysis" icon={<BarChart3 size={15} />} testId="fp-delta">
      <div className="fpstats">
        {cell('Current Candle', cur ? fmtDelta(cur.delta) : '—', deltaTone(cur?.delta))}
        {cell('Session Delta', snapshot ? fmtDelta(snapshot.sessionDelta) : '—', deltaTone(snapshot?.sessionDelta))}
        {cell('Cumulative Delta', snapshot && snapshot.cvdAvailability !== 'UNAVAILABLE' ? fmtDelta(snapshot.cvd) : '—', deltaTone(snapshot?.cvd))}
        {cell('Largest Positive', session.length ? fmtDelta(maxP) : '—', 'bull')}
        {cell('Largest Negative', session.length ? fmtDelta(maxN) : '—', 'bear')}
        {cell('Avg Candle Delta', avg === null ? '—' : fmtDelta(avg), deltaTone(avg))}
      </div>
      {bars.length > 0 && (
        <svg className="fpbars" viewBox={`0 0 ${bars.length * 4} 60`} preserveAspectRatio="none" aria-label="Candle delta bars">
          <line x1="0" x2={bars.length * 4} y1="30" y2="30" stroke="rgba(255,255,255,0.12)" />
          {bars.map((c, i) => {
            const h = (Math.abs(c.delta) / mx) * 28;
            return <rect key={c.id} x={i * 4} width="3" y={c.delta >= 0 ? 30 - h : 30} height={Math.max(0.5, h)} fill={c.delta >= 0 ? '#3cc9a0' : '#ef5d5d'} />;
          })}
        </svg>
      )}
      <p className="smcnote">Session = CME Globex from 18:00 New York. Delta counts classified (bid / ask) volume only.</p>
    </Panel>
  );
}

export function CvdPanel({ series, snapshot }: { series: { time: number; value: number }[]; snapshot: FootprintSnapshot | null }) {
  const pts = series.slice(-200);
  const lo = Math.min(0, ...pts.map((p) => p.value));
  const hi = Math.max(0, ...pts.map((p) => p.value));
  const W = 300;
  const H = 90;
  const y = (v: number) => (hi === lo ? H / 2 : H - ((v - lo) / (hi - lo)) * H);
  const avail = snapshot?.cvdAvailability ?? 'UNAVAILABLE';
  return (
    <Panel title="Cumulative Delta (CVD)" icon={<TrendingUp size={15} />} testId="fp-cvd" right={<Tag v={avail === 'FULL' ? 'FULL' : avail === 'PARTIAL' ? 'PARTIAL — UNKNOWN EXCLUDED' : 'UNAVAILABLE'} tone={avail === 'FULL' ? 'bull' : avail === 'PARTIAL' ? 'warn' : 'muted'} />}>
      {avail === 'UNAVAILABLE' || pts.length < 2 ? (
        <Empty>{avail === 'UNAVAILABLE' ? 'CVD UNAVAILABLE — needs classified (aggressor-side) trades.' : 'Not enough candles yet.'}</Empty>
      ) : (
        <svg className="fpcvd" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Cumulative delta">
          <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
          <polyline fill="none" stroke="#5b8cff" strokeWidth="1.5" points={pts.map((p, i) => `${(i / (pts.length - 1)) * W},${y(p.value)}`).join(' ')} />
        </svg>
      )}
      <p className="smcnote">Running sum of candle deltas for the loaded {snapshot?.contract ?? ''} history (current contract only).</p>
    </Panel>
  );
}

/* -------------------------------- MTF summary -------------------------------- */

export function MtfPanel({ snapshot, tf, onTf, d }: { snapshot: FootprintSnapshot | null; tf: FPTimeframe; onTf: (tf: FPTimeframe) => void; d: number }) {
  return (
    <Panel title="Multi-Timeframe Summary" icon={<Grid3x3 size={15} />} testId="fp-mtf">
      {!snapshot || snapshot.status === 'UNAVAILABLE' ? (
        <Empty>FOOTPRINT DATA UNAVAILABLE</Empty>
      ) : (
        <Table head={['TF', 'Direction', 'Delta', 'Volume', 'Imbalance B / S', 'POC', 'Unknown']}>
          {snapshot.mtf.map((r) => {
            const c = r.current ?? r.lastClosed;
            return (
              <tr key={r.tf} className={r.tf === tf ? 'is-active' : ''} data-testid="fp-mtf-row" onClick={() => onTf(r.tf)}>
                <td>
                  <button type="button" className="vptf" aria-pressed={r.tf === tf}>
                    {r.tf}
                  </button>
                </td>
                <td className={`fp-${deltaTone(c?.delta)}`}>{!c ? '—' : c.delta > 0 ? '▲ buyers' : c.delta < 0 ? '▼ sellers' : '–'}</td>
                <td className={`num fp-${deltaTone(c?.delta)}`}>{c ? fmtDelta(c.delta) : '—'}</td>
                <td className="num">{c ? fmtVol(c.volume) : '—'}</td>
                <td className="num">{c ? `${c.buyImbalances} / ${c.sellImbalances}` : '—'}</td>
                <td className="num">{c ? formatPrice(c.poc, d) : '—'}</td>
                <td className="num">{c ? fmtVol(c.unknown) : '—'}</td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="smcnote">Each timeframe is its own footprint of the same trades (current candle). Timeframes are never forced to agree.</p>
    </Panel>
  );
}

/* ------------------------------- imbalance levels ------------------------------- */

export function ImbalancePanel({ levels, d }: { levels: readonly FPImbalance[]; d: number }) {
  const [side, setSide] = useState<'All' | 'BUY' | 'SELL'>('All');
  const rows = useMemo(() => [...levels].reverse().filter((x) => side === 'All' || x.side === side).slice(0, 80), [levels, side]);
  return (
    <Panel
      title={`Imbalance Levels (${levels.length})`}
      icon={<Layers size={15} />}
      testId="fp-imbalances"
      right={
        <div className="smcseg" role="group" aria-label="Imbalance side">
          {(['All', 'BUY', 'SELL'] as const).map((x) => (
            <button key={x} type="button" aria-pressed={side === x} onClick={() => setSide(x)}>
              {x}
            </button>
          ))}
        </div>
      }
    >
      {!rows.length ? (
        <Empty>No imbalance levels.</Empty>
      ) : (
        <Table head={['Time', 'Price', 'Side', 'Bid', 'Ask', 'Ratio', 'Stacked?', 'State']}>
          {rows.map((x) => (
            <tr key={x.id} data-testid="fp-imb-row" title={`${x.side === 'BUY' ? `Ask ${x.ask} @ ${x.price} vs Bid ${x.bid} @ ${x.comparedPrice}` : `Bid ${x.bid} @ ${x.price} vs Ask ${x.ask} @ ${x.comparedPrice}`}`}>
              <td>{fmtHms(x.time)}</td>
              <td className="num">{formatPrice(x.price, d)}</td>
              <td className={x.side === 'BUY' ? 'fp-bull' : 'fp-bear'}>{x.side}</td>
              <td className="num">{x.bid}</td>
              <td className="num">{x.ask}</td>
              <td className="num">{fmtRatio(x.ratio)}</td>
              <td>{x.stacked ? 'YES' : '—'}</td>
              <td>
                <Tag v={x.state} tone={x.state === 'ACTIVE' ? 'bull' : x.state === 'TESTED' ? 'warn' : 'muted'} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

/* ---------------------------------- events ---------------------------------- */

export function EventsPanel({ events, d }: { events: readonly FPEvent[]; d: number }) {
  const [type, setType] = useState('All');
  const types = useMemo(() => ['All', ...new Set(events.map((e) => e.type))], [events]);
  const rows = useMemo(() => [...events].reverse().filter((e) => type === 'All' || e.type === type).slice(0, 200), [events, type]);
  return (
    <Panel
      title={`Footprint Events (${events.length})`}
      icon={<ScrollText size={15} />}
      testId="fp-events"
      className="smclog"
      right={
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type filter" className="smcselect">
          {types.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      }
    >
      {!rows.length ? (
        <Empty>No events.</Empty>
      ) : (
        <Table head={['Time (UTC)', 'Event', 'TF', 'Price', 'Volume', 'Delta', 'Evidence']}>
          {rows.map((e) => (
            <tr key={e.id} data-testid="fp-event-row">
              <td>{fmtHms(e.time)}</td>
              <td>
                <Tag v={e.type} tone={eventTone(e)} />
              </td>
              <td>{e.tf ?? '—'}</td>
              <td className="num">{e.price === null ? '—' : formatPrice(e.price, d)}</td>
              <td className="num">{e.volume === null ? '—' : fmtVol(e.volume)}</td>
              <td className={`num fp-${deltaTone(e.delta)}`}>{fmtDelta(e.delta)}</td>
              <td>{e.evidence}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="smcnote">Candidates are measured evidence, not guaranteed absorption / exhaustion / reversal and never a BUY / SELL signal.</p>
    </Panel>
  );
}

/* ------------------------------- data integrity ------------------------------- */

export function IntegrityPanel({ snapshot, provider, reason }: { snapshot: FootprintSnapshot | null; provider: string | null; reason: string | null }) {
  const i = snapshot?.integrity ?? null;
  const caps = snapshot?.caps ?? null;
  const st = i?.state ?? 'UNAVAILABLE';
  return (
    <Panel title="Data Integrity" icon={<ShieldCheck size={15} />} testId="fp-integrity" right={<Tag v={st} tone={st === 'GOOD' ? 'bull' : st === 'DEGRADED' ? 'warn' : 'bear'} />}>
      {reason && <p className="smcnote smcnote--warn">{reason}</p>}
      <KV
        rows={[
          ['Provider', provider ?? 'Not connected'],
          ['Contract', snapshot?.contract ?? '—'],
          ['Previous contracts', snapshot?.previousContracts.length ? snapshot.previousContracts.join(', ') : '—'],
          ['Aggressor side', !caps || !caps.trades ? '—' : caps.aggressor === 'EXCHANGE' ? 'Exchange / provider supplied' : caps.aggressor === 'CLASSIFIED' ? `Classified: ${caps.classificationMethod ?? 'method not named'}` : 'UNKNOWN (not supplied)'],
          ['Sequenced / trade ids', caps ? `${caps.sequenced ? 'yes' : 'no'} / ${caps.tradeIds ? 'yes' : 'no'}` : '—'],
          ['Accepted trades', i ? i.accepted.toLocaleString('en-US') : '—'],
          ['Duplicates dropped', i ? String(i.duplicates) : '—'],
          ['Out-of-order', i ? String(i.outOfOrder) : '—'],
          ['Late (excluded)', i ? String(i.late) : '—'],
          ['Sequence gaps / missing', i ? `${i.gaps} / ${i.missing}` : '—'],
          ['Disconnects / reconnects', i ? `${i.disconnects} / ${i.reconnects}` : '—'],
          ['Contract changes', i ? String(i.contractChanges) : '—'],
          ['Last exchange time', fmtUtc(i?.lastExchTime ?? null)],
          ['Last receive time', fmtUtc(i?.lastRecvTime ?? null)],
          ['Latency', i?.latencyMs === null || i?.latencyMs === undefined ? '—' : `${i.latencyMs} ms`],
        ]}
      />
      {!!i?.reasons.length && <p className="smcnote">{i.reasons.join(' ')}</p>}
      <p className="smcnote">Missing exchange trades are never filled; late trades never repaint closed candles.</p>
    </Panel>
  );
}
