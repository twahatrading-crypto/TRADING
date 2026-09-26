import { Brain } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { SESSIONS, UPCOMING_WINDOW_MS } from '../../config/sessions';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { SmcReplaySession } from '../../services/smc/SmcReplay';
import { useStore } from '../../store/createStore';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { formatCountdown, getSessionState } from '../../utils/sessions';
import { SmcChart } from './SmcChart';
import { BreaksPanel, ConflictsPanel, EventLogPanel, FvgPanel, LiquidityPanel, MatrixPanel, ObPanel, PremiumDiscountPanel, ScorePanel, SequencePanel, StructurePanel, Tag } from './SmcPanels';
import { DEFAULT_SMC_TOGGLES, SMC_CHART_TFS, SMC_TOGGLE_LABELS, SMC_VIEW_TITLE, smcViewState, type SmcToggles } from './smcView';
import '../sr/sr.css';
import './smc.css';

const isTf = (v: unknown): v is Timeframe => typeof v === 'string' && (SMC_CHART_TFS as string[]).includes(v);
const isToggles = (v: unknown): v is SmcToggles => !!v && typeof v === 'object' && SMC_TOGGLE_LABELS.every(([k]) => typeof (v as Record<string, unknown>)[k] === 'boolean');

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * SMC ENGINE page — MARKET ANALYSIS only. React only displays the SmcService output (engine runs
 * outside React). No BUY / SELL signals, no entries, no SL / TP, no orders.
 */
export function SmcPage() {
  const { smc } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const quote = useMarket((s) => s.quote);
  const provider = useMarket((s) => s.provider);
  const d = instrument.priceDecimals;
  const live = useStore(smc.store, (s) => s);
  const [chartTf, setChartTf] = usePersistentState<Timeframe>('tluxe.smc.chartTf', 'M15', isTf);
  const [toggles, setToggles] = usePersistentState<SmcToggles>('tluxe.smc.toggles.v1', DEFAULT_SMC_TOGGLES, isToggles);
  const [replay, setReplay] = useState<SmcReplaySession | null>(null);
  const replaySnap = useOptionalStore(replay?.store, (s) => s.snapshot, null);
  const now = useNow();

  // A symbol change ends any replay (it belongs to the previous instrument's candles).
  useEffect(() => {
    setReplay((r) => {
      r?.dispose();
      return null;
    });
  }, [def.id]);
  useEffect(() => () => replay?.dispose(), [replay]);
  const startReplay = useCallback(() => setReplay(smc.createReplay(chartTf)), [smc, chartTf]);
  const exitReplay = useCallback(() => {
    replay?.dispose();
    setReplay(null);
  }, [replay]);

  const liveSnap = live.instrumentId === def.id ? live.snapshot : null;
  const snap = replay ? replaySnap : liveSnap;
  const tfSnap = snap?.byTimeframe[chartTf] ?? null;
  const viewState = smcViewState({ feed: live.feed, tf: tfSnap, replay: !!replay, hasProvider: !!provider });
  const log = replay ? (replaySnap?.events ?? []) : live.instrumentId === def.id ? live.log : [];
  const sessions = SESSIONS.filter((s) => s.id !== 'globex').map((s) => ({ s, st: getSessionState(s, now, UPCOMING_WINDOW_MS) }));
  const open = sessions.filter((x) => x.st.status === 'OPEN');
  const price = replay ? (replaySnap?.price ?? null) : (quote.last ?? liveSnap?.price ?? null);
  const verdict = snap?.summary.verdict ?? 'DATA UNAVAILABLE';

  return (
    <main className="srmain smcmain" data-testid="smc-page">
      <div className="smchead">
        <div className="smchead__brand">
          <span className="smchead__icon" aria-hidden="true"><Brain size={20} /></span>
          <div>
            <h1 className="smchead__title">SMC Engine</h1>
            <p className="smchead__sub">Smart Money Concepts market analysis — multi-timeframe structure, liquidity, displacement and imbalance from real closed candles. Analysis only: no signals, no orders.</p>
          </div>
        </div>
        <div className="smccards" data-testid="smc-top">
          <div className="panel smccard">
            <span className="smccard__k">Symbol</span>
            <strong>{instrument.symbol}</strong>
            <span className="num smccard__big">{price === null ? '—' : formatPrice(price, d)}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Session</span>
            <strong>{open.length ? open.map((x) => x.s.shortName ?? x.s.name).join(' + ') : 'No major session'}</strong>
            <span className="smccard__sub">{open[0] ? `ends in ${formatCountdown(open[0].st.countdownMs)}` : ''}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Data status</span>
            <strong data-testid="smc-data-status" className={`smcstatus is-${viewState.toLowerCase()}`}>{SMC_VIEW_TITLE[viewState]}</strong>
            <span className="smccard__sub">{provider ? provider.name : 'Provider: not connected'}{live.revisions ? ` · ${live.revisions} revised` : ''}</span>
          </div>
          {(['D1', 'H4', 'H1', 'M15', 'M5'] as Timeframe[]).map((tf) => {
            const s = snap?.byTimeframe[tf];
            return (
              <div key={tf} className="panel smccard">
                <span className="smccard__k">{tf} Structure</span>
                {s?.dataState === 'READY' ? <Tag v={s.state} /> : <Tag v={s?.dataState === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : 'NO DATA'} tone="muted" />}
                <span className="smccard__sub">{s?.dataState === 'READY' ? `${s.lastHigh?.label ?? '—'} + ${s.lastLow?.label ?? '—'}` : ''}</span>
              </div>
            );
          })}
          <div className="panel smccard smccard--state">
            <span className="smccard__k">SMC State</span>
            <span data-testid="smc-state"><Tag v={verdict} /></span>
            <span className="smccard__sub">{snap?.summary.bias ? `bias ${snap.summary.bias}` : ''}</span>
          </div>
        </div>
      </div>

      <div className="smcgrid">
        <SmcChart chartTf={chartTf} onChartTf={setChartTf} snapshot={snap} toggles={toggles} viewState={viewState} replay={replay} onStartReplay={startReplay} onExitReplay={exitReplay} />
        <aside className="panel smctoggles" aria-label="Chart overlays" data-testid="smc-toggles">
          <h3>CHART OVERLAYS</h3>
          {SMC_TOGGLE_LABELS.map(([k, label]) => (
            <label key={k} className="smctoggle">
              <span>{label}</span>
              <input type="checkbox" role="switch" checked={toggles[k]} onChange={() => setToggles({ ...toggles, [k]: !toggles[k] })} />
            </label>
          ))}
          <p className="smcnote">Every overlay is drawn from engine output for {chartTf}. MTF Confluence adds the higher-timeframe dealing ranges and swing levels.</p>
        </aside>
      </div>

      <div className="smcrow4">
        <SequencePanel key={`${def.id}:${chartTf}`} tf={tfSnap} />
        <StructurePanel tf={tfSnap} d={d} />
        <ScorePanel score={snap?.score ?? null} />
        <PremiumDiscountPanel tf={tfSnap} d={d} />
      </div>
      <MatrixPanel rows={snap?.matrix ?? []} chartTf={chartTf} onTf={setChartTf} />
      <div className="smcrow4">
        <LiquidityPanel tf={tfSnap} d={d} />
        <BreaksPanel tf={tfSnap} d={d} />
        <ObPanel tf={tfSnap} d={d} />
        <FvgPanel tf={tfSnap} d={d} />
      </div>
      <div className="smcrow2">
        <EventLogPanel log={log} d={d} />
        <ConflictsPanel summary={snap?.summary ?? null} />
      </div>
      <p className="smcnote smcdisclaimer">
        SMC Engine v1 — market analysis only. A BOS, CHOCH, FVG or order block alone is not a trade signal; the confluence score is not a probability of winning or expected profit. No orders, no automatic SL / TP.
      </p>
    </main>
  );
}
