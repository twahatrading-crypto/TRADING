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
import { analyzeMap, type StrongParams } from '../components/gcMap/liquidityMap';
import { FINE_BUCKET_MS, FINE_STALE_MS, FineStrong, strongNowRows, type StrongInterval } from '../components/gcMap/fineStrong';
import { DEFAULT_MAP_SETTINGS, isMapSettings, isMapTf, MAP_TFS, MIN_DEPTH_BUCKET_MS, TF_LABEL, TF_MS, type MapSettings, type MapTf } from '../components/gcMap/mapSettings';
import { fmtAge, fmtSize, LiquidityMapView, PALETTE, PALETTE_MAX, SCALE_NAMES, type DepthRow, type HoverInfo, type MapCandle, type MapFrame, type StrongNowRow, type ViewRange, type Viewport } from '../components/gcMap/LiquidityMapView';
import { latestSession, MAP_RANGES, RANGE_LABEL, RANGE_MS, SESSION_BREAK_MS, SESSION_LOOKBACK_MS, type MapRange, type SessionInfo } from '../components/gcMap/viewRange';
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

const EMPTY_IV: StrongInterval[] = [];

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

  // STRONG persistence source: the same recorded-depth store / endpoint, fixed at the finest recorded bucket (250 ms)
  // and never tied to the chart - so the chart's bucket, timeframe, zoom or window cannot change Strong results.
  const [fine, setFine] = useState<DepthHistory | null>(null);
  const [fineVer, setFineVer] = useState(0);
  useEffect(() => {
    if (!isGc) return;
    const h = new DepthHistory('GC', tick, () => FINE_BUCKET_MS);
    setFine(h);
    h.start();
    h.ensure(Date.now() - 12 * 60_000, Date.now(), 100_000); // 15 min of 250 ms buckets (server limit 3900 columns)
    const t = setInterval(() => setFineVer(h.version), 1000);
    return () => {
      clearInterval(t);
      h.destroy();
      setFine(null);
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

  // Visible time window (VIEW ONLY). LIVE SESSION starts where the current continuous recorded-depth session starts:
  // first read from the last 24 h of recorded coverage, then kept current from whatever the page has loaded (a new
  // session - a hole >= SESSION_BREAK_MS followed by depth again - moves it). Nothing is deleted or filled.
  const [range, setRange] = useState<MapRange>('LIVE');
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const probeFrom = useRef(0);
  useEffect(() => {
    if (!history) return;
    probeFrom.current = Date.now() - SESSION_LOOKBACK_MS;
    history.ensure(probeFrom.current, Date.now(), 1200);
    const t = setTimeout(() => setSession((x) => (x === undefined ? null : x)), 12_000); // no answer: no session known
    return () => clearTimeout(t);
  }, [history]);
  useEffect(() => {
    if (!history) return;
    if (session === undefined) {
      if (history.error) return setSession(null);
      if (history.version < 2) return; // the 24 h coverage has not arrived yet
      const s = latestSession(history.columns);
      // Recording continuous since before the look-back: the session start is the look-back itself (LIVE = 24 h max).
      return setSession(s && s.prevEnd === null && s.start - probeFrom.current < SESSION_BREAK_MS ? { ...s, start: probeFrom.current } : s);
    }
    const s = latestSession(cols);
    // A break inside what is loaded = a newer session (only then is the start known from these columns).
    if (s && s.prevEnd !== null && (!session || s.start > session.start)) setSession(s);
    else if (!session && s) setSession(s);
  }, [history, histVer, cols, session]);
  const viewRange: ViewRange | null = useMemo(() => {
    if (session === undefined) return null;
    if (range !== 'LIVE') return { kind: 'span', ms: RANGE_MS[range] };
    return session ? { kind: 'session', start: session.start } : { kind: 'span', ms: RANGE_MS['1H'] };
  }, [range, session]);

  const book = useMemo(() => {
    if (!liveBook || ibkrState !== 'LIVE') return null;
    const rows = (r: { price: number; size: number }[]): DepthRow[] => r.filter((x) => x.size > 0).map((x) => ({ tick: Math.round(x.price / tick), size: x.size }));
    return { bids: rows(liveBook.bids), asks: rows(liveBook.asks) };
  }, [liveBook, ibkrState, tick]);
  const depthLive = !!book;
  const lastPriceTick = prints.length ? prints[prints.length - 1]!.tick : null;

  // 250 ms Strong state (persistence, age, run start / end, qualification time) - window-independent.
  const trackerRef = useRef<FineStrong | null>(null);
  const fineState = useMemo(() => {
    if (!fine || !fine.columns.length) return null;
    if (!trackerRef.current) trackerRef.current = new FineStrong();
    const tr = trackerRef.current;
    const keep = tr.update(fine.columns, strong);
    if (keep !== null && fine.columns.length && fine.columns[0]!.t < keep) fine.columns = fine.columns.filter((c) => c.t >= keep); // memory only
    return { levels: tr.levels, intervals: tr.intervals(), since: tr.since, lastEnd: tr.lastEnd };
  }, [fine, fineVer, strong]); // eslint-disable-line react-hooks/exhaustive-deps -- fineVer signals new 250 ms columns
  const fineCurrent = !!fineState && fineState.lastEnd !== null && Date.now() - fineState.lastEnd <= FINE_STALE_MS;

  // STRONG LIQUIDITY NOW: levels in the LIVE visible book (size / relative / distance from the book, as before) whose
  // continuous persistence - measured ONLY on the 250 ms recorded series - meets the threshold.
  const strongNow = useMemo(
    () => (book && fineState && fineCurrent ? strongNowRows(book, fineState.levels, strong) : { asks: [] as StrongNowRow[], bids: [] as StrongNowRow[] }),
    [book, fineState, fineCurrent, strong],
  );
  // Chart.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<LiquidityMapView | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const frameRef = useRef<MapFrame | null>(null);
  // A new chart bucket starts empty until its first answer: that is LOADING, never "no depth data".
  const bucketSeen = useRef<{ b: number; v: number }>({ b: -1, v: -1 });
  if (history && history.bucketMs !== bucketSeen.current.b) bucketSeen.current = { b: history.bucketMs, v: history.version };
  const chartLoading = !!history && !history.error && history.columns.length === 0 && history.version === bucketSeen.current.v;
  frameRef.current = { loading: chartLoading, cols, result, candles, book, bookUpdateMs: liveBook?.lastUpdateMs ?? null, lastPriceTick, showCandles: s.candles, showHeat: s.heat, showDepth: s.depth, strongOnly: s.strongOnly, showLabels: s.labels, gain: s.gain, strong, depthLive, strongNow: [...strongNow.asks, ...strongNow.bids], strongIntervals: fineState?.intervals ?? EMPTY_IV, version: (frameRef.current?.version ?? 0) + 1 };
  const hasData = isGc && (candles.length > 0 || cols.length > 0) && viewRange !== null;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasData || !history) return;
    const v = new LiquidityMapView(host, () => frameRef.current!, {
      tickSize: tick,
      decimals: d,
      onHover: setHover,
      onReset: () => setRange('LIVE'),
      onViewport: (vp: Viewport | null, plotPx: number) => vp && history.ensure(vp.t0, vp.t1, plotPx),
    });
    setView(v);
    return () => {
      v.destroy();
      setView(null);
    };
  }, [hasData, history, tick, d]);
  // The chosen window: a click applies it; a session update only moves the LIVE anchor (user zoom / pan kept).
  const applied = useRef<{ view: LiquidityMapView | null; range: MapRange | null }>({ view: null, range: null });
  useEffect(() => {
    if (!view || !viewRange) return;
    const a = applied.current;
    view.setRange(viewRange, a.view !== view || a.range !== range);
    applied.current = { view, range };
  }, [view, viewRange, range]);
  // A window whose recorded depth never arrived (a resolution change while a load was in flight) is asked for again,
  // at most every 5 s - the same request the view makes, through the same store; nothing else is fetched.
  const kicked = useRef(0);
  useEffect(() => {
    if (!view || !history || history.columns.length || Date.now() - kicked.current < 5000) return;
    kicked.current = Date.now();
    view.reportViewport();
  }, [view, history, histVer]);
  const utc = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

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
              <div className="seg gcmap__range" role="tablist" aria-label="History window" data-testid="gcmap-range">
                {MAP_RANGES.map((x) => (
                  <button key={x} type="button" role="tab" className="seg__btn" aria-selected={x === range} onClick={() => setRange(x)}>{RANGE_LABEL[x]}</button>
                ))}
              </div>
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
            {isGc && session !== undefined && (
              <div className="gcmap__window" data-testid="gcmap-window">
                {range === 'LIVE' ? (
                  session ? (
                    <>
                      <strong>LIVE SESSION</strong> continuous recorded depth since {utc(session.start)} UTC
                      {session.prevEnd !== null ? ` · previous recording ended ${utc(session.prevEnd)} UTC (DEPTH GAP before it - choose a longer window to see it)` : ' · no earlier recorded depth in the last 24 h (choose 24H to see the gap)'}
                    </>
                  ) : (
                    <><strong>LIVE SESSION</strong> no recorded depth session found in the last 24 h — showing the last hour</>
                  )
                ) : (
                  <><strong>{RANGE_LABEL[range]}</strong> last {RANGE_LABEL[range].toLowerCase()} · time without recorded depth is hatched DEPTH GAP, never filled</>
                )}
                {s.strongOnly && fineState?.since ? ` · Strong Only: qualified from 250 ms recorded depth (available since ${utc(fineState.since)} UTC)` : ''}
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
              <span>Weak</span>
              <i style={{ background: `linear-gradient(90deg, ${PALETTE.map(([p, c]) => `rgb(${c.join(',')}) ${((p / PALETTE_MAX) * 100).toFixed(1)}%`).join(', ')})` }} />
              <span>Exceptional</span>
              <span className="gcmap__scale">{SCALE_NAMES.map(([n]) => n).join(' · ')}</span>
              <em>colour = displayed liquidity intensity (not buy / sell, not support / resistance)</em>
            </div>
          </section>

          <aside className="gcmap__side">
            <section className="panel gcmap__panel" aria-label="Strong liquidity now" data-testid="gcmap-now" data-rows={JSON.stringify([...strongNow.asks, ...strongNow.bids].map((r) => ({ side: r.side, price: Number((r.tick * tick).toFixed(d)), size: r.size, relative: Number(r.relative.toFixed(3)), ageMs: r.observedMs, ageLowerBound: r.lowerBound, runStart: r.runStart, qualifiedAt: r.qualifiedAt })))} data-fine-levels={JSON.stringify(fineState ? [...fineState.levels.values()].map((l) => ({ side: l.side, price: Number((l.tick * tick).toFixed(d)), size: Number(l.size.toFixed(2)), ageMs: l.observedMs, runStart: l.runStart, qualifiedAt: l.qualifiedAt })) : [])} data-fine-since={fineState?.since ?? ''} data-fine-last={fineState?.lastEnd ?? ''}>
              <button type="button" className="gcmap__h" aria-expanded={nowOpen} onClick={() => setNowOpen((o) => !o)}>
                {nowOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} STRONG LIQUIDITY NOW
              </button>
              {nowOpen &&
                (!depthLive ? (
                  <p className="gcmap__muted">NO DEPTH DATA — no current levels.</p>
                ) : !fineCurrent ? (
                  <p className="gcmap__muted" data-testid="gcmap-fine-stale">250 ms RECORDED DEPTH NOT CURRENT — persistence cannot be measured, no level is shown.</p>
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

function NowTable({ title, rows, tick, d }: { title: 'ASK' | 'BID'; rows: StrongNowRow[]; tick: number; d: number }) {
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
                <td className="num" title={`Continuous at 250 ms since ${r.runStart ? new Date(r.runStart).toISOString().slice(11, 23) : '—'} UTC${r.qualifiedAt ? ` · qualified ${new Date(r.qualifiedAt).toISOString().slice(11, 23)} UTC` : ''}${r.lowerBound ? ' · started before the loaded 250 ms history' : ''}`}>{r.lowerBound ? '≥' : ''}{fmtAge(r.observedMs)}</td>
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
