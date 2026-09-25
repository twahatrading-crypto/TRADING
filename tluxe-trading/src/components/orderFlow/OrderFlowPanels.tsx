import { BookOpen, ChartColumnBig, CircleAlert, ListFilter, RotateCcw, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_HEATMAP_VIEW, DEFAULT_ORDER_FLOW_SETTINGS, type HeatmapViewSettings, type OrderFlowEngineSettings } from '../../engines/orderFlow/config';
import type { FeedStatus, OrderFlowEvent, OrderFlowEventType, VolumeAtPrice } from '../../engines/orderFlow/types';
import type { OrderFlowPanelsData } from '../../services/orderFlow/view';
import { STATUS_TONE, statusText } from './status';
import { formatPrice } from '../../utils/format';

export const Pill = ({ status, label }: { status: FeedStatus; label?: string }) => (
  <span className={`ofpill ofpill--${STATUS_TONE[status]}`}>
    <i aria-hidden="true" />
    {label ? `${label}: ` : ''}
    {statusText(status)}
  </span>
);

function Panel({ title, icon, children, right, className, testId }: { title: string; icon: ReactNode; children: ReactNode; right?: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={`panel ofpanel ${className ?? ''}`} aria-label={title} data-testid={testId}>
      <header className="ofpanel__head">
        <h2>
          {icon} {title}
        </h2>
        {right}
      </header>
      <div className="ofpanel__body">{children}</div>
    </section>
  );
}
export function Unavailable({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="ofna" role="status">
      <CircleAlert size={18} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

/* ------------------------------------ COB ------------------------------------ */

export function BookPanel({ data, d, depthStatus, depthDetail, className }: { data: OrderFlowPanelsData; d: number; depthStatus: FeedStatus; depthDetail: string | null; className?: string }) {
  const b = data.book;
  return (
    <Panel title="COB — Current Order Book" icon={<BookOpen size={15} aria-hidden="true" />} right={<Pill status={depthStatus} />} className={`ofbook ${className ?? ''}`} testId="of-book">
      {!b ? (
        <Unavailable title="LEVEL-2 DATA UNAVAILABLE" detail={depthDetail ?? 'No valid order book. Levels are never invented.'} />
      ) : (
        <>
          <table className="ofbook__t">
            <thead>
              <tr><th>Price</th><th className="num-col">Ask Size</th><th className="num-col">Bid Size</th></tr>
            </thead>
            <tbody>
              {[...b.asks].reverse().map((l) => (
                <tr key={`a${l.price}`} className={l.price === b.bestAsk ? 'is-best' : ''}>
                  <td className="num">{formatPrice(l.price, d)}</td>
                  <td className="num ofask" style={{ ['--w' as string]: `${Math.min(100, (100 * l.size) / Math.max(1, ...b.asks.map((x) => x.size)))}%` }}>{l.size.toLocaleString()}</td>
                  <td className="num ofdim">—</td>
                </tr>
              ))}
              {b.bids.map((l) => (
                <tr key={`b${l.price}`} className={l.price === b.bestBid ? 'is-best' : ''}>
                  <td className="num">{formatPrice(l.price, d)}</td>
                  <td className="num ofdim">—</td>
                  <td className="num ofbid" style={{ ['--w' as string]: `${Math.min(100, (100 * l.size) / Math.max(1, ...b.bids.map((x) => x.size)))}%` }}>{l.size.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="oftotals" data-testid="of-book-totals">
            <span>Best bid <b className="num">{b.bestBid === null ? '—' : formatPrice(b.bestBid, d)}</b></span>
            <span>Best ask <b className="num">{b.bestAsk === null ? '—' : formatPrice(b.bestAsk, d)}</b></span>
            <span>Spread <b className="num">{b.spread === null ? '—' : formatPrice(b.spread, d)}</b></span>
            <span>Total ask <b className="num ofask-t">{b.totalAsk.toLocaleString()}</b></span>
            <span>Total bid <b className="num ofbid-t">{b.totalBid.toLocaleString()}</b></span>
          </div>
          {b.crossed && <p className="ofnote ofnote--warn" role="status">⚠ Crossed / locked book as published by the provider (best bid ≥ best ask) — shown as received, never corrected.</p>}
          <p className="ofnote">Displayed depth as published by the provider (top 20 per side shown; totals over all published levels).</p>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------ SVP ------------------------------------ */

export function ProfilePanel({ session, visible, mode, onMode, d, tradeStatus, tradeDetail, aggressor, className }: { session: VolumeAtPrice[]; visible: VolumeAtPrice[]; mode: 'session' | 'visible'; onMode: (m: 'session' | 'visible') => void; d: number; tradeStatus: FeedStatus; tradeDetail: string | null; aggressor: boolean; className?: string }) {
  const rows = mode === 'session' ? session : visible;
  const max = Math.max(1, ...rows.map((r) => r.buy + r.sell + r.unknown));
  const t = rows.reduce((a, r) => ({ buy: a.buy + r.buy, sell: a.sell + r.sell, unknown: a.unknown + r.unknown }), { buy: 0, sell: 0, unknown: 0 });
  return (
    <Panel
      title="SVP — Volume Profile"
      icon={<ChartColumnBig size={15} aria-hidden="true" />}
      right={
        <div className="ofseg" role="tablist" aria-label="Profile range">
          {(['session', 'visible'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => onMode(m)}>{m === 'session' ? 'Session' : 'Visible range'}</button>
          ))}
        </div>
      }
      className={`ofprofile ${className ?? ''}`}
      testId="of-profile"
    >
      {!rows.length ? (
        <Unavailable title={tradeStatus === 'DATA_UNAVAILABLE' ? 'TRADE DATA UNAVAILABLE' : 'NO EXECUTED VOLUME YET'} detail={tradeDetail ?? 'Executed volume appears only from real prints.'} />
      ) : (
        <>
          <ol className="ofprof">
            {rows.slice(0, 80).map((r) => (
              <li key={r.price}>
                <span className="num">{formatPrice(r.price, d)}</span>
                <span className="ofprof__bar" title={`buy ${r.buy} · sell ${r.sell} · unknown ${r.unknown}`}>
                  <i className="is-sell" style={{ width: `${(100 * r.sell) / max}%` }} />
                  <i className="is-buy" style={{ width: `${(100 * r.buy) / max}%` }} />
                  <i className="is-unk" style={{ width: `${(100 * r.unknown) / max}%` }} />
                </span>
              </li>
            ))}
          </ol>
          <div className="oftotals">
            <span>Buy <b className="num ofbid-t">{t.buy.toLocaleString()}</b></span>
            <span>Sell <b className="num ofask-t">{t.sell.toLocaleString()}</b></span>
            <span>Unknown <b className="num">{t.unknown.toLocaleString()}</b></span>
          </div>
          {!aggressor && <p className="ofnote">This provider supplies no aggressor side: all volume is UNKNOWN (never split into buy / sell).</p>}
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------ CVD ------------------------------------ */

export function CvdPanel({ data, tradeDetail, className }: { data: OrderFlowPanelsData; tradeDetail: string | null; className?: string }) {
  const t = data.totals;
  const s = data.cvdSeries;
  const path = useMemo(() => {
    if (s.length < 2) return '';
    const lo = Math.min(...s);
    const hi = Math.max(...s);
    const rng = hi - lo || 1;
    return s.map((v, i) => `${i ? 'L' : 'M'}${((i / (s.length - 1)) * 100).toFixed(2)},${(38 - ((v - lo) / rng) * 36).toFixed(2)}`).join(' ');
  }, [s]);
  const label = data.cvd === 'FULL' ? 'CVD' : data.cvd === 'PARTIAL' ? 'CVD · PARTIAL' : 'CVD UNAVAILABLE';
  return (
    <Panel title="CVD — Cumulative Volume Delta" icon={<TrendingUp size={15} aria-hidden="true" />} right={<span className={`ofcvd__badge is-${data.cvd.toLowerCase()}`} data-testid="of-cvd-state">{label}</span>} className={`ofcvd ${className ?? ''}`} testId="of-cvd">
      {!t || data.cvd === 'UNAVAILABLE' ? (
        <Unavailable title="CVD UNAVAILABLE" detail={t ? 'The provider supplies no exchange aggressor side, so volume cannot be classified buy / sell. Total volume is still shown under Unknown.' : (tradeDetail ?? 'No executed trades.')} />
      ) : (
        <>
          <strong className={`ofcvd__v num ${t.cvd >= 0 ? 'up' : 'down'}`}>{t.cvd >= 0 ? '+' : ''}{t.cvd.toLocaleString()}</strong>
          {path && (
            <svg className="ofcvd__spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
              <path d={path} />
            </svg>
          )}
        </>
      )}
      {t && (
        <dl className="ofcvd__t" data-testid="of-cvd-totals">
          <dt>Buy volume</dt><dd className="num">{t.buy.toLocaleString()}</dd>
          <dt>Sell volume</dt><dd className="num">{t.sell.toLocaleString()}</dd>
          <dt>Unknown volume</dt><dd className="num">{t.unknown.toLocaleString()}</dd>
          <dt>Total executed</dt><dd className="num">{t.total.toLocaleString()}</dd>
        </dl>
      )}
      <p className="ofnote">CVD += buy-aggressor − sell-aggressor volume (session, from 17:00 CT). Unknown volume never enters either side{data.cvd === 'PARTIAL' ? '; PARTIAL = some volume is unknown or a trade sequence gap occurred' : ''}.</p>
    </Panel>
  );
}

/* ---------------------------------- Events ---------------------------------- */

const EV_LABEL: Record<OrderFlowEventType, string> = {
  LARGE_TRADE: 'Large Trade',
  LIQUIDITY_HIT: 'Liquidity Hit',
  DEPTH_SWEEP: 'Depth Sweep',
  STACKING: 'Stacking',
  PULLING: 'Pulling',
  ABSORPTION_CANDIDATE: 'Absorption Candidate',
};
const EV_DOT: Record<OrderFlowEventType, string> = { LARGE_TRADE: 'green', LIQUIDITY_HIT: 'red', DEPTH_SWEEP: 'orange', STACKING: 'blue', PULLING: 'purple', ABSORPTION_CANDIDATE: 'gold' };
const fmtT = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(ms % 1000).padStart(3, '0');

export function EventsPanel({ events, limitations, d, onSelect, selected, className }: { events: OrderFlowEvent[]; limitations: string[]; d: number; onSelect: (e: OrderFlowEvent) => void; selected: string | null; className?: string }) {
  const [filter, setFilter] = useState<OrderFlowEventType | 'ALL'>('ALL');
  const counts = useMemo(() => {
    const c = {} as Record<OrderFlowEventType, number>;
    for (const e of events) c[e.type] = (c[e.type] ?? 0) + 1;
    return c;
  }, [events]);
  const rows = filter === 'ALL' ? events : events.filter((e) => e.type === filter);
  return (
    <Panel title="Recent Order-Flow Events" icon={<ListFilter size={15} aria-hidden="true" />} className={`ofevents ${className ?? ''}`} testId="of-events">
      <div className="ofchips" role="tablist" aria-label="Event filter">
        <button type="button" role="tab" aria-selected={filter === 'ALL'} onClick={() => setFilter('ALL')}>All <b>{events.length}</b></button>
        {(Object.keys(EV_LABEL) as OrderFlowEventType[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{EV_LABEL[k]} <b>{counts[k] ?? 0}</b></button>
        ))}
      </div>
      <div className="srtable-wrap ofevents__wrap">
        <table className="srtable ofevents__t">
          <thead>
            <tr><th>Time</th><th>Event</th><th className="num-col">Price</th><th className="num-col">Size</th><th>Side</th><th>Evidence</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((e) => (
              <tr key={e.id} className={selected === e.id ? 'is-sel' : ''} onClick={() => onSelect(e)} tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && onSelect(e)} data-testid="of-event-row">
                <td className="num">{fmtT(e.time)}</td>
                <td><i className={`ofdot is-${EV_DOT[e.type]}`} aria-hidden="true" /> {EV_LABEL[e.type].toUpperCase()}</td>
                <td className="num">{formatPrice(e.price, d)}</td>
                <td className="num">{e.size.toLocaleString()}</td>
                <td className={e.side === 'BUY' || e.side === 'bid' ? 'ofbid-t' : e.side === 'SELL' || e.side === 'ask' ? 'ofask-t' : ''}>{String(e.side).toUpperCase()}</td>
                <td className="ofevents__ev">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="srtable__none">No order-flow events. Depth-dependent detectors run only on a valid Level-2 book.</p>}
      </div>
      {limitations.map((l) => <p key={l} className="ofnote ofnote--warn">⚠ {l}</p>)}
      <p className="ofnote">Measured evidence only — events never assert intent. "Candidate" means the measurement matched, nothing more.</p>
    </Panel>
  );
}

/* --------------------------------- Settings --------------------------------- */

function Slider({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="ofslider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <b className="num">{fmt ? fmt(value) : value}</b>
    </label>
  );
}

export function SettingsPanel({ view, onView, engine, onEngine, className }: { view: HeatmapViewSettings; onView: (v: HeatmapViewSettings) => void; engine: OrderFlowEngineSettings; onEngine: (p: Partial<OrderFlowEngineSettings>) => void; className?: string }) {
  const set = <K extends keyof HeatmapViewSettings>(k: K, v: HeatmapViewSettings[K]) => onView({ ...view, [k]: v });
  return (
    <Panel
      title="Heatmap Settings"
      icon={<SlidersHorizontal size={15} aria-hidden="true" />}
      right={
        <button type="button" className="ofbtn" onClick={() => { onView({ ...DEFAULT_HEATMAP_VIEW }); onEngine({ ...DEFAULT_ORDER_FLOW_SETTINGS }); }}>
          <RotateCcw size={13} aria-hidden="true" /> Reset
        </button>
      }
      className={`ofsettings ${className ?? ''}`}
      testId="of-settings"
    >
      <Slider label="Lower cut-off" value={view.lowerCutoff} min={0} max={95} step={1} onChange={(v) => set('lowerCutoff', Math.min(v, view.upperCutoff - 1))} fmt={(v) => `${v}%`} />
      <Slider label="Upper cut-off" value={view.upperCutoff} min={5} max={100} step={1} onChange={(v) => set('upperCutoff', Math.max(v, view.lowerCutoff + 1))} fmt={(v) => `${v}%`} />
      <Slider label="Contrast" value={view.contrast} min={0.4} max={3} step={0.1} onChange={(v) => set('contrast', v)} fmt={(v) => v.toFixed(1)} />
      <Slider label="Smoothing" value={view.smoothing} min={0} max={4} step={1} onChange={(v) => set('smoothing', v)} />
      <Slider label="Price aggregation" value={view.priceAggregation} min={1} max={10} step={1} onChange={(v) => set('priceAggregation', v)} fmt={(v) => `${v} tick${v > 1 ? 's' : ''}`} />
      <Slider label="Minimum depth" value={view.minDepth} min={1} max={200} step={1} onChange={(v) => set('minDepth', v)} />
      <Slider label="Time aggregation" value={engine.timeAggregationMs} min={250} max={10_000} step={250} onChange={(v) => onEngine({ timeAggregationMs: v })} fmt={(v) => `${v / 1000}s`} />
      <Slider label="Large trade threshold" value={engine.largeTradeSize} min={5} max={500} step={5} onChange={(v) => onEngine({ largeTradeSize: v })} />
      <Slider label="Sweep threshold" value={engine.sweepLevels} min={2} max={10} step={1} onChange={(v) => onEngine({ sweepLevels: v })} fmt={(v) => `${v} levels`} />
      <label className="ofslider">
        <span>Color scheme</span>
        <select value={view.colorScheme} onChange={(e) => set('colorScheme', e.target.value as HeatmapViewSettings['colorScheme'])} aria-label="Color scheme">
          <option value="blue-red">Blue → Red</option>
          <option value="thermal">Thermal</option>
          <option value="mono">Mono</option>
        </select>
      </label>
      <div className="ofchecks">
        <label><input type="checkbox" checked={view.autoNormalize} onChange={(e) => set('autoNormalize', e.target.checked)} /> Auto normalization</label>
        <label><input type="checkbox" checked={view.showTrades} onChange={(e) => set('showTrades', e.target.checked)} /> Show volume dots</label>
        <label><input type="checkbox" checked={view.showPriceLine} onChange={(e) => set('showPriceLine', e.target.checked)} /> Show price line</label>
      </div>
      <p className="ofnote">Cut-offs, contrast, smoothing, colours, price aggregation and minimum depth change the picture only. Time aggregation and the detection thresholds rebuild the engine deterministically from the recorded stream.</p>
    </Panel>
  );
}
