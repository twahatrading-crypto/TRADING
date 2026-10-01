import { ChevronDown, ChevronRight, Expand, Map as MapIcon, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useServices } from '../app/servicesContext';
import { tickSizeOf } from '../config/instruments';
import { useActiveInstrument, useMarket } from '../hooks/useMarket';
import { usePersistentState } from '../hooks/usePersistentState';
import { useStore } from '../store/createStore';
import type { Candle } from '../types/market';
import { formatPrice } from '../utils/format';
import { ChartStage } from '../components/chart/ChartStage';
import { DepthHistory } from '../components/orderFlow/depthHistory';
import { IbkrDepthPill } from '../components/orderFlow/IbkrSession';
import { Pill } from '../components/orderFlow/OrderFlowPanels';
import { TradeTape } from '../components/orderFlow/tradeDots';
import { analyzeMap, HEAT_STOPS, type StrongParams } from '../components/gcMap/liquidityMap';
import { DEFAULT_MAP_SETTINGS, isMapSettings, isMapTf, MAP_TFS, MIN_DEPTH_BUCKET_MS, TF_LABEL, TF_MS, type MapSettings, type MapTf } from '../components/gcMap/mapSettings';
import { fmtAge, fmtSize, LiquidityMapView, type DepthRow, type HoverInfo, type MapCandle, type MapFrame, type Viewport } from '../components/gcMap/LiquidityMapView';
import { ibkrBook } from '../providers/ibkr/IbkrDepthProvider';
import { useIbkrRootState } from '../providers/ibkr/ibkrView';
import '../components/sr/sr.css';
import '../components/orderFlow/orderFlow.css';
import '../components/gcMap/gcMap.css';

/* ============================================================================
 * GC Liquidity Map - a SEPARATE, read-only page: where real resting liquidity is NOW (live visible IBKR book) and
 * where it has been resting over time (the existing recorded IBKR depth history), over real Databento GC candles.
 * No collector, provider, recorder or market-data connection of its own; nothing here writes anywhere. Not S&R, not
 * a signal. Independently removable: this file, components/gcMap, one route, one nav item.
 * ========================================================================== */

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function GcLiquidityMapPage() {
  const def = useActiveInstrument();
  return (
    <div className="srapp ofapp gcmapapp">
      <MapWorkspace key={def.id} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>GC Liquidity Map</span>
          <span>IBKR visible price-level depth (not full COMEX book, not MBO) + Databento GC · observation only — no signals</span>
        </div>
      </footer>
    </div>
  );
}

function MapWorkspace() {
  const { market, orderFlow, instruments } = useServices();
  const def = useActiveInstrument();
  const isGc = def.id === 'GC';
  const tick = tickSizeOf(def);
  const d = def.pricePrecision;
  const st = useStore(orderFlow.store, (s) => s);
  const quote = useMarket((s) => s.quote);
  const ibkrState = useIbkrRootState('GC');
  const liveBook = useStore(ibkrBook, (s) => s.GC ?? null);
  const [tf, setTf] = usePersistentState<MapTf>('tluxe.gcmap.tf.v1', 'M15', isMapTf);
  const [s, setS] = usePersistentState<MapSettings>('tluxe.gcmap.settings.v1', { ...DEFAULT_MAP_SETTINGS }, isMapSettings);
  const patch = (p: Partial<MapSettings>) => setS({ ...s, ...p });
  const strong: StrongParams = useMemo(() => ({ minSize: s.minSize, minRelative: s.minRelative, minPersistMs: s.minPersistS * 1000, maxDistanceTicks: Math.round(s.maxDistance / tick) }), [s.minSize, s.minRelative, s.minPersistS, s.maxDistance, tick]);

  // Real Databento GC candles through the existing market-data service (no connection of our own).
  const [candleVer, setCandleVer] = useState(0);
  useEffect(() => (isGc ? market.subscribeCandles('GC', tf, () => setCandleVer((v) => v + 1)) : undefined), [market, isGc, tf]);
  const candles: MapCandle[] = useMemo(
    () => (isGc ? market.getCandles('GC', tf).map((c: Candle) => ({ t: c.time * 1000, ms: TF_MS[tf], o: c.open, h: c.high, l: c.low, c: c.close })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candleVer signals new candles
    [market, isGc, tf, candleVer],
  );

  // Recorded IBKR depth history (existing store + endpoint), bucket chosen from the viewport only.
  // Created inside the effect: a destroyed instance is never reused (StrictMode / HMR re-run the effect).
  const [history, setHistory] = useState<DepthHistory | null>(null);
  const [histVer, setHistVer] = useState(0);
  useEffect(() => {
    if (!isGc) return;
    const h = new DepthHistory('GC', tick, () => MIN_DEPTH_BUCKET_MS);
    setHistory(h);
    h.start();
    const t = setInterval(() => setHistVer(h.version), 1000);
    return () => {
      clearInterval(t);
      h.destroy();
      setHistory(null);
    };
  }, [isGc, tick]);

  // Real executed trades (existing order-flow recording) - only to tell TRADED from PULLED at a band end.
  const tapeRef = useRef(new TradeTape(tick));
  const prints = useMemo(() => {
    const msgs = orderFlow.recording();
    return tapeRef.current.sync({ msgs, count: msgs.length }).map((x) => ({ t: x.t, tick: x.tick, size: x.size }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on every engine version
  }, [orderFlow, st.version]);

  const cols = useMemo(() => (history ? history.columns : []), [history, histVer]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => (cols.length ? analyzeMap(cols, prints) : null), [cols, prints]);

  const book = useMemo(() => {
    if (!liveBook || ibkrState !== 'LIVE') return null;
    const rows = (r: { price: number; size: number }[]): DepthRow[] => r.filter((x) => x.size > 0).map((x) => ({ tick: Math.round(x.price / tick), size: x.size }));
    return { bids: rows(liveBook.bids), asks: rows(liveBook.asks) };
  }, [liveBook, ibkrState, tick]);
  const depthLive = !!book;
  const lastPriceTick = prints.length ? prints[prints.length - 1]!.tick : null;

  // Chart.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<LiquidityMapView | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const frameRef = useRef<MapFrame | null>(null);
  frameRef.current = { cols, result, candles, book, bookUpdateMs: liveBook?.lastUpdateMs ?? null, lastPriceTick, showCandles: s.candles, showHeat: s.heat, showDepth: s.depth, strongOnly: s.strongOnly, showLabels: s.labels, gain: s.gain, strong, depthLive, version: (frameRef.current?.version ?? 0) + 1 };
  const hasData = isGc && (candles.length > 0 || cols.length > 0);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasData || !history) return;
    const v = new LiquidityMapView(host, () => frameRef.current!, {
      tickSize: tick,
      decimals: d,
      onHover: setHover,
      onViewport: (vp: Viewport | null, plotPx: number) => vp && history.ensure(vp.t0, vp.t1, plotPx),
    });
    setView(v);
    return () => {
      v.destroy();
      setView(null);
    };
  }, [hasData, history, tick, d]);
  useEffect(() => {
    if (history && !view) history.ensure(Date.now() - 6 * 3600_000, Date.now(), 1200);
  }, [history, view]);

  // STRONG LIQUIDITY NOW: levels in the LIVE visible book whose recorded run qualifies (age = continuously observed).
  const strongNow = useMemo(() => {
    if (!book || !result || !cols.length) return { asks: [], bids: [] };
    const lastC = cols.length - 1;
    const age = new Map(result.cells.filter((c) => c.c === lastC).map((c) => [`${c.side}${c.tick}`, c.observedMs]));
    const best = book.bids.length && book.asks.length ? (Math.max(...book.bids.map((r) => r.tick)) + Math.min(...book.asks.map((r) => r.tick))) / 2 : null;
    const side = (rows: DepthRow[], sd: 'BID' | 'ASK') =>
      rows
        .map((r) => {
          const rel = r.size / Math.max(1e-9, median(rows.filter((x) => x !== r).map((x) => x.size)));
          return { tick: r.tick, size: r.size, relative: rel, observedMs: age.get(`${sd}${r.tick}`) ?? 0 };
        })
        .filter((x) => x.size >= strong.minSize && x.relative >= strong.minRelative && x.observedMs >= strong.minPersistMs && (best === null || Math.abs(x.tick - best) <= strong.maxDistanceTicks))
        .sort((a, b) => b.tick - a.tick);
    return { asks: side(book.asks, 'ASK'), bids: side(book.bids, 'BID') };
  }, [book, result, cols, strong]);
  const [nowOpen, setNowOpen] = useState(true);

  const last = lastPriceTick !== null ? lastPriceTick * tick : (quote.last ?? null);
  return (
    <main className="srmain gcmap" data-testid="gcmap">
      <div className="gcmap__bar">
        <div className="gcmap__brand">
          <span className="hlehead__icon" aria-hidden="true"><MapIcon size={18} /></span>
          <div>
            <h1 className="gcmap__title">GC Liquidity Map</h1>
            <p className="gcmap__sub">GC · COMEX Gold Futures{history?.contract ? ` · ${history.contract}` : ''}</p>
          </div>
        </div>
        <div className="ofbar__cell"><span>GC</span><strong className="num" data-testid="gcmap-last">{isGc && last !== null ? formatPrice(last, d) : '—'}</strong></div>
        <div className="ofbar__cell"><span>Bid</span><strong className="num">{book?.bids.length ? formatPrice(Math.max(...book.bids.map((r) => r.tick)) * tick, d) : '—'}</strong></div>
        <div className="ofbar__cell"><span>Ask</span><strong className="num">{book?.asks.length ? formatPrice(Math.min(...book.asks.map((r) => r.tick)) * tick, d) : '—'}</strong></div>
        <div className="gcmap__feeds">
          <Pill status={st.trade.status} label="DATABENTO" sep=" " />
          <IbkrDepthPill root="GC" />
          <span className="ofpill ofpill--muted" title="IBKR visible aggregated price-level depth - not the full COMEX book, not market-by-order">IBKR LEVEL-2 · PRICE LEVEL</span>
        </div>
      </div>

      {!isGc ? (
        <div className="panel ofwarn" role="status" data-testid="gcmap-not-gc">
          <strong>GC Liquidity Map shows GC — COMEX Gold Futures only.</strong> The active instrument is {def.shortName}.
          <button type="button" className="ofbtn" onClick={() => instruments.select('GC')}>Switch to GC</button>
        </div>
      ) : (
        <div className="gcmap__grid">
          <section className="panel gcmap__chart" aria-label="GC liquidity map chart">
            <div className="gcmap__toolbar">
              <div className="seg" role="tablist" aria-label="Candle timeframe">
                {MAP_TFS.map((x) => (
                  <button key={x} type="button" role="tab" className="seg__btn" aria-selected={x === tf} onClick={() => setTf(x)}>{TF_LABEL[x]}</button>
                ))}
              </div>
              <div className="gcmap__toggles" role="group" aria-label="Layers">
                <Check label="Candles" on={s.candles} set={(v) => patch({ candles: v })} />
                <Check label="Liquidity Heat" on={s.heat} set={(v) => patch({ heat: v })} />
                <Check label="Current Depth" on={s.depth} set={(v) => patch({ depth: v })} />
                <Check label="Strong Only" on={s.strongOnly} set={(v) => patch({ strongOnly: v })} />
                <Check label="Labels" on={s.labels} set={(v) => patch({ labels: v })} />
              </div>
              <button type="button" className="srtool srtool--icon" aria-label="Full screen" onClick={() => void hostRef.current?.parentElement?.parentElement?.requestFullscreen?.()}><Expand size={15} /></button>
            </div>
            {!depthLive && (
              <div className="gcmap__nodata" role="status" data-testid="gcmap-nodata">
                <strong>NO DEPTH DATA</strong> IBKR {ibkrState.replace(/_/g, ' ')}
                {history?.lastObservedMs ? ` · last recorded depth ${new Date(history.lastObservedMs).toISOString().replace('T', ' ').slice(0, 19)} UTC` : ''} — recorded history ends there; nothing is drawn through the gap.
              </div>
            )}
            <ChartStage containerRef={hostRef} controller={view} hasBars={hasData}>
              <div className="ofempty" data-testid="gcmap-empty">
                <strong>NO DATA</strong>
                <span>Waiting for Databento GC candles and recorded IBKR depth. Nothing is drawn until real data arrives.</span>
              </div>
            </ChartStage>
            {hover && (
              <div className="gcmap__tip" style={{ left: hover.x + 16, top: hover.y + 14 }} data-testid="gcmap-tip">
                <strong>GC {formatPrice(hover.cell.tick * tick, d)}</strong>
                <span>{hover.cell.side} DEPTH</span>
                <span>{new Date(hover.col.t).toISOString().replace('T', ' ').slice(0, 19)} UTC · bucket {hover.col.w >= 1000 ? `${hover.col.w / 1000} s` : `${hover.col.w} ms`}</span>
                <span>Displayed: {fmtSize(hover.cell.size)}{hover.col.w > 250 ? ' (time-weighted over the bucket)' : ''}</span>
                <span>Relative: {hover.cell.relative.toFixed(1)}× nearby</span>
                <span>Observed: {fmtAge(hover.cell.observedMs)}</span>
                {hover.cell.end && (
                  <span>
                    Band end: {hover.cell.end.replace(/_/g, ' ')}
                    {hover.cell.removedSize !== undefined ? ` · removed ${fmtSize(hover.cell.removedSize)}, executed at price ${fmtSize(hover.cell.endVolume ?? 0)}` : ''}
                  </span>
                )}
                <span>Source: IBKR Level-2 (recorded)</span>
              </div>
            )}
            <div className="gcmap__legend" aria-label="Intensity legend">
              <span>Low</span>
              <i style={{ background: `linear-gradient(90deg, ${HEAT_STOPS.map(([p, c]) => `rgb(${c.join(',')}) ${p * 100}%`).join(', ')})` }} />
              <span>High</span>
              <em>colour = displayed liquidity intensity (not buy / sell, not support / resistance)</em>
            </div>
          </section>

          <aside className="gcmap__side">
            <section className="panel gcmap__panel" aria-label="Strong liquidity now" data-testid="gcmap-now">
              <button type="button" className="gcmap__h" aria-expanded={nowOpen} onClick={() => setNowOpen((o) => !o)}>
                {nowOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} STRONG LIQUIDITY NOW
              </button>
              {nowOpen &&
                (!depthLive ? (
                  <p className="gcmap__muted">NO DEPTH DATA — no current levels.</p>
                ) : (
                  <>
                    <NowTable title="ASK" rows={strongNow.asks} tick={tick} d={d} />
                    <NowTable title="BID" rows={strongNow.bids} tick={tick} d={d} />
                  </>
                ))}
            </section>
            <section className="panel gcmap__panel" aria-label="Display settings" data-testid="gcmap-settings">
              <div className="gcmap__setsHead">
                <h2 className="gcmap__h2">Display Settings</h2>
                <button type="button" className="ofbtn" data-testid="gcmap-reset" onClick={() => setS({ ...DEFAULT_MAP_SETTINGS })}><RotateCcw size={12} /> Reset</button>
              </div>
              <Slider label="Intensity" min={0.4} max={2.5} step={0.05} v={s.gain} fmt={(v) => v.toFixed(2)} set={(v) => patch({ gain: v })} />
              <Slider label="Minimum Size" min={1} max={200} step={1} v={s.minSize} fmt={(v) => String(v)} set={(v) => patch({ minSize: v })} />
              <Slider label="Relative Strength" min={1} max={10} step={0.1} v={s.minRelative} fmt={(v) => `${v.toFixed(1)}×`} set={(v) => patch({ minRelative: v })} />
              <Slider label="Minimum Persistence" min={0} max={600} step={1} v={s.minPersistS} fmt={(v) => `${v}s`} set={(v) => patch({ minPersistS: v })} />
              <Slider label="Maximum Distance" min={0.5} max={50} step={0.5} v={s.maxDistance} fmt={(v) => `$${v.toFixed(1)}`} set={(v) => patch({ maxDistance: v })} />
              <p className="gcmap__muted">Thresholds select what is highlighted (Strong Only, labels, Strong Liquidity Now). They never change recorded depth.</p>
              <p className="gcmap__muted" data-testid="gcmap-limit">IBKR depth = the visible aggregated price-level book (top rows per side) — not the full COMEX book, not MBO. Liquidity outside it is unknown and never drawn.</p>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}

function NowTable({ title, rows, tick, d }: { title: 'ASK' | 'BID'; rows: { tick: number; size: number; relative: number; observedMs: number }[]; tick: number; d: number }) {
  return (
    <div className={`gcmap__tbl gcmap__tbl--${title.toLowerCase()}`}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="gcmap__muted">No visible level qualifies.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Price</th><th>Size</th><th>Relative</th><th>Age</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tick}>
                <td className="num">{formatPrice(r.tick * tick, d)}</td>
                <td className="num">{fmtSize(r.size)}</td>
                <td className="num">{r.relative.toFixed(1)}×</td>
                <td className="num">{fmtAge(r.observedMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Check({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="gcmap__check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Slider({ label, min, max, step, v, fmt, set }: { label: string; min: number; max: number; step: number; v: number; fmt: (v: number) => string; set: (v: number) => void }) {
  return (
    <label className="gcmap__slider">
      <span>{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} />
      <em className="num">{fmt(v)}</em>
    </label>
  );
}
