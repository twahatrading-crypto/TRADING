import { Diamond } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { HLE_TIMEFRAMES } from '../../engines/highLowEngine/config';
import type { HLETimeframe } from '../../engines/highLowEngine/types';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { HighLowReplaySession } from '../../services/highLowEngine/HighLowReplay';
import { SetupScore, SetupSequence, SignalLog } from './BottomPanels';
import { EngineStatus, TopCards, WorldClock } from './HeaderPanels';
import { HighLowChart, ToolsPanel } from './HighLowChart';
import { hleDecision } from '../../engines/highLowEngine/decision';
import { feedForView, hasData, hleViewState, type HLETools } from './hleView';
import { LevelsDialog, StageCards } from './StageCards';
import { useHighLowState } from './useHighLow';
import '../sr/sr.css';
import './hle.css';

const isTf = (v: unknown): v is HLETimeframe => HLE_TIMEFRAMES.includes(v as HLETimeframe);
const ALL_TOOLS: HLETools = { levels: true, liquidity: true, sweeps: true, structure: true, risk: true };

/** Trading Strategy → High / Low Engine (separate from High / Low Reversal). */
export function HighLowEnginePage() {
  const def = useActiveInstrument();
  return (
    <div className="srapp hle">
      {/* Keyed by instrument: every view state resets on symbol switch — nothing from another symbol lingers. */}
      <Workspace key={def.id} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>High / Low Engine</span>
          <span>{def.displayName}</span>
          <span>A high is not a sell and a low is not a buy. A level is stage one of five; without a liquidity sweep and an M5 structure confirmation that closed, this engine reports WAIT.</span>
          <span>Real closed MT5 candles only · analysis, not advice · no orders are placed</span>
        </div>
      </footer>
    </div>
  );
}

function Workspace() {
  const def = useActiveInstrument();
  const { highLow } = useServices();
  const tz = useDisplayTimeZone();
  const instrument = useMarket((s) => s.instrument);
  const quote = useMarket((s) => s.quote);
  const d = instrument.priceDecimals;
  const connection = useMarket((s) => s.connection);
  const feedCode = useMarket((s) => s.feed?.code ?? null);
  const liveSnap = useHighLowState((s) => s.snapshot);
  const log = useHighLowState((s) => s.log);
  const computedAt = useHighLowState((s) => s.computedAt);
  const [chartTf, setChartTfState] = usePersistentState<HLETimeframe>(`tluxe.hle.chartTf.${def.id}`, 'M15', isTf);
  const [tools, setTools] = useState<HLETools>(ALL_TOOLS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showLevels, setShowLevels] = useState(false);
  const [replay, setReplay] = useState<HighLowReplaySession | null>(null);
  useEffect(() => () => replay?.dispose(), [replay]);
  const replaySnap = useOptionalStore(replay?.store, (s) => s.snapshot, null);

  const snap = replay ? replaySnap : liveSnap;
  const view = hleViewState({ tradable: def.tradable, connection, feedCode, snapshot: snap, replay: !!replay });
  const ok = hasData(view);
  const setups = ok && snap ? snap.setups : [];
  // The published signal: the engine result gated on a LIVE feed (handoff §9). Never confirmed on stale data.
  const decision = snap ? hleDecision(ok ? snap : { ...snap, state: snap.state === 'READY' ? 'INSUFFICIENT_HISTORY' : snap.state }, feedForView(view, connection, feedCode)) : null;
  const selected = setups.find((s) => s.id === selectedId) ?? decision?.setup ?? null;
  const decisionFor = selected && decision?.setup?.id !== selected.id ? { ...decision!, setup: selected, tradeLevels: null } : decision;
  const levels = ok && snap ? snap.levels : [];
  const price = quote.last ?? quote.bid ?? snap?.price ?? null;

  const setChartTf = (tf: HLETimeframe) => {
    setChartTfState(tf);
    replay?.setTimeframe(tf);
  };
  const startReplay = () => {
    const s = highLow.createReplay(chartTf);
    if (s && s.store.getState().total > 0) setReplay(s);
  };
  const exitReplay = () => {
    replay?.dispose();
    setReplay(null);
  };

  return (
    <main className="srmain hlemain">
      <div className="hlehead">
        <div className="hlehead__brand">
          <span className="hlehead__icon" aria-hidden="true"><Diamond size={18} /></span>
          <div>
            <h1 className="hlehead__title">High / Low Engine</h1>
            <p className="hlehead__sub">Find the best buy-low / sell-high setups using multi-timeframe structure and liquidity.</p>
          </div>
        </div>
        <TopCards symbol={instrument.symbol} price={price} change={quote.change} changePct={quote.changePercent} d={d} h4={ok && snap ? snap.h4 : null} h1={ok && snap ? snap.h1 : null} snap={ok ? snap : null} decision={decision} />
      </div>
      <WorldClock />
      <EngineStatus computedAt={liveSnap && liveSnap.state !== 'NO_DATA' ? computedAt : null} tz={tz} />
      <StageCards h4={ok && snap ? snap.h4 : null} levels={levels} decision={decisionFor} setup={selected} d={d} tz={tz} onViewLevels={() => setShowLevels(true)} />
      <div className="hlegrid">
        <HighLowChart chartTf={chartTf} snapshot={snap} selected={ok ? selected : null} decision={decisionFor} viewState={view} tools={tools} replay={replay} onStartReplay={startReplay} onExitReplay={exitReplay} />
        <ToolsPanel tools={tools} onTools={setTools} chartTf={chartTf} onChartTf={setChartTf} />
      </div>
      <div className="hlebottomgrid">
        <SetupSequence snap={ok ? snap : null} decision={decision} />
        <SetupScore s={selected} />
        <SignalLog log={replay ? (snap?.events ?? []) : log} d={d} tz={tz} onSelect={setSelectedId} />
      </div>
      {showLevels && <LevelsDialog levels={levels} d={d} tz={tz} onClose={() => setShowLevels(false)} />}
    </main>
  );
}
