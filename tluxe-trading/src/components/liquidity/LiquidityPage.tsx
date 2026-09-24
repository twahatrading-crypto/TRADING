import { useEffect, useMemo, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../config/instrument';
import { nearestLiquidity } from '../../engines/liquidity/mtf';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { LiquidityReplaySession } from '../../services/liquidity/LiquidityReplay';
import type { Timeframe } from '../../types/market';
import { BrandHero } from '../branding/BrandHero';
import { fmtUtc } from './format';
import { LiquidityChart } from './LiquidityChart';
import { LiquidityDetailsPanel, MtfLiquidityPanel, RecentSweepPanel, StrengthComponentsPanel } from './LiquidityDetails';
import { LiquidityPanel, type LiquidityTab } from './LiquidityPanel';
import { hasPools, latestSweep, LIQUIDITY_VIEW_TITLE, liquidityViewState, type PoolFilters, type PoolSortKey } from './liquidityView';
import { useLiquidityState } from './useLiquidity';
import '../sr/sr.css';
import './liquidity.css';

const isTf = (v: unknown): v is Timeframe => TIMEFRAMES.includes(v as Timeframe);

/** Trading Strategy → Liquidity. All pools come from the Liquidity service (engine snapshots). */
export function LiquidityPage() {
  const def = useActiveInstrument();
  return (
    <div className="srapp lq">
      {/* Keyed by instrument: selection/filters reset, so nothing from another symbol can linger. */}
      <LiquidityWorkspace key={def.id} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>Liquidity Engine v1</span>
          <span>{def.displayName}</span>
          <span>Real candles only · not order-book depth · no trade signals</span>
        </div>
      </footer>
    </div>
  );
}

function LiquidityWorkspace() {
  const def = useActiveInstrument();
  const { liquidity } = useServices();
  const tz = useDisplayTimeZone();
  const decimals = useMarket((s) => s.instrument.priceDecimals);
  const connection = useMarket((s) => s.connection);
  const feedCode = useMarket((s) => s.feed?.code ?? null);
  const liveMulti = useLiquidityState((s) => s.multi);
  const liveByTf = useLiquidityState((s) => s.byTimeframe);

  const [chartTf, setChartTfState] = usePersistentState<Timeframe>(`tluxe.lq.chartTf.${def.id}`, DEFAULT_TIMEFRAME, isTf);
  const [filters, setFilters] = useState<PoolFilters>({ side: 'all', tf: 'ALL', state: 'ALL' });
  const [sort, setSort] = useState<PoolSortKey>('relevance');
  const [showAll, setShowAll] = useState(false);
  const [showPools, setShowPools] = useState(true);
  const [tab, setTab] = useState<LiquidityTab>('pools');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);

  // Liquidity replay: own session + engines (independent of S&R Replay and of the live service).
  const [replay, setReplay] = useState<LiquidityReplaySession | null>(null);
  useEffect(() => () => replay?.dispose(), [replay]);
  const replayMulti = useOptionalStore(replay?.store, (s) => s.multi, null);
  const replayByTf = useOptionalStore(replay?.store, (s) => s.byTimeframe, null);
  const replayTime = useOptionalStore(replay?.store, (s) => s.knowledgeTime, null);
  const replayPrice = useOptionalStore(replay?.store, (s) => s.price, null);
  const livePrice = useMarket((s) => s.quote.last ?? s.quote.bid);

  const multi = replay ? replayMulti : liveMulti;
  const byTf = (replay ? replayByTf : liveByTf) ?? {};
  const pools = useMemo(() => multi?.pools ?? [], [multi]);
  const clusters = useMemo(() => multi?.clusters ?? [], [multi]);
  const viewState = liquidityViewState({
    tradable: def.tradable,
    connection,
    feedCode,
    snapshots: filters.tf === 'ALL' ? TIMEFRAMES.map((tf) => byTf[tf]) : [byTf[filters.tf]],
    replay: !!replay,
  });
  const chartState = liquidityViewState({ tradable: def.tradable, connection, feedCode, snapshots: [byTf[chartTf]], replay: !!replay });
  const ready = hasPools(viewState);

  const setChartTf = (tf: Timeframe) => {
    setChartTfState(tf);
    replay?.setTimeframe(tf);
  };
  const startReplay = () => {
    const s = liquidity.createReplay(chartTf);
    if (s && s.store.getState().total > 0) setReplay(s);
  };
  const exitReplay = () => {
    replay?.dispose();
    setReplay(null);
  };

  const pool = pools.find((p) => p.id === selectedId) ?? null;
  const cluster = clusters.find((c) => c.id === selectedClusterId) ?? (pool ? (clusters.find((c) => c.poolIds.includes(pool.id)) ?? null) : null);
  const price = replay ? replayPrice : (livePrice ?? byTf[chartTf]?.currentPrice ?? null);
  const nearest = ready ? nearestLiquidity(pools, price) : { above: null, below: null };
  const latest = ready ? latestSweep(pools.filter((p) => filters.tf === 'ALL' || p.timeframe === filters.tf)) : null;
  const emptyText = ready ? 'Select a pool in the table to see its details.' : `${LIQUIDITY_VIEW_TITLE[viewState]} — no liquidity for ${def.shortName}.`;
  const replayLabel = replay && replayTime !== null ? `replay as of ${fmtUtc(replayTime)}` : null;

  return (
    <main className="srmain">
      <div className="srmain__top">
        <div className="srhero-wrap">
          <BrandHero />
        </div>
      </div>
      <div className="srgrid lqgrid">
        <div className="sr-area-chart">
          <LiquidityChart
            chartTf={chartTf}
            onChartTf={setChartTf}
            pools={ready ? pools : []}
            snapshot={byTf[chartTf]}
            viewState={chartState}
            filters={filters}
            settings={liquidity.settings}
            showPools={showPools}
            onTogglePools={() => setShowPools((v) => !v)}
            selectedId={selectedId}
            cluster={cluster}
            nearest={nearest}
            replay={replay}
            onStartReplay={startReplay}
            onExitReplay={exitReplay}
          />
        </div>
        <div className="sr-area-panel">
          <LiquidityPanel
            tab={tab}
            onTab={setTab}
            viewState={viewState}
            pools={pools}
            clusters={clusters}
            byTimeframe={byTf}
            decimals={decimals}
            tz={tz}
            filters={filters}
            onFilters={(f) => {
              setFilters(f);
              setShowAll(false);
            }}
            sort={sort}
            onSort={setSort}
            showAll={showAll}
            onShowAll={setShowAll}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setSelectedClusterId(null);
            }}
            selectedClusterId={selectedClusterId}
            onSelectCluster={(id) => setSelectedClusterId((c) => (c === id ? null : id))}
            symbol={def.shortName}
            replayLabel={replayLabel}
            settings={liquidity.settings}
          />
        </div>
        <div className="sr-area-details lqdetails">
          <LiquidityDetailsPanel pool={pool} decimals={decimals} tz={tz} emptyText={emptyText} />
          <StrengthComponentsPanel pool={pool} />
          <MtfLiquidityPanel pool={pool} pools={pools} clusters={clusters} decimals={decimals} onSelect={setSelectedId} />
          <RecentSweepPanel latest={latest} decimals={decimals} tz={tz} />
        </div>
      </div>
    </main>
  );
}
