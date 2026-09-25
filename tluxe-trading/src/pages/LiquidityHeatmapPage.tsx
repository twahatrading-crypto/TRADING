import { Flame } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServices } from '../app/servicesContext';
import { UPCOMING_WINDOW_MS } from '../config/sessions';
import { tickSizeOf } from '../config/instruments';
import { DEFAULT_HEATMAP_VIEW, type HeatmapViewSettings } from '../engines/orderFlow/config';
import { rangeProfile } from '../engines/orderFlow/engine';
import type { OrderFlowReplay } from '../engines/orderFlow/replay';
import type { FeedStatus, OrderFlowEvent } from '../engines/orderFlow/types';
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
import { BookPanel, CvdPanel, EventsPanel, Pill, ProfilePanel, SettingsPanel } from '../components/orderFlow/OrderFlowPanels';
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
  const { orderFlow, instruments } = useServices();
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
  const lastTradeLive = tradeStatus === 'LIVE' && data.lastTrade;
  const last = lastTradeLive ? data.lastTrade!.price : quote.last;
  const bid = book?.bestBid ?? quote.bid;
  const ask = book?.bestAsk ?? quote.ask;
  const session = def.tradingHours && def.tradingHours !== '24/7' ? getSessionState(def.tradingHours, now, UPCOMING_WINDOW_MS) : null;
  const onSelect = (e: OrderFlowEvent) => {
    setSelected(e.id);
    setTab('heatmap');
    heat?.focus(e.time, e.price);
  };
  const cls = (t: Tab) => (tab === t ? '' : 'ofhide-narrow');

  return (
    <main className="srmain ofmain">
      <div className="ofbar" data-testid="of-bar">
        <div className="ofbar__brand">
          <span className="hlehead__icon" aria-hidden="true"><Flame size={18} /></span>
          <div>
            <h1 className="ofbar__title">Liquidity Heatmap</h1>
            <p className="ofbar__sub">Order flow · displayed exchange liquidity and executed trades</p>
          </div>
        </div>
        <div className="ofbar__cell"><span>Instrument</span><strong>{def.shortName} · {def.exchange ?? def.venue}</strong></div>
        <div className="ofbar__cell"><span>Contract</span><strong data-testid="of-contract">{st.contract ?? '—'}</strong></div>
        <div className="ofbar__cell"><span>Last{lastTradeLive ? ' (trade)' : ''}</span><strong className="num">{last == null ? '—' : formatPrice(last, d)}</strong></div>
        <div className="ofbar__cell"><span>Change</span><strong className={`num ${(quote.change ?? 0) >= 0 ? 'up' : 'down'}`}>{quote.change == null ? '—' : `${quote.change >= 0 ? '+' : ''}${formatPrice(quote.change, d)} (${(quote.changePercent ?? 0).toFixed(2)}%)`}</strong></div>
        <div className="ofbar__cell"><span>Bid</span><strong className="num ofbid-t">{bid == null ? '—' : formatPrice(bid, d)}</strong></div>
        <div className="ofbar__cell"><span>Ask</span><strong className="num ofask-t">{ask == null ? '—' : formatPrice(ask, d)}</strong></div>
        <div className="ofbar__cell"><span>Spread</span><strong className="num">{bid != null && ask != null ? formatPrice(ask - bid, d) : '—'}</strong></div>
        <div className="ofbar__cell"><span>Session</span><strong>{session ? (session.status === 'OPEN' ? 'OPEN' : session.status) : '—'}</strong></div>
        <div className="ofbar__cell ofbar__feeds" data-testid="of-feeds">
          <Pill status={priceStatus} label="PRICE" />
          <Pill status={depthStatus} label="DEPTH" />
          <Pill status={tradeStatus} label="TRADES" />
        </div>
        <div className="ofbar__cell"><span>Latency</span><strong className="num">{st.latencyMs == null ? '—' : `${st.latencyMs} ms`}</strong></div>
        <div className="ofbar__cell"><span>Exchange time</span><strong className="num">{st.exchTime ? new Date(st.exchTime).toLocaleTimeString('en-GB', { hour12: false }) : '—'}</strong></div>
        <div className="ofbar__cell"><span>Local time</span><strong className="num">{new Date(now).toLocaleTimeString('en-GB', { hour12: false })}</strong></div>
      </div>

      {!st.supported && (
        <div className="panel ofwarn" role="status">
          <strong>{def.shortName}: no exchange Level-2.</strong> {st.reason}
          <button type="button" className="ofbtn" onClick={() => instruments.select('GC')}>Switch to GC — COMEX Gold Futures</button>
        </div>
      )}

      <nav className="oftabs" role="tablist" aria-label="Order-flow panels">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      <div className="ofgrid">
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
          onStartReplay={() => setReplay(orderFlow.createReplay())}
          onExitReplay={() => {
            replay?.dispose();
            setReplay(null);
          }}
          onViewport={setVp}
          onReady={setHeat}
        />
        <BookPanel className={cls('dom')} data={data} d={d} depthStatus={depthStatus} depthDetail={st.depth.detail} />
        <ProfilePanel className={cls('profile')} session={data.profile} visible={visibleProfile} mode={profileMode} onMode={setProfileMode} d={d} tradeStatus={tradeStatus} tradeDetail={st.trade.detail} aggressor={st.capabilities.aggressorSide} />
      </div>
      <div className="ofbottom">
        <SettingsPanel className={cls('settings')} view={view} onView={setView} engine={st.settings} onEngine={(p) => orderFlow.setEngineSettings(p)} />
        <EventsPanel className={cls('events')} events={data.events} limitations={data.limitations} d={d} onSelect={onSelect} selected={selected} />
        <CvdPanel className={cls('cvd')} data={data} tradeDetail={st.trade.detail} />
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
