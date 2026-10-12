import { Crosshair, Eraser, Home, LayoutGrid, Maximize2, Minimize2, Minus, MousePointer2, Pause, Play, Radio, RotateCcw, Settings2, Square, TrendingUp, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ChartStage } from '../components/chart/ChartStage';
import { MiniSeries, DepthHeatmap } from '../components/orderFlowPro/OfpCanvases';
import { DEFAULT_LAYERS, OfpChartView, type BubbleDensity, type ChartFrame, type DrawTool, type Drawing, type HoverInfo, type LayerFlags } from '../components/orderFlowPro/OfpChartView';
import { AbsorptionTable, AlertsList, DiagnosticsPanel, LiquidityStrength, OrderBookPanel, ReversalTable, SessionStatsPanel, SessionVpPanel, StrongTable, TradesTable } from '../components/orderFlowPro/OfpPanels';
import { OfpSplitter } from '../components/orderFlowPro/OfpSplitter';
import { feedLabel, fmtExpiry, fmtNum, fmtSigned, fmtUtcTime, HEAT_LEGEND, scheduleLabel } from '../components/orderFlowPro/ofpFormat';
import { INTENSITY_SCALES, isOfpRoot, isOfpSession, isOfpTf, OFP_PRECISION, OFP_ROOTS, OFP_SESSIONS, OFP_TFS, type IntensityScale, type OfpSession } from '../engines/orderFlowPro/config';
import { isLiveFeed } from '../engines/orderFlowPro/engine';
import { globexSchedule } from '../engines/orderFlowPro/nyTime';
import type { OfpRoot, OfpTf } from '../engines/orderFlowPro/types';
import { usePersistentState } from '../hooks/usePersistentState';
import { ofpController } from '../providers/orderFlowPro/controller';
import '../components/chart/chart.css';
import '../components/orderFlowPro/ofp.css';

/* ============================================================================
 * TLUXE ORDER FLOW PRO - a SEPARATE, independent research page for COMEX GC / SI futures.
 * Data: the local Order Flow Pro backend (IBKR TWS API, read-only) only. No other TLUXE provider, engine or store is
 * read or written. No orders, no trade instructions. Independently removable: this file, components/orderFlowPro,
 * engines/orderFlowPro, providers/orderFlowPro, one route, one nav item.
 *
 * Workspace mode (default): the page covers the viewport (position: fixed, its own stacking context) so chart,
 * four analytics panels and the bottom tables fit one screen without page scrolling; panes resize via splitters,
 * panels scroll internally. "Exit full screen" returns to the standard app shell.
 * ========================================================================== */

const TABS = ['Trades (Footprint)', 'Alerts', 'Reversal Detector', 'Strong Liquidity', 'Absorptions', 'Session Stats', 'Diagnostics'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: unknown): v is Tab => typeof v === 'string' && (TABS as readonly string[]).includes(v);
const isLayers = (v: unknown): v is LayerFlags => !!v && typeof v === 'object' && Object.keys(DEFAULT_LAYERS).every((k) => typeof (v as Record<string, unknown>)[k] === 'boolean');
const isScale = (v: unknown): v is IntensityScale => typeof v === 'string' && (INTENSITY_SCALES as readonly string[]).includes(v);
const isGain = (v: unknown): v is number => typeof v === 'number' && v >= 0.25 && v <= 4;
const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0.2 && v <= 1;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isDensity = (v: unknown): v is BubbleDensity => v === 'low' || v === 'medium' || v === 'high';
type Layout = 'full' | 'chart';
const isLayout = (v: unknown): v is Layout => v === 'full' || v === 'chart';
type SideTab = 'strength' | 'depth';
const isSideTab = (v: unknown): v is SideTab => v === 'strength' || v === 'depth';
interface Panes {
  side: number;
  metrics: number;
  bottom: number;
}
const DEFAULT_PANES: Panes = { side: 470, metrics: 104, bottom: 232 };
const PANE_LIMITS: Record<keyof Panes, [number, number]> = { side: [300, 640], metrics: [72, 220], bottom: [150, 460] };
const isPanes = (v: unknown): v is Panes => !!v && typeof v === 'object' && (['side', 'metrics', 'bottom'] as const).every((k) => typeof (v as Record<string, unknown>)[k] === 'number');
const clampPane = (k: keyof Panes, v: number) => Math.round(Math.min(PANE_LIMITS[k][1], Math.max(PANE_LIMITS[k][0], v)));

const LAYER_LABEL: Array<[keyof LayerFlags, string]> = [
  ['heatmap', 'Heatmap'],
  ['footprint', 'Footprint'],
  ['bubbles', 'Bubbles'],
  ['profile', 'Volume Profile'],
  ['levels', 'POC/VAH/VAL'],
  ['orderBook', 'Order Book'],
  ['strong', 'Strong Liquidity'],
  ['reversals', 'Reversals'],
];

const REPLAY_SPANS = [15, 30, 60, 120] as const;
const REPLAY_SPEEDS = [1, 5, 10, 30, 60] as const;

export function OrderFlowProPage() {
  const ctl = ofpController();
  useSyncExternalStore(
    useCallback((l: () => void) => ctl.subscribe(l), [ctl]),
    () => ctl.tick,
  );
  const demo = ctl.source.info.demo;

  const [root, setRoot] = usePersistentState<OfpRoot>('tluxe.ofp.root.v1', 'GC', isOfpRoot);
  const [tf, setTf] = usePersistentState<OfpTf>('tluxe.ofp.tf.v1', '1m', isOfpTf);
  const [session, setSession] = usePersistentState<OfpSession>('tluxe.ofp.session.v1', 'ETH', isOfpSession);
  const [layers, setLayers] = usePersistentState<LayerFlags>('tluxe.ofp.layers.v1', { ...DEFAULT_LAYERS }, isLayers);
  const [scale, setScale] = usePersistentState<IntensityScale>('tluxe.ofp.heatScale.v1', 'sqrt', isScale);
  const [gain, setGain] = usePersistentState<number>('tluxe.ofp.heatGain.v1', 1, isGain);
  const [heatOpacity, setHeatOpacity] = usePersistentState<number>('tluxe.ofp.heatOpacity.v1', 0.8, isUnit);
  const [bubbleOpacity, setBubbleOpacity] = usePersistentState<number>('tluxe.ofp.bubbleOpacity.v1', 0.75, isUnit);
  const [bubbleDensity, setBubbleDensity] = usePersistentState<BubbleDensity>('tluxe.ofp.bubbleDensity.v1', 'medium', isDensity);
  const [tab, setTab] = usePersistentState<Tab>('tluxe.ofp.tab.v1', 'Trades (Footprint)', isTab);
  const [sideTab, setSideTab] = usePersistentState<SideTab>('tluxe.ofp.sideTab.v1', 'strength', isSideTab);
  const [layout, setLayout] = usePersistentState<Layout>('tluxe.ofp.layout.v1', 'full', isLayout);
  const [workspace, setWorkspace] = usePersistentState<boolean>('tluxe.ofp.workspace.v1', true, isBool);
  const [panes, setPanes] = usePersistentState<Panes>('tluxe.ofp.panes.v1', { ...DEFAULT_PANES }, isPanes);
  const [livePanes, setLivePanes] = useState<Panes | null>(null);
  const dragBase = useRef<Panes>(panes);
  const [tool, setTool] = useState<DrawTool>('cursor');
  const [drawings, setDrawings] = useState<Record<OfpRoot, Drawing[]>>({ GC: [], SI: [] });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replaySpan, setReplaySpan] = useState<number>(60);
  const [replayErr, setReplayErr] = useState<string | null>(null);
  const [, setLinkVer] = useState(0);

  // One ref-counted subscription per root (StrictMode / HMR safe; the controller lives outside React).
  useEffect(() => ctl.acquire(root), [ctl, root]);

  const replay = ctl.replay?.root === root ? ctl.replay : null;
  const engine = replay ? replay.engine : ctl.engines[root];
  const view = engine.view(tf, session);
  const st = view.status;
  const precision = OFP_PRECISION[root];
  const fl = feedLabel(st);
  const live = isLiveFeed(st);
  const now = engine.now || view.status.lastEventMs || 0;
  const sched = scheduleLabel(globexSchedule(now || Date.now()));
  const pane = livePanes ?? panes;

  const frameRef = useRef<ChartFrame | null>(null);
  frameRef.current = { view, precision, layers, scale, gain, drawings: drawings[root], tool, demo, replay: !!replay, now, heatOpacity, bubbleOpacity, bubbleDensity };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [chart, setChart] = useState<OfpChartView | null>(null);
  const hasBars = view.bars.length > 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasBars) return;
    const v = new OfpChartView(host, () => frameRef.current, {
      onHover: (h) =>
        setHover((prev) => (prev?.t === h?.t && prev?.price === h?.price && prev?.bar === h?.bar && prev?.resting?.size === h?.resting?.size ? prev : h)),
      onDrawing: (d) => setDrawings((prev) => ({ ...prev, [frameRef.current!.view.root]: [...prev[frameRef.current!.view.root], d] })),
    });
    setChart(v);
    return () => {
      v.destroy();
      setChart(null);
    };
  }, [hasBars, root]);

  useEffect(() => {
    chart?.invalidate();
  }, [chart, view, layers, scale, gain, heatOpacity, bubbleOpacity, bubbleDensity, drawings, tool, layout, workspace, pane]);

  const liveRef = useRef<Panes | null>(null);
  const resize = (k: keyof Panes, sign: 1 | -1) => (delta: number, start: boolean) => {
    if (start) dragBase.current = panes;
    liveRef.current = { ...dragBase.current, [k]: clampPane(k, dragBase.current[k] + sign * delta) };
    setLivePanes(liveRef.current);
  };
  const commitPanes = () => {
    if (liveRef.current) setPanes(liveRef.current);
    liveRef.current = null;
    setLivePanes(null);
  };

  const sessionOpen = useMemo(() => {
    const b = view.bars.find((x) => x.t >= view.stats.window.start);
    return b?.o ?? null;
  }, [view.bars, view.stats.window.start]);
  const change = view.last !== null && sessionOpen !== null ? view.last - sessionOpen : null;

  const contracts = st.availableContracts ?? (st.contract ? [st.contract] : []);
  const lastCvd = view.cvd[view.cvd.length - 1];
  const lastDelta = view.delta[view.delta.length - 1];
  const lastOfi = view.ofi[view.ofi.length - 1];
  const lastBar = view.bars[view.bars.length - 1];

  const startReplay = async () => {
    setReplayErr(null);
    try {
      const to = engine.now || Date.now();
      await ctl.startReplay(root, to - replaySpan * 60_000, to, 10);
    } catch (e) {
      setReplayErr(demo ? `Replay failed: ${e instanceof Error ? e.message : 'error'}` : 'Replay reads the backend recording database - backend offline or no recording for this range.');
    }
  };

  const full = layout === 'full';
  const style = { '--ofp-side-w': `${pane.side}px`, '--ofp-metrics-h': `${pane.metrics}px`, '--ofp-bottom-h': `${pane.bottom}px` } as CSSProperties;

  return (
    <div className={`ofp ofp--${layout}${workspace ? ' ofp--ws' : ''}`} style={style} data-testid="ofp-page">
      {demo && (
        <div className="ofp-banner ofp-banner--demo" role="status">
          DEMO FIXTURE — synthetic events for visual testing only · NOT MARKET DATA · NEVER LIVE
        </div>
      )}
      {replay && (
        <div className="ofp-banner ofp-banner--replay" role="status">
          REPLAY · {fmtUtcTime(replay.cursor)} UTC · recorded data, not live
        </div>
      )}

      {/* ---------------- top bar ---------------- */}
      <header className="ofp-top">
        {workspace && (
          <a className="ofp-btn ofp-btn--icon" href="#/" aria-label="TLUXE dashboard" title="TLUXE dashboard">
            <Home size={15} />
          </a>
        )}
        <div className="ofp-brand">
          <h1>Order Flow Pro</h1>
          <span>COMEX futures · IBKR · research only</span>
        </div>
        <div className="ofp-group" role="group" aria-label="Symbol">
          {OFP_ROOTS.map((r) => (
            <button key={r} type="button" className={`ofp-chip ${r === root ? 'is-on' : ''}`} aria-pressed={r === root} onClick={() => (ctl.stopReplay(), setRoot(r))}>
              {r}
              <small>{r === 'GC' ? 'COMEX Gold' : 'COMEX Silver'}</small>
            </button>
          ))}
        </div>
        <label className="ofp-group">
          <span className="ofp-lbl">Contract</span>
          <select
            aria-label="Contract expiry"
            value={st.contract?.localSymbol ?? ''}
            disabled={!contracts.length || !ctl.source.selectContract}
            onChange={(e) => void ctl.source.selectContract?.(root, e.target.value)}
          >
            {!contracts.length && <option value="">No verified contract</option>}
            {contracts.map((c) => (
              <option key={c.localSymbol} value={c.localSymbol}>
                {c.localSymbol} · exp {fmtExpiry(c.expiry)}
              </option>
            ))}
          </select>
        </label>
        <div className="ofp-group" role="group" aria-label="Timeframe">
          {OFP_TFS.map((t) => (
            <button key={t} type="button" className={`ofp-chip ofp-chip--tf ${t === tf ? 'is-on' : ''}`} aria-pressed={t === tf} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
        </div>
        <label className="ofp-group">
          <span className="ofp-lbl">Session</span>
          <select aria-label="Session" value={session} onChange={(e) => isOfpSession(e.target.value) && setSession(e.target.value)}>
            {OFP_SESSIONS.map((s) => (
              <option key={s} value={s}>
                {s === 'ETH' ? 'ETH (18:00–17:00 ET)' : 'RTH (08:20–13:30 ET)'}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={`ofp-btn ${replayOpen ? 'is-on' : ''}`} aria-pressed={replayOpen} onClick={() => setReplayOpen(!replayOpen)}>
          <RotateCcw size={14} /> Replay
        </button>
        <button type="button" className="ofp-btn" onClick={() => setLayout(full ? 'chart' : 'full')} title="Toggle panels">
          <LayoutGrid size={14} /> {full ? 'All panels' : 'Chart focus'}
        </button>
        <button type="button" className={`ofp-btn ofp-btn--icon ${showSettings ? 'is-on' : ''}`} aria-label="Display settings" aria-pressed={showSettings} onClick={() => setShowSettings(!showSettings)}>
          <Settings2 size={15} />
        </button>
        <button type="button" className="ofp-btn" onClick={() => setWorkspace(!workspace)} aria-pressed={workspace} title={workspace ? 'Back to the standard TLUXE layout' : 'Full-screen trading workspace'}>
          {workspace ? <Minimize2 size={14} /> : <Maximize2 size={14} />} {workspace ? 'Exit full screen' : 'Full screen'}
        </button>
        <div className="ofp-feed">
          <span className={`ofp-pill ofp-pill--${fl.tone}`} title={fl.detail} data-testid="ofp-feed">
            <Radio size={12} /> {fl.text}
          </span>
          <div className="ofp-cell">
            <span>Latency</span>
            <b>{live && st.latencyMs !== null ? `${Math.round(st.latencyMs)} ms` : '—'}</b>
          </div>
          <div className="ofp-cell">
            <span>Last update</span>
            <b>{st.lastEventMs ? `${fmtUtcTime(st.lastEventMs)} UTC` : '—'}</b>
          </div>
        </div>
      </header>

      {showSettings && (
        <div className="ofp-settings" role="dialog" aria-label="Display settings">
          <label>
            Heat scale
            <select value={scale} onChange={(e) => isScale(e.target.value) && setScale(e.target.value)}>
              {INTENSITY_SCALES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Heat gain {gain.toFixed(2)}×
            <input type="range" min={0.25} max={4} step={0.25} value={gain} onChange={(e) => setGain(Number(e.target.value))} />
          </label>
          <label>
            Heat opacity {Math.round(heatOpacity * 100)}%
            <input type="range" min={0.2} max={1} step={0.05} value={heatOpacity} onChange={(e) => setHeatOpacity(Number(e.target.value))} aria-label="Heatmap opacity" />
          </label>
          <label>
            Bubble opacity {Math.round(bubbleOpacity * 100)}%
            <input type="range" min={0.2} max={1} step={0.05} value={bubbleOpacity} onChange={(e) => setBubbleOpacity(Number(e.target.value))} aria-label="Bubble opacity" />
          </label>
          <label>
            Bubble density
            <select value={bubbleDensity} onChange={(e) => isDensity(e.target.value) && setBubbleDensity(e.target.value)} aria-label="Bubble density">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <span className="ofp-legend">
            low <i style={{ background: `linear-gradient(90deg, ${HEAT_LEGEND})` }} /> high
          </span>
          <button type="button" className="ofp-btn ofp-btn--ghost" onClick={() => setPanes({ ...DEFAULT_PANES })}>
            Reset pane sizes
          </button>
        </div>
      )}

      {replayOpen && (
        <div className="ofp-replay" role="group" aria-label="Replay">
          <span className="ofp-lbl">Replay last</span>
          <select value={replaySpan} onChange={(e) => setReplaySpan(Number(e.target.value))} aria-label="Replay span">
            {REPLAY_SPANS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          {!replay ? (
            <button type="button" className="ofp-btn" onClick={() => void startReplay()}>
              <Play size={13} /> Start
            </button>
          ) : (
            <>
              <button type="button" className="ofp-btn" onClick={() => ctl.setReplayPlaying(!replay.playing)}>
                {replay.playing ? <Pause size={13} /> : <Play size={13} />} {replay.playing ? 'Pause' : 'Play'}
              </button>
              <select value={replay.speed} onChange={(e) => ctl.setReplaySpeed(Number(e.target.value))} aria-label="Replay speed">
                {REPLAY_SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              <progress max={replay.to - replay.from} value={replay.cursor - replay.from} />
              <button type="button" className="ofp-btn" onClick={() => ctl.stopReplay()}>
                <Square size={12} /> Exit replay
              </button>
            </>
          )}
          {replayErr && <span className="ask">{replayErr}</span>}
        </div>
      )}

      {/* ---------------- quote strip ---------------- */}
      <section className="ofp-quote" aria-label="Quote">
        <div className={`ofp-last ${change !== null && change < 0 ? 'ask' : 'bid'}`}>
          {view.last !== null ? view.last.toFixed(precision) : '—'}
          {change !== null && sessionOpen && (
            <small>
              {change >= 0 ? '+' : ''}
              {change.toFixed(precision)} ({((change / sessionOpen) * 100).toFixed(2)}%)
            </small>
          )}
        </div>
        <div className="ofp-q">
          <span>Bid</span>
          <b className="bid">{view.quote?.bid?.toFixed(precision) ?? '—'}</b>
          <em>× {view.quote?.bidSize ?? '—'}</em>
        </div>
        <div className="ofp-q">
          <span>Ask</span>
          <b className="ask">{view.quote?.ask?.toFixed(precision) ?? '—'}</b>
          <em>× {view.quote?.askSize ?? '—'}</em>
        </div>
        <div className="ofp-q">
          <span>Contract</span>
          <b>{st.contract ? `${st.contract.localSymbol}` : '—'}</b>
          <em>{st.contract ? `exp ${fmtExpiry(st.contract.expiry)}${st.contract.verified ? '' : ' · unverified'}` : 'not resolved'}</em>
        </div>
        <div className="ofp-q">
          <span>Provider</span>
          <b>{demo ? 'DEMO fixture' : 'IBKR (read-only)'}</b>
          <em>{st.marketDataType ? `market data: ${st.marketDataType}` : 'market data type: —'}</em>
        </div>
        <div className="ofp-q" data-testid="ofp-schedule" title="CME Globex weekly schedule only. Exchange holidays, early closes and halts are not verified - this is not an exchange 'market open' status.">
          <span>Session</span>
          <b>{session}</b>
          <em>
            {fmtUtcTime(view.stats.window.start).slice(0, 5)}–{fmtUtcTime(view.stats.window.end).slice(0, 5)} UTC · <span className={`tone-${sched.tone}`}>{sched.text}</span> (schedule only, not exchange status)
          </em>
        </div>
      </section>

      {/* ---------------- main ---------------- */}
      <div className="ofp-main">
        <nav className="ofp-tools" aria-label="Chart tools">
          {(
            [
              ['cursor', MousePointer2, 'Cursor / pan'],
              ['hline', Minus, 'Horizontal line'],
              ['trend', TrendingUp, 'Trend line'],
            ] as const
          ).map(([id, Icon, label]) => (
            <button key={id} type="button" className={tool === id ? 'is-on' : ''} aria-pressed={tool === id} aria-label={label} title={label} onClick={() => setTool(id)}>
              <Icon size={17} />
            </button>
          ))}
          <button type="button" aria-label="Clear drawings" title="Clear drawings" onClick={() => setDrawings({ ...drawings, [root]: [] })}>
            <Eraser size={17} />
          </button>
          <hr />
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => chart?.zoomIn()}>
            <ZoomIn size={17} />
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => chart?.zoomOut()}>
            <ZoomOut size={17} />
          </button>
          <button type="button" aria-label="Fit" title="Fit all bars" onClick={() => chart?.fitView()}>
            <Crosshair size={17} />
          </button>
        </nav>

        <section className="ofp-chart" aria-label="Order flow chart">
          <div className="ofp-chart__head">
            <span className="ofp-chart__sym">
              {st.contract?.localSymbol ?? root} · {tf} · COMEX <i className={`ofp-dot ofp-dot--${fl.tone}`} title={fl.text} />
            </span>
            <div className="ofp-layers" role="group" aria-label="Chart layers">
              {LAYER_LABEL.map(([k, label]) => (
                <label key={k} className="ofp-check">
                  <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {label}
                </label>
              ))}
            </div>
          </div>
          <div className="ofp-hover" aria-live="off">
            {hover ? (
              <>
                <b>{hover.price.toFixed(precision)}</b> · {fmtUtcTime(hover.t).slice(0, 5)} UTC
                {hover.bar && (
                  <>
                    {' '}
                    · O {hover.bar.o.toFixed(precision)} H {hover.bar.h.toFixed(precision)} L {hover.bar.l.toFixed(precision)} C {hover.bar.c.toFixed(precision)} · vol {fmtNum(hover.bar.volume)}
                    {hover.bar.delta !== null ? ` · Δ ${fmtSigned(hover.bar.delta)}` : ' · Δ n/a (no prints)'}
                  </>
                )}
                {hover.level && (
                  <>
                    {' '}
                    · at price: <span className="bid">buy {hover.level.buy}</span> / <span className="ask">sell {hover.level.sell}</span>
                    {hover.level.unknown ? ` / unknown ${hover.level.unknown}` : ''}
                  </>
                )}
                {hover.resting && ` · resting ${hover.resting.side.toLowerCase()} ${hover.resting.size}`}
              </>
            ) : (
              <span className="dim">
                Wheel = zoom · drag = pan · Shift+wheel = price zoom · double-click = reset · bands = observed strong resting liquidity (cyan → green → yellow → white) · bubbles = executed prints
              </span>
            )}
          </div>
          <div className="ofp-stage">
            <ChartStage containerRef={hostRef} controller={chart} hasBars={hasBars}>
              <div className="ofp-nodata" data-testid="ofp-nodata">
                <b className={`tone-${fl.tone}`}>{fl.text}</b>
                <span>{fl.detail}</span>
                {st.diagnostics.slice(0, 3).map((d) => (
                  <span key={d} className="dim">
                    {d}
                  </span>
                ))}
                <span className="dim">No candles are drawn until real trade prints or IBKR historical bars arrive. Nothing is simulated.</span>
              </div>
            </ChartStage>
          </div>
        </section>

        {full && (
          <>
            <OfpSplitter dir="col" label="Resize order book column" onDrag={resize('side', -1)} onEnd={commitPanes} />
            <aside className="ofp-side">
              <section className="ofp-panel ofp-panel--book">
                <header>
                  <h2>Order Book (IBKR)</h2>
                  <span className="ofp-tag" title="Rows granted by IBKR (price levels, not full book)">
                    {st.depthRows ? `${st.depthRows} × ${st.depthRows} rows` : 'no depth'}
                  </span>
                </header>
                <OrderBookPanel view={view} precision={precision} rows={10} />
              </section>
              <section className="ofp-panel ofp-panel--grow">
                <div role="tablist" className="ofp-tablist ofp-tablist--side">
                  <button type="button" role="tab" aria-selected={sideTab === 'strength'} className={sideTab === 'strength' ? 'is-on' : ''} onClick={() => setSideTab('strength')}>
                    Liquidity Strength
                  </button>
                  <button type="button" role="tab" aria-selected={sideTab === 'depth'} className={sideTab === 'depth' ? 'is-on' : ''} onClick={() => setSideTab('depth')}>
                    Depth Heatmap
                  </button>
                </div>
                {sideTab === 'strength' ? (
                  <LiquidityStrength view={view} precision={precision} now={now} />
                ) : (
                  <div className="ofp-depth">
                    <DepthHeatmap recorder={view.recorder} center={view.last ?? view.quote?.bid ?? null} now={now} spanMs={30 * 60_000} rows={12} precision={precision} version={view.version} />
                  </div>
                )}
              </section>
            </aside>
          </>
        )}
      </div>

      {full && (
        <>
          <OfpSplitter dir="row" label="Resize analytics panels" onDrag={resize('metrics', -1)} onEnd={commitPanes} />
          {/* ---------------- metric strip ---------------- */}
          <div className="ofp-metrics">
            <section className="ofp-mini">
              <header>
                <h2>CVD</h2>
                <b className={lastCvd && lastCvd.v < 0 ? 'ask' : 'bid'}>{lastCvd ? fmtSigned(lastCvd.v) : '—'}</b>
                {lastCvd?.partial && <span className="ofp-tag ofp-tag--warn" title="Unknown-side prints are excluded">PARTIAL</span>}
              </header>
              <MiniSeries points={view.cvd} mode="area" label="CVD" />
            </section>
            <section className="ofp-mini">
              <header>
                <h2>Volume</h2>
                <b className="bid">{fmtNum(view.stats.volume)}</b>
              </header>
              <MiniSeries points={view.volume} mode="bars" label="Volume" />
            </section>
            <section className="ofp-mini">
              <header>
                <h2>Delta</h2>
                <b className={lastDelta && lastDelta.v < 0 ? 'ask' : 'bid'}>{lastDelta ? fmtSigned(lastDelta.v) : '—'}</b>
              </header>
              <MiniSeries points={view.delta} mode="bars" label="Delta" />
            </section>
            <section className="ofp-mini">
              <header>
                <h2>Order Flow Imbalance</h2>
                <b className={lastOfi && lastOfi.v < 0 ? 'ask' : 'bid'}>{lastOfi ? fmtSigned(lastOfi.v) : '—'}</b>
                <span className="ofp-tag" title="Top-of-book OFI (Cont-Kukanov-Stoikov) from IBKR quotes">top of book</span>
              </header>
              <MiniSeries points={view.ofi} mode="bars" label="OFI" />
            </section>
          </div>

          <OfpSplitter dir="row" label="Resize bottom tables" onDrag={resize('bottom', -1)} onEnd={commitPanes} />
          {/* ---------------- bottom ---------------- */}
          <div className="ofp-bottom">
            <section className="ofp-panel ofp-tabs">
              <div role="tablist" className="ofp-tablist">
                {TABS.map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <div role="tabpanel" className="ofp-tabpanel">
                {tab === 'Trades (Footprint)' && <TradesTable view={view} precision={precision} />}
                {tab === 'Alerts' && <AlertsList alerts={view.alerts} />}
                {tab === 'Reversal Detector' && <ReversalTable signals={view.reversals} />}
                {tab === 'Strong Liquidity' && <StrongTable view={view} precision={precision} />}
                {tab === 'Absorptions' && <AbsorptionTable signals={view.reversals} />}
                {tab === 'Session Stats' && <SessionStatsPanel view={view} />}
                {tab === 'Diagnostics' && <DiagnosticsPanel view={view} demo={demo} onLinkChange={() => setLinkVer((v) => v + 1)} />}
              </div>
            </section>
            <section className="ofp-panel">
              <header>
                <h2>Reversal Detector {replay ? '(Replay)' : demo ? '(Demo)' : live ? '(Live)' : ''}</h2>
                <span className="ofp-tag" title="Evidence scores are additive weights of present evidence - not probabilities">research only</span>
              </header>
              <ReversalTable signals={view.reversals} compact />
            </section>
            <section className="ofp-panel">
              <header>
                <h2>Session Volume Profile</h2>
                <span className="ofp-tag">executed prints</span>
              </header>
              <SessionVpPanel view={view} precision={precision} />
            </section>
          </div>
        </>
      )}

      {!workspace && (
        <footer className="ofp-foot">
          <span>TLUXE | ORDER FLOW PRO</span>
          <span>{lastBar ? `${view.bars.length} bars · ${lastBar.source === 'BARS_ONLY' ? 'historical bars (no footprint)' : 'built from prints'}` : 'no bars'}</span>
          <span>IBKR price-level depth (not full book, not MBO) · quote-rule inferred sides · research only — no orders, no signals to trade</span>
        </footer>
      )}
    </div>
  );
}
