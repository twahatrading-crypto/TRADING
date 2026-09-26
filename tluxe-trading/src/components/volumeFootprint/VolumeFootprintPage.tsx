import { Footprints } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { DEFAULT_FP_SETTINGS, type FootprintSettings } from '../../engines/volumeFootprint/config';
import type { FPTimeframe } from '../../engines/volumeFootprint/types';
import { tickSizeOf } from '../../config/instruments';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { FPReplaySession, FPReplaySpeed } from '../../services/volumeFootprint/FPReplay';
import { useStore } from '../../store/createStore';
import { formatPrice } from '../../utils/format';
import { FPChart } from './FPChart';
import { CandlePanel, CvdPanel, DeltaPanel, EventsPanel, ImbalancePanel, IntegrityPanel, MtfPanel, SettingsPanel, Tag } from './FPPanels';
import {
  DEFAULT_FP_TOGGLES,
  DEFAULT_FP_VIEW,
  FP_CHART_TFS,
  FP_TOGGLE_LABELS,
  FP_VIEW_TITLE,
  crossEngineLines,
  cvdSeries,
  deltaTone,
  fmtDelta,
  fpMarkers,
  fpViewState,
  missingCapability,
  type FPToggles,
  type FPViewSettings,
} from './fpView';
import '../sr/sr.css';
import '../smc/smc.css';
import '../volumeProfile/vp.css';
import './fp.css';

/** Page default: 2-tick rows keep Bid × Ask numbers readable at the default zoom (user-adjustable; engine default is 1 tick). */
const PAGE_DEFAULT_SETTINGS: FootprintSettings = { ...DEFAULT_FP_SETTINGS, rowTicks: 2 };
const isTf = (v: unknown): v is FPTimeframe => typeof v === 'string' && (FP_CHART_TFS as string[]).includes(v);
const isObjWith = (keys: string[]) => (v: unknown): v is never => !!v && typeof v === 'object' && keys.every((k) => k in (v as object));
const isToggles = (v: unknown): v is FPToggles => !!v && typeof v === 'object' && FP_TOGGLE_LABELS.every(([k]) => typeof (v as Record<string, unknown>)[k] === 'boolean');
const isSpeed = (v: unknown): v is number => v === 1 || v === 2 || v === 5 || v === 10;

/**
 * VOLUME FOOTPRINT page — EXECUTED ORDER-FLOW ANALYSIS only (no BUY / SELL / entries / SL / TP / orders).
 * Needs genuine exchange time & sales with aggressor side; otherwise it says FOOTPRINT DATA UNAVAILABLE and
 * names the missing capability. The engine runs outside React; this page only displays its output.
 */
export function VolumeFootprintPage() {
  const { volumeFootprint: fp, volumeProfile, smc, sr } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const st = useStore(fp.store, (s) => s);
  const vpState = useStore(volumeProfile.store, (s) => s);
  const smcState = useStore(smc.store, (s) => s);
  const srZones = useStore(sr.store(def.id), (s) => s.multi?.zones ?? null);
  const [tf, setTf] = usePersistentState<FPTimeframe>('tluxe.fp.tf', 'M5', isTf);
  const [view, setView] = usePersistentState<FPViewSettings>('tluxe.fp.view.v1', DEFAULT_FP_VIEW, isObjWith(Object.keys(DEFAULT_FP_VIEW)));
  const [toggles, setToggles] = usePersistentState<FPToggles>('tluxe.fp.toggles.v1', DEFAULT_FP_TOGGLES, isToggles);
  const [analysis, setAnalysis] = usePersistentState<FootprintSettings>('tluxe.fp.settings.v1', PAGE_DEFAULT_SETTINGS, isObjWith(Object.keys(DEFAULT_FP_SETTINGS)));
  const [replaySpeed, setReplaySpeed] = usePersistentState<number>('tluxe.fp.replaySpeed', 1, isSpeed);
  const [replay, setReplay] = useState<FPReplaySession | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const rs = useOptionalStore(replay?.store, (s) => s, null);

  useEffect(() => fp.setSettings(analysis), [fp, analysis]);
  useEffect(() => {
    setReplay((r) => {
      r?.dispose();
      return null;
    });
    setSelected(null);
  }, [def.id]);
  useEffect(() => () => replay?.dispose(), [replay]);
  const startReplay = useCallback(() => {
    const r = fp.createReplay(tf);
    r?.setSpeed(replaySpeed as FPReplaySpeed);
    setReplay(r);
  }, [fp, tf, replaySpeed]);
  const exitReplay = useCallback(() => {
    replay?.dispose();
    setReplay(null);
  }, [replay]);

  const live = st.instrumentId === def.id;
  const engine = live ? fp.engine() : null;
  const version = st.version;
  const liveCandles = useMemo(() => engine?.candles(tf) ?? [], [engine, tf, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveEvents = useMemo(() => engine?.events(tf) ?? [], [engine, tf, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveImb = useMemo(() => (engine?.imbalances(tf) ?? []).map((x) => ({ ...x })), [engine, tf, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveStacks = useMemo(() => (engine?.stacks(tf) ?? []).map((x) => ({ ...x })), [engine, tf, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const rsCandles = rs?.candles;
  const rsEvents = rs?.events;
  const rsImb = rs?.imbalances;
  const rsStacks = rs?.stacks;
  const candles = useMemo(() => (replay ? (rsCandles ?? []) : liveCandles), [replay, rsCandles, liveCandles]);
  const events = useMemo(() => (replay ? (rsEvents ?? []) : liveEvents), [replay, rsEvents, liveEvents]);
  const imbalances = useMemo(() => (replay ? (rsImb ?? []) : liveImb), [replay, rsImb, liveImb]);
  const stacks = useMemo(() => (replay ? (rsStacks ?? []) : liveStacks), [replay, rsStacks, liveStacks]);
  const snap = replay ? (rs?.snapshot ?? null) : live ? st.snapshot : null;
  const viewState = fpViewState(st, !!replay);
  const missing = missingCapability(st, st.snapshot);

  const vpSnap = vpState.instrumentId === def.id ? vpState.snapshot : null;
  const smcSnap = smcState.instrumentId === def.id ? smcState.snapshot : null;
  const lastPrice = snap?.lastPrice ?? null;
  const cvd = useMemo(() => cvdSeries(candles), [candles]);
  const lines = useMemo(() => crossEngineLines({ toggles, tf, vp: vpSnap, smc: smcSnap, sr: srZones, price: lastPrice }), [toggles, tf, vpSnap, smcSnap, srZones, lastPrice]);
  const markers = useMemo(() => fpMarkers(events, tf, toggles, candles), [events, tf, toggles, candles]);
  const rowSize = Number((tickSizeOf(def) * (st.settings.rowTicks || 1)).toFixed(6));
  const selIdx = selected === null ? candles.length - 1 : candles.findIndex((c) => c.time === selected);
  const current = selIdx >= 0 ? (candles[selIdx] ?? null) : (candles[candles.length - 1] ?? null);
  const render = useMemo(() => ({ rowSize, decimals: d, view, toggles, stacks, lines, cvd, selected: selected ?? null }), [rowSize, d, view, toggles, stacks, lines, cvd, selected]);
  const onSelect = useCallback((t: number) => setSelected(t), []);

  const feedText = !st.provider ? 'Not connected' : snap?.integrity.feed === 'DISCONNECTED' ? 'Disconnected' : st.stale ? 'Stale' : snap?.integrity.feed === 'LIVE' ? 'Live' : (snap?.integrity.feed ?? 'Connecting');
  const statusText = snap?.status === 'ACTIVE' ? (replay ? 'Replay' : 'Real Time') : 'FOOTPRINT DATA UNAVAILABLE';
  const integ = snap?.integrity.state ?? 'UNAVAILABLE';
  const cur = candles[candles.length - 1] ?? null;
  const ses = snap?.sessionStart ? `CME Globex since ${new Date(snap.sessionStart * 1000).toISOString().slice(5, 16).replace('T', ' ')} UTC` : 'CME Globex · 18:00 NY';

  return (
    <main className="srmain smcmain fpmain" data-testid="fp-page">
      <div className="smchead">
        <div className="smchead__brand">
          <span className="smchead__icon" aria-hidden="true">
            <Footprints size={20} />
          </span>
          <div>
            <h1 className="smchead__title">Volume Footprint</h1>
            <p className="smchead__sub">Executed order flow — what actually traded at each price inside each candle (Bid × Ask from the exchange aggressor side). Analysis only: no signals, no orders.</p>
          </div>
        </div>
        <div className="smccards fpcards" data-testid="fp-top">
          <div className="panel smccard">
            <span className="smccard__k">Instrument</span>
            <strong>{def.shortName}</strong>
            <span className="smccard__sub">{def.name}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Contract</span>
            <strong data-testid="fp-contract">{snap?.contract ?? '—'}</strong>
            <span className="smccard__sub">{snap?.previousContracts.length ? `prev ${snap.previousContracts.at(-1)}` : 'never combined'}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Last Price</span>
            <span className="num smccard__big">{lastPrice === null ? '—' : formatPrice(lastPrice, d)}</span>
            <span className="smccard__sub">last exchange trade</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Session</span>
            <strong>{ses}</strong>
            <span className="smccard__sub" />
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Data Provider</span>
            <strong data-testid="fp-provider">{st.provider ?? 'Not connected'}</strong>
            <span className="smccard__sub">{st.testProvider ? 'TEST DATA' : st.provider ? 'exchange time & sales' : 'Rithmic / T4 / CQG required'}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Trade Feed</span>
            <strong className={feedText === 'Live' ? 'fp-bull' : 'fp-warn'}>{feedText}</strong>
            <span className="smccard__sub">{snap?.caps.trades ? `aggressor: ${snap.caps.aggressor}` : 'no trades'}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Footprint Status</span>
            <strong data-testid="fp-status" className={snap?.status === 'ACTIVE' ? 'fp-bull' : 'vpwarn'}>
              {statusText}
            </strong>
            <span className="smccard__sub" data-testid="fp-view-state">{FP_VIEW_TITLE[viewState]}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Current Delta</span>
            <strong className={`num fp-${deltaTone(cur?.delta)}`} data-testid="fp-current-delta">
              {cur ? fmtDelta(cur.delta) : '—'}
            </strong>
            <span className="smccard__sub">{tf} candle</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Cumulative Delta</span>
            <strong className={`num fp-${deltaTone(snap?.cvd)}`} data-testid="fp-cvd-card">
              {snap && snap.cvdAvailability !== 'UNAVAILABLE' ? fmtDelta(snap.cvd) : '—'}
            </strong>
            <span className="smccard__sub">{snap?.cvdAvailability === 'PARTIAL' ? 'unknown volume excluded' : ''}</span>
          </div>
          <div className="panel smccard smccard--state">
            <span className="smccard__k">Data Integrity</span>
            <span data-testid="fp-integrity-state">
              <Tag v={integ} tone={integ === 'GOOD' ? 'bull' : integ === 'DEGRADED' ? 'warn' : 'bear'} />
            </span>
            <span className="smccard__sub">{snap?.integrity.reasons[0] ?? ''}</span>
          </div>
        </div>
      </div>

      {missing && (
        <div className="panel fpbanner" role="status" data-testid="fp-unavailable">
          <strong>FOOTPRINT DATA UNAVAILABLE</strong>
          <span>{missing}</span>
        </div>
      )}

      <div className="fpgrid">
        <FPChart tf={tf} onTf={setTf} candles={candles} render={render} markers={markers} viewState={viewState} missing={missing} contract={snap?.contract ?? null} replay={replay} replayTime={rs?.knowledgeTime ?? null} onStartReplay={startReplay} onExitReplay={exitReplay} onSelect={onSelect} />
        <CandlePanel candle={current} d={d} unavailable={missing} canPrev={selIdx > 0} canNext={selIdx >= 0 && selIdx < candles.length - 1} onPrev={() => selIdx > 0 && setSelected(candles[selIdx - 1]!.time)} onNext={() => (selIdx >= 0 && selIdx < candles.length - 1 ? setSelected(selIdx + 1 === candles.length - 1 ? null : candles[selIdx + 1]!.time) : undefined)} />
        <div className="fpside">
          <SettingsPanel tf={tf} onTf={setTf} analysis={analysis} onAnalysis={setAnalysis} view={view} onView={setView} replaySpeed={replaySpeed} onReplaySpeed={(n) => {
            setReplaySpeed(n);
            replay?.setSpeed(n as FPReplaySpeed);
          }} tick={tickSizeOf(def)} />
          <aside className="panel smctoggles" aria-label="Chart overlays" data-testid="fp-toggles">
            <h3>OVERLAYS</h3>
            {FP_TOGGLE_LABELS.map(([k, label]) => (
              <label key={k} className="smctoggle">
                <span>{label}</span>
                <input type="checkbox" role="switch" checked={toggles[k]} onChange={() => setToggles({ ...toggles, [k]: !toggles[k] })} />
              </label>
            ))}
            <p className="smcnote">Volume Profile, Liquidity, S&R, Order Blocks, FVG and BOS / CHOCH are the other engines' published output for {def.shortName} — read-only{lines.length === 0 && (toggles.volumeProfile || toggles.liquidity || toggles.sr || toggles.orderBlocks || toggles.fvg || toggles.bosChoch) ? ' (none available for this instrument)' : ''}.</p>
          </aside>
        </div>
      </div>

      <div className="vprow3">
        <DeltaPanel candles={candles} snapshot={snap} />
        <CvdPanel series={cvd} snapshot={snap} />
        <MtfPanel snapshot={snap} tf={tf} onTf={setTf} d={d} />
      </div>
      <div className="fprow2">
        <ImbalancePanel levels={imbalances} d={d} />
        <EventsPanel events={events} d={d} />
      </div>
      <IntegrityPanel snapshot={snap} provider={st.provider} reason={st.reason} />
      <p className="smcnote smcdisclaimer">
        Volume Footprint v1 — executed order-flow analysis only. Bid = aggressive selling, Ask = aggressive buying, Delta = Ask − Bid; UNKNOWN volume is never assigned to a side. Imbalances, absorption, exhaustion, divergence and unfinished-auction labels are evidence-based CANDIDATES — never BUY / SELL signals, entries, stop losses or take profits.
      </p>
    </main>
  );
}
