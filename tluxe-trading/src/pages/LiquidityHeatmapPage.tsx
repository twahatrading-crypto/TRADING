import { Bell, ChevronDown, ChevronUp, Flame, LineChart, Play, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useServices } from '../app/servicesContext';
import { UPCOMING_WINDOW_MS } from '../config/sessions';
import { tickSizeOf } from '../config/instruments';
import { DEFAULT_HEATMAP_VIEW, type HeatmapViewSettings } from '../engines/orderFlow/config';
import { rangeProfile } from '../engines/orderFlow/engine';
import type { OrderFlowReplay } from '../engines/orderFlow/replay';
import type { FeedStatus, OrderFlowEvent, OrderFlowMsg } from '../engines/orderFlow/types';
import { useActiveInstrument, useMarket } from '../hooks/useMarket';
import { useOptionalStore } from '../hooks/useOptionalStore';
import { usePersistentState } from '../hooks/usePersistentState';
import { panelsOf } from '../services/orderFlow/view';
import { useStore } from '../store/createStore';
import { formatPrice } from '../utils/format';
import { getSessionState } from '../utils/sessions';
import { HeatmapPanel } from '../components/orderFlow/HeatmapPanel';
import type { HeatmapView } from '../components/orderFlow/HeatmapView';
import type { Viewport } from '../components/orderFlow/heatmapMath';
import { DOT_AGGREGATIONS, catchUpFrom, latestTrade, type DotAggregation, type TradeSource } from '../components/orderFlow/tradeDots';
import { BookPanel, CvdPanel, EventsPanel, Pill, ProfilePanel, SettingsPanel } from '../components/orderFlow/OrderFlowPanels';
import { capLabel } from '../components/databento/capabilities';
import { IbkrDepthPill, IbkrSessionStrip } from '../components/orderFlow/IbkrSession';
import '../components/sr/sr.css';
import '../components/orderFlow/orderFlow.css';

type Tab = 'heatmap' | 'dom' | 'profile' | 'cvd' | 'events' | 'settings';
const TABS: [Tab, string][] = [
  ['heatmap', 'Heatmap'],
  ['dom', 'DOM'],
  ['profile', 'Volume Profile'],
  ['cvd', 'CVD'],
  ['events', 'Events'],
  ['settings', 'Settings'],
];
/** Page-level panel toggles (presentation only; engine / view settings are unchanged). */
interface OfUi {
  heatmap: boolean;
  cvd: boolean;
  cob: boolean;
  svp: boolean;
}
const DEFAULT_OF_UI: OfUi = { heatmap: true, cvd: true, cob: true, svp: true };
const isUi = (v: unknown): v is OfUi => !!v && typeof v === 'object' && ['heatmap', 'cvd', 'cob', 'svp'].every((k) => typeof (v as Record<string, unknown>)[k] === 'boolean');
const isDotAgg = (v: unknown): v is DotAggregation => DOT_AGGREGATIONS.includes(v as DotAggregation);
const dotAggLabel = (v: DotAggregation) => (v === 'auto' ? 'AUTO' : v >= 1000 ? `${v / 1000} sec` : `${v} ms`);
const TIME_FRAMES: [number, string][] = [
  [250, 'Real-time · 0.25s'],
  [500, 'Real-time · 0.5s'],
  [1000, 'Real-time · 1s'],
  [5000, '5s'],
  [10_000, '10s'],
];
const capTone = (v: string | null | undefined) => (v === 'LIVE' ? 'ok' : v === 'STALE' || v === 'WAITING' || v === 'SYNCING' || v === 'DEGRADED' ? 'warn' : v === 'OFFLINE' || v === 'UNAVAILABLE' ? 'bad' : 'muted');
const CapPill = ({ label, v }: { label: string; v: string | null | undefined }) => (
  <span className={`ofpill ofpill--${capTone(v)}`}>
    <i aria-hidden="true" />
    {label}: {v ? capLabel(v) : '—'}
  </span>
);
function Toggle({ label, on, onChange, disabled, note }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean; note?: string }) {
  return (
    <label className={`oftoggle${disabled ? ' is-off' : ''}`} title={note}>
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={on && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      {disabled && note && <em>{note}</em>}
    </label>
  );
}

const isView = (v: unknown): v is HeatmapViewSettings => !!v && typeof v === 'object' && 'contrast' in (v as object) && 'colorScheme' in (v as object);

/** Trading Strategy → Liquidity Heatmap (order flow). Observation only: no signals, entries, SL / TP. */
export function LiquidityHeatmapPage() {
  const def = useActiveInstrument();
  return (
    <div className="srapp ofapp">
      <Workspace key={def.id} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>Liquidity Heatmap · order flow</span>
          <span>Exchange Level-2 depth + time &amp; sales only — never MT5, never synthetic · observation only, no signals, no orders</span>
        </div>
      </footer>
    </div>
  );
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Workspace() {
  const { orderFlow, instruments, databento } = useServices();
  const dbFeed = useOptionalStore(databento?.state, (s) => s, null);
  const [ui, setUi] = usePersistentState<OfUi>('tluxe.orderflow.ui.v1', { ...DEFAULT_OF_UI }, isUi);
  const [diag, setDiag] = useState(false);
  const def = useActiveInstrument();
  const st = useStore(orderFlow.store, (s) => s);
  const quote = useMarket((s) => s.quote);
  const connection = useMarket((s) => s.connection);
  const priceProvider = useMarket((s) => s.provider);
  const d = def.pricePrecision;
  const tick = tickSizeOf(def);
  const now = useNow();
  const [view, setView] = usePersistentState<HeatmapViewSettings>('tluxe.orderflow.view.v1', { ...DEFAULT_HEATMAP_VIEW }, isView);
  const [replay, setReplay] = useState<OrderFlowReplay | null>(null);
  const [tab, setTab] = useState<Tab>('heatmap');
  const [vp, setVp] = useState<Viewport | null>(null);
  const [heat, setHeat] = useState<HeatmapView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [profileMode, setProfileMode] = useState<'session' | 'visible'>('session');
  useEffect(() => () => replay?.dispose(), [replay]);
  const replayCursor = useOptionalStore(replay?.store, (s) => s.cursor, 0);
  const [dotAgg, setDotAgg] = usePersistentState<DotAggregation>('tluxe.orderflow.dots.v1', 'auto', isDotAgg);
  /** The messages the replay was built from (same list, same order) - the chart draws its trades up to the cursor. */
  const replayMsgs = useRef<readonly OrderFlowMsg[]>([]);
  /** Raw accepted messages, READ ONLY: the chart places every trade at its own exchange time (display only). */
  const tape = useCallback((): TradeSource | null => {
    if (replay) return { msgs: replayMsgs.current, count: replay.store.getState().cursor };
    const msgs = orderFlow.recording();
    return { msgs, count: msgs.length };
  }, [replay, orderFlow]);

  const engine = useCallback(() => (replay ? replay.engine : orderFlow.engine()), [replay, orderFlow]);
  const version = replay ? replayCursor : st.version;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on every engine version (batched publish / replay step)
  const data = useMemo(() => panelsOf(engine()), [engine, version]);
  const visibleProfile = useMemo(() => {
    const e = engine();
    return e && vp ? rangeProfile(e.allColumns(), vp.t0, vp.t1, (t) => e.book.price(t)) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, vp, version]);
  const hasData = (engine()?.allColumns().length ?? 0) > 0;

  const replayStatus: FeedStatus | null = replay ? 'LIVE' : null;
  const depthStatus = replayStatus ?? st.depth.status;
  const tradeStatus = replayStatus ?? st.trade.status;
  const priceStatus: FeedStatus = connection === 'LIVE' ? 'LIVE' : !priceProvider ? 'DATA_UNAVAILABLE' : connection === 'CONNECTING' ? 'CONNECTING' : connection === 'DELAYED' ? 'STALE' : 'DISCONNECTED';
  const book = data.book;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on every engine version
  const latest = useMemo(() => latestTrade(tape()), [tape, version]);
  const tapeBehind = replay ? null : catchUpFrom(latest?.time ?? null, st.exchTime);
  const lastTradeLive = tradeStatus === 'LIVE' && (latest ?? data.lastTrade);
  const last = lastTradeLive ? (latest ?? data.lastTrade)!.price : quote.last;
  const bid = book?.bestBid ?? quote.bid;
  const ask = book?.bestAsk ?? quote.ask;
  const session = def.tradingHours && def.tradingHours !== '24/7' ? getSessionState(def.tradingHours, now, UPCOMING_WINDOW_MS) : null;
  const onSelect = (e: OrderFlowEvent) => {
    setSelected(e.id);
    setTab('heatmap');
    heat?.focus(e.time, e.price);
  };
  const cls = (t: Tab) => (tab === t ? '' : 'ofhide-narrow');

  const depthAvailable = st.capabilities.depth !== 'NONE' || !!replay;
  // IBKR COMEX Level-2 is the depth source (cloud VPS link): its own labels and session health strip.
  const ibkrDepth = /^IBKR/.test(st.depth.provider ?? '');
  const dbCaps = (dbFeed?.health?.instruments as Record<string, { capabilities?: Record<string, string> } | undefined> | undefined)?.[def.id]?.capabilities ?? null;
  const futures = instruments.list.filter((x) => x.kind === 'future' && x.exchange === 'COMEX');
  const pickable = futures.some((x) => x.id === def.id) ? futures : [def, ...futures];
  const startReplay = () => {
    replayMsgs.current = [...orderFlow.recording()];
    setReplay(orderFlow.createReplay());
  };
  const exitReplay = () => {
    replay?.dispose();
    setReplay(null);
  };
  const setU = (k: keyof OfUi, v: boolean) => setUi({ ...ui, [k]: v });
  const gridCls = `ofgrid${ui.cob ? '' : ' no-cob'}${ui.svp ? '' : ' no-svp'}`;

  return (
    <main className={`srmain ofmain${ibkrDepth ? ' has-ibkr' : ''}`}>
      <div className="ofbar" data-testid="of-bar">
        <div className="ofbar__brand">
          <span className="hlehead__icon" aria-hidden="true"><Flame size={18} /></span>
          <div>
            <h1 className="ofbar__title">Liquidity Heatmap</h1>
            <p className="ofbar__sub">Order flow · executed trades{depthAvailable ? ' + displayed exchange liquidity' : ''} · observation only</p>
          </div>
        </div>
        <div className="ofbar__cell"><span>Contract</span><strong data-testid="of-contract">{st.contract ?? '—'}</strong></div>
        <div className="ofbar__cell"><span>Last{lastTradeLive ? ' (trade)' : ''}</span><strong className="num ofbar__last">{last == null ? '—' : formatPrice(last, d)}</strong></div>
        <div className="ofbar__cell"><span>Change</span><strong className={`num ${(quote.change ?? 0) >= 0 ? 'up' : 'down'}`}>{quote.change == null ? '—' : `${quote.change >= 0 ? '+' : ''}${formatPrice(quote.change, d)} (${(quote.changePercent ?? 0).toFixed(2)}%)`}</strong></div>
        <div className="ofbar__cell"><span>Bid</span><strong className="num ofbid-t">{bid == null ? '—' : formatPrice(bid, d)}</strong></div>
        <div className="ofbar__cell"><span>Ask</span><strong className="num ofask-t">{ask == null ? '—' : formatPrice(ask, d)}</strong></div>
        <div className="ofbar__cell"><span>Spread</span><strong className="num">{bid != null && ask != null ? formatPrice(ask - bid, d) : '—'}</strong></div>
        <div className="ofbar__cell"><span>Session</span><strong>{session ? (session.status === 'OPEN' ? 'OPEN' : session.status) : '—'}</strong></div>
        <div className="ofbar__cell"><span>Latency</span><strong className="num">{st.latencyMs == null ? '—' : `${st.latencyMs} ms`}</strong></div>
        <div className="ofbar__cell"><span>Exchange time</span><strong className="num">{st.exchTime ? new Date(st.exchTime).toLocaleTimeString('en-GB', { hour12: false }) : '—'}</strong></div>
        <div className="ofbar__feeds" data-testid="of-feeds">
          <Pill status={priceStatus} label="PRICE" />
          {/databento/i.test(st.trade.provider ?? '') ? <Pill status={tradeStatus} label="TRADES · DATABENTO" sep=" " /> : <Pill status={tradeStatus} label="TRADES" />}
          {dbCaps && <CapPill label="OHLCV" v={dbCaps.ohlcv} />}
          {dbCaps && <CapPill label="VOLUME" v={dbCaps.volume} />}
          {ibkrDepth ? <IbkrDepthPill root={def.id} /> : <Pill status={depthStatus} label="DEPTH" />}
          {dbCaps && <CapPill label="MBO" v={dbCaps.mbo} />}
          <button type="button" className="ofbtn ofbtn--ghost" aria-expanded={diag} onClick={() => setDiag(!diag)} data-testid="of-diag-toggle">
            Diagnostics {diag ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      <div className="ofctl" data-testid="of-controls">
        <label className="ofsel">
          <span>Instrument</span>
          <select value={def.id} onChange={(e) => instruments.select(e.target.value)} aria-label="Instrument">
            {pickable.map((x) => <option key={x.id} value={x.id}>{x.shortName} ({x.exchange ?? x.venue})</option>)}
          </select>
        </label>
        <label className="ofsel">
          <span>Time frame</span>
          <select value={st.settings.timeAggregationMs} onChange={(e) => orderFlow.setEngineSettings({ timeAggregationMs: Number(e.target.value) })} aria-label="Time frame">
            {(TIME_FRAMES.some(([v]) => v === st.settings.timeAggregationMs) ? TIME_FRAMES : [...TIME_FRAMES, [st.settings.timeAggregationMs, `${st.settings.timeAggregationMs / 1000}s`] as [number, string]]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <span className="ofctl__sep" aria-hidden="true" />
        <Toggle label="Heatmap" on={ui.heatmap} onChange={(v) => setU('heatmap', v)} disabled={!depthAvailable} note="DATA UNAVAILABLE" />
        <Toggle label="Volume Dots" on={view.showTrades} onChange={(v) => setView({ ...view, showTrades: v })} />
        <label className="ofsel ofsel--sm" title="Display aggregation of the executed-volume dots and price trace only - CVD, SVP, events and the raw trades are unchanged">
          <span>Trade agg.</span>
          <select value={String(dotAgg)} onChange={(e) => setDotAgg(e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as DotAggregation))} aria-label="Trade aggregation" data-testid="of-dot-agg">
            {DOT_AGGREGATIONS.map((v) => <option key={v} value={String(v)}>{dotAggLabel(v)}</option>)}
          </select>
        </label>
        <Toggle label="CVD" on={ui.cvd} onChange={(v) => setU('cvd', v)} />
        <Toggle label="COB" on={ui.cob} onChange={(v) => setU('cob', v)} />
        <Toggle label="SVP" on={ui.svp} onChange={(v) => setU('svp', v)} />
        <span className="ofctl__sep" aria-hidden="true" />
        <button type="button" className="ofbtn" disabled title="No indicators are available on the order-flow chart yet"><LineChart size={13} aria-hidden="true" /> Indicators</button>
        <button type="button" className="ofbtn" disabled title="Order-flow alerts are not available yet"><Bell size={13} aria-hidden="true" /> Alerts</button>
        <button type="button" className="ofbtn" aria-pressed={!!replay} onClick={replay ? exitReplay : startReplay} disabled={!replay && orderFlow.recording().length === 0} title="Replay the recorded stream"><Play size={13} aria-hidden="true" /> Replay</button>
        <button type="button" className="ofbtn" onClick={() => document.querySelector('[data-testid="of-settings"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><SlidersHorizontal size={13} aria-hidden="true" /> Settings</button>
      </div>

      {!st.supported && (
        <div className="panel ofwarn" role="status">
          <strong>{def.shortName}: no exchange Level-2.</strong> {st.reason}
          <button type="button" className="ofbtn" onClick={() => instruments.select('GC')}>Switch to GC — COMEX Gold Futures</button>
        </div>
      )}
      {diag && (
        <div className="panel ofdiag" data-testid="of-diagnostics">
          <span>Depth provider <b>{st.depth.provider ?? 'none'}</b> · {st.depth.status.replace(/_/g, ' ')}{st.depth.detail ? ` — ${st.depth.detail}` : ''}</span>
          <span>Trade provider <b>{st.trade.provider ?? 'none'}</b> · {st.trade.status.replace(/_/g, ' ')}{st.trade.detail ? ` — ${st.trade.detail}` : ''}</span>
          <span>Capabilities: depth <b>{st.capabilities.depth}</b> · aggressor side <b>{st.capabilities.aggressorSide ? 'exchange' : 'none'}</b> · sequenced <b>{st.capabilities.sequenced ? 'yes' : 'no'}</b></span>
        </div>
      )}

      {ibkrDepth && <IbkrSessionStrip root={def.id} databentoContract={st.contract} />}

      <nav className="oftabs" role="tablist" aria-label="Order-flow panels">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      <div className={gridCls}>
        <HeatmapPanel
          className={cls('heatmap')}
          source={engine}
          version={version}
          view={view}
          decimals={d}
          tickSize={tick}
          title={`${def.shortName} ${def.exchange ?? ''}${st.contract ? ` · ${st.contract}` : ''}`}
          depthStatus={depthStatus}
          depthDetail={st.depth.detail}
          tradeStatus={tradeStatus}
          supported={st.supported}
          reason={st.reason}
          hasData={hasData}
          replay={replay}
          canReplay={orderFlow.recording().length > 0}
          onStartReplay={startReplay}
          onExitReplay={exitReplay}
          onViewport={setVp}
          onReady={setHeat}
          depthAvailable={depthAvailable}
          showHeatmap={ui.heatmap}
          tradeSource={st.trade.provider}
          tape={tape}
          dotAggregation={dotAgg}
          tapeBehind={tapeBehind}
        />
        {ui.cob && <BookPanel className={cls('dom')} data={data} d={d} depthStatus={depthStatus} depthDetail={st.depth.detail} />}
        {ui.svp && <ProfilePanel className={cls('profile')} session={data.profile} visible={visibleProfile} mode={profileMode} onMode={setProfileMode} d={d} tradeStatus={tradeStatus} tradeDetail={st.trade.detail} aggressor={st.capabilities.aggressorSide} />}
      </div>
      <div className={`ofbottom${ui.cvd ? '' : ' no-cvd'}`}>
        <SettingsPanel className={cls('settings')} view={view} onView={setView} engine={st.settings} onEngine={(p) => orderFlow.setEngineSettings(p)} depthAvailable={depthAvailable} />
        <EventsPanel className={cls('events')} events={data.events} limitations={data.limitations} d={d} onSelect={onSelect} selected={selected} />
        {ui.cvd && <CvdPanel className={cls('cvd')} data={data} tradeDetail={st.trade.detail} />}
      </div>
      <p className="ofnote ofintegrity" data-testid="of-integrity">
        Integrity — depth: {st.depth.integrity ? `seq ${st.depth.integrity.lastSeq ?? '—'} · gaps ${st.depth.integrity.gaps} · duplicates ${st.depth.integrity.duplicates} · out-of-order ${st.depth.integrity.outOfOrder} · snapshots ${st.depth.integrity.snapshots}` : '—'}
        {st.snapshotAgeMs !== null && ` · snapshot age ${Math.round(st.snapshotAgeMs / 1000)} s`}
        {' '}· trades: {st.trade.integrity ? `seq ${st.trade.integrity.lastSeq ?? '—'} · gaps ${st.trade.integrity.gaps} · duplicates ${st.trade.integrity.duplicates}` : '—'}
        {' '}· provider: {st.depth.provider ?? 'none'}{st.trade.provider && st.trade.provider !== st.depth.provider ? ` / ${st.trade.provider}` : ''}
      </p>
    </main>
  );
}
