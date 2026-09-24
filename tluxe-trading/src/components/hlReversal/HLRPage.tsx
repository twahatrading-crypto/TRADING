import { useEffect, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { HLR_TIMEFRAMES } from '../../engines/hlReversal/config';
import { hlrClosedOnly, hlrKnownBy } from '../../engines/hlReversal/knowledge';
import type { HLRTimeframe } from '../../engines/hlReversal/types';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { HLRReplaySession } from '../../services/hlReversal/HLRReplay';
import type { Candle } from '../../types/market';
import { fmtUtc } from './format';
import { HLRCards } from './HLRCards';
import { HLRChart } from './HLRChart';
import { MtfPanel, RecentSetupPanel, ScorePanel, SetupDetailsPanel } from './HLRDetails';
import { HLRPanel, type HLRTab } from './HLRPanel';
import { activeSetup, defaultSetup, hasSetups, HLR_VIEW_TITLE, hlrViewState, type SetupFilters } from './hlrView';
import { useHLRState } from './useHLR';
import '../sr/sr.css';
import './hlr.css';

const isTf = (v: unknown): v is HLRTimeframe => HLR_TIMEFRAMES.includes(v as HLRTimeframe);

/** Trading Strategy → High / Low Reversal. Everything shown comes from the High / Low Reversal engine. */
export function HLRPage() {
  const def = useActiveInstrument();
  return (
    <div className="srapp hlr">
      {/* Keyed by instrument: selection, filters and replay reset immediately — nothing from another symbol lingers. */}
      <HLRWorkspace key={def.id} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>High / Low Reversal Engine v1</span>
          <span>{def.displayName}</span>
          <span>Real closed candles only · analysis, not advice · no orders are placed</span>
        </div>
      </footer>
    </div>
  );
}

function HLRWorkspace() {
  const def = useActiveInstrument();
  const { hlReversal, market } = useServices();
  const tz = useDisplayTimeZone();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const connection = useMarket((s) => s.connection);
  const feedCode = useMarket((s) => s.feed?.code ?? null);
  const liveSnap = useHLRState((s) => s.snapshot);

  const [chartTf, setChartTfState] = usePersistentState<HLRTimeframe>(`tluxe.hlr.chartTf.${def.id}`, 'M15', isTf);
  const [filters, setFilters] = useState<SetupFilters>({ dir: 'ALL', tf: 'ALL' });
  const [tab, setTab] = useState<HLRTab>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [replay, setReplay] = useState<HLRReplaySession | null>(null);
  useEffect(() => () => replay?.dispose(), [replay]);
  const replaySnap = useOptionalStore(replay?.store, (s) => s.snapshot, null);
  const replayTime = useOptionalStore(replay?.store, (s) => s.knowledgeTime, null);

  const snap = replay ? replaySnap : liveSnap;
  const viewState = hlrViewState({ tradable: def.tradable, connection, feedCode, snapshot: snap, replay: !!replay });
  const ready = hasSetups(viewState);
  const setups = ready && snap ? snap.setups : [];
  const active = activeSetup(setups);
  const selected = setups.find((s) => s.id === selectedId) ?? defaultSetup(setups);
  const h4 = snap && snap.timeframes.H4.state !== 'NO_DATA' ? snap.h4 : null;

  const setChartTf = (tf: HLRTimeframe) => {
    setChartTfState(tf);
    replay?.setTimeframe(tf);
  };
  const startReplay = () => {
    const s = hlReversal.createReplay(chartTf);
    if (s && s.store.getState().total > 0) setReplay(s);
  };
  const exitReplay = () => {
    replay?.dispose();
    setReplay(null);
  };

  // Snapshot mini-chart: the same closed M5 candles the engine used (replay: only those known at K).
  const m5: readonly Candle[] = replay && replayTime !== null ? hlrKnownBy(replay.dataset.candles.M5 ?? [], 'M5', replayTime) : hlrClosedOnly(market.getCandles(def.id, 'M5'));
  const emptyText = ready ? 'Select a setup in the list.' : `${HLR_VIEW_TITLE[viewState]} — no setups for ${def.shortName}.`;

  return (
    <main className="srmain hlrmain">
      <div className="hlrhead">
        <div>
          <h1 className="hlrhead__title">High / Low Reversal Engine</h1>
          <p className="hlrhead__sub">
            <strong>{instrument.symbol}</strong> {instrument.name}
          </p>
        </div>
        <p className="hlrhead__rule">A high is not automatically a sell · a low is not automatically a buy · no confirmation = WAIT</p>
      </div>
      <HLRCards h4={ready ? h4 : null} levels={ready && snap ? snap.levels : []} setup={ready ? selected : null} price={snap?.price ?? null} d={d} />
      <div className="srgrid hlrgrid">
        <div className="sr-area-chart">
          <HLRChart chartTf={chartTf} onChartTf={setChartTf} snapshot={snap} selected={ready ? selected : null} viewState={viewState} replay={replay} onStartReplay={startReplay} onExitReplay={exitReplay} />
        </div>
        <div className="sr-area-panel">
          <HLRPanel
            tab={tab}
            onTab={setTab}
            viewState={viewState}
            setups={setups}
            events={ready && snap ? snap.events : []}
            active={active}
            decimals={d}
            tz={tz}
            filters={filters}
            onFilters={setFilters}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            symbol={def.shortName}
            replayLabel={replay && replayTime !== null ? `replay as of ${fmtUtc(replayTime)}` : null}
            settings={hlReversal.settings}
          />
        </div>
        <div className="sr-area-details hlrdetails">
          <SetupDetailsPanel s={ready ? selected : null} h4={h4} d={d} tz={tz} emptyText={emptyText} />
          <ScorePanel s={ready ? selected : null} h4={ready ? h4 : null} d={d} />
          <MtfPanel s={ready ? selected : null} h4={ready ? h4 : null} d={d} />
          <RecentSetupPanel s={ready ? selected : null} m5={m5} d={d} tz={tz} />
        </div>
      </div>
    </main>
  );
}
