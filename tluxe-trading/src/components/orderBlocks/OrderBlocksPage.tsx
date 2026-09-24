import { useEffect, useMemo, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../config/instrument';
import { obKnownBy } from '../../engines/orderBlocks/knowledge';
import { nearestBlocks } from '../../engines/orderBlocks/mtf';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { OrderBlockReplaySession } from '../../services/orderBlocks/OrderBlockReplay';
import type { Candle, Timeframe } from '../../types/market';
import { BrandHero } from '../branding/BrandHero';
import { fmtUtc } from './format';
import { hasBlocks, mitigationEvents, OB_VIEW_TITLE, obViewState, type BlockFilters, type BlockSortKey } from './obView';
import { OrderBlockChart } from './OrderBlockChart';
import { MtfOrderBlocksPanel, OrderBlockDetailsPanel, RecentMitigationPanel, ScoreComponentsPanel } from './OrderBlockDetails';
import { OrderBlockPanel, type OBTab } from './OrderBlockPanel';
import { useOrderBlockSettings, useOrderBlockState } from './useOrderBlocks';
import '../sr/sr.css';
import './orderBlocks.css';

const isTf = (v: unknown): v is Timeframe => TIMEFRAMES.includes(v as Timeframe);

/** Trading Strategy → Order Blocks. All blocks come from the Order Block service (engine snapshots). */
export function OrderBlocksPage() {
  const def = useActiveInstrument();
  return (
    <div className="srapp ob">
      {/* Keyed by instrument: selection, filters and replay reset — nothing from another symbol can linger. */}
      <OrderBlockWorkspace key={def.id} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>Order Block Engine v1</span>
          <span>{def.displayName}</span>
          <span>Real closed candles only · no trade signals</span>
        </div>
      </footer>
    </div>
  );
}

function OrderBlockWorkspace() {
  const def = useActiveInstrument();
  const { orderBlocks, market } = useServices();
  const tz = useDisplayTimeZone();
  const decimals = useMarket((s) => s.instrument.priceDecimals);
  const connection = useMarket((s) => s.connection);
  const feedCode = useMarket((s) => s.feed?.code ?? null);
  const settings = useOrderBlockSettings();
  const liveMulti = useOrderBlockState((s) => s.multi);
  const liveByTf = useOrderBlockState((s) => s.byTimeframe);

  const [chartTf, setChartTfState] = usePersistentState<Timeframe>(`tluxe.ob.chartTf.${def.id}`, DEFAULT_TIMEFRAME, isTf);
  const [filters, setFilters] = useState<BlockFilters>({ type: 'all', tf: 'ALL', state: 'ALL' });
  const [sort, setSort] = useState<BlockSortKey>('relevance');
  const [showAll, setShowAll] = useState(false);
  const [showBlocks, setShowBlocks] = useState(true);
  const [tab, setTab] = useState<OBTab>('blocks');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConfluenceId, setSelectedConfluenceId] = useState<string | null>(null);

  // Order Block replay: own session + engines (independent of S&R / Liquidity replay and of the live service).
  const [replay, setReplay] = useState<OrderBlockReplaySession | null>(null);
  useEffect(() => () => replay?.dispose(), [replay]);
  const replayMulti = useOptionalStore(replay?.store, (s) => s.multi, null);
  const replayByTf = useOptionalStore(replay?.store, (s) => s.byTimeframe, null);
  const replayTime = useOptionalStore(replay?.store, (s) => s.knowledgeTime, null);
  const replayPrice = useOptionalStore(replay?.store, (s) => s.price, null);
  const livePrice = useMarket((s) => s.quote.last ?? s.quote.bid);

  const multi = replay ? replayMulti : liveMulti;
  const byTf = (replay ? replayByTf : liveByTf) ?? {};
  const blocks = useMemo(() => multi?.blocks ?? [], [multi]);
  const confluences = useMemo(() => multi?.confluences ?? [], [multi]);
  const viewState = obViewState({
    tradable: def.tradable,
    connection,
    feedCode,
    snapshots: filters.tf === 'ALL' ? TIMEFRAMES.map((tf) => byTf[tf]) : [byTf[filters.tf]],
    replay: !!replay,
  });
  const chartState = obViewState({ tradable: def.tradable, connection, feedCode, snapshots: [byTf[chartTf]], replay: !!replay });
  const ready = hasBlocks(viewState);

  const setChartTf = (tf: Timeframe) => {
    setChartTfState(tf);
    replay?.setTimeframe(tf);
  };
  const startReplay = () => {
    const s = orderBlocks.createReplay(chartTf);
    if (s && s.store.getState().total > 0) setReplay(s);
  };
  const exitReplay = () => {
    replay?.dispose();
    setReplay(null);
  };

  const block = blocks.find((b) => b.id === selectedId) ?? null;
  const confluence = confluences.find((c) => c.id === selectedConfluenceId) ?? (block ? (confluences.find((c) => c.blockIds.includes(block.id)) ?? null) : null);
  const price = replay ? replayPrice : (livePrice ?? byTf[chartTf]?.currentPrice ?? null);
  const nearest = ready ? nearestBlocks(blocks, price) : { above: null, below: null };
  const latest = ready ? (mitigationEvents(blocks.filter((b) => filters.tf === 'ALL' || b.timeframe === filters.tf))[0] ?? null) : null;
  // Excerpt candles: the block's own timeframe, closed candles known at the (replay) time only.
  const excerptTf = latest?.block.timeframe ?? null;
  const excerpt: readonly Candle[] = !latest || !excerptTf
    ? []
    : replay && replayTime !== null
      ? obKnownBy(replay.dataset.candles[excerptTf] ?? [], excerptTf, replayTime)
      : market.getCandles(def.id, excerptTf).filter((c) => c.time <= (byTf[excerptTf]?.lastClosedTime ?? -Infinity));
  const emptyText = ready ? 'Select an order block in the table to see its details.' : `${OB_VIEW_TITLE[viewState]} — no order blocks for ${def.shortName}.`;
  const replayLabel = replay && replayTime !== null ? `replay as of ${fmtUtc(replayTime)}` : null;

  return (
    <main className="srmain">
      <div className="srmain__top">
        <div className="srhero-wrap">
          <BrandHero />
        </div>
      </div>
      <div className="srgrid obgrid">
        <div className="sr-area-chart">
          <OrderBlockChart
            chartTf={chartTf}
            onChartTf={setChartTf}
            blocks={ready ? blocks : []}
            snapshot={byTf[chartTf]}
            viewState={chartState}
            filters={filters}
            settings={settings}
            showBlocks={showBlocks}
            onToggleBlocks={() => setShowBlocks((v) => !v)}
            selectedId={selectedId}
            confluence={confluence}
            nearest={nearest}
            replay={replay}
            onStartReplay={startReplay}
            onExitReplay={exitReplay}
          />
        </div>
        <div className="sr-area-panel">
          <OrderBlockPanel
            tab={tab}
            onTab={setTab}
            viewState={viewState}
            blocks={blocks}
            confluences={confluences}
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
              setSelectedConfluenceId(null);
            }}
            selectedConfluenceId={selectedConfluenceId}
            onSelectConfluence={(id) => setSelectedConfluenceId((c) => (c === id ? null : id))}
            symbol={def.shortName}
            replayLabel={replayLabel}
            settings={settings}
            onBoundaryMode={(boundaryMode) => {
              setSelectedId(null);
              setSelectedConfluenceId(null);
              orderBlocks.configure({ boundaryMode });
            }}
            settingsLocked={!!replay}
          />
        </div>
        <div className="sr-area-details obdetails">
          <OrderBlockDetailsPanel block={block} decimals={decimals} tz={tz} emptyText={emptyText} />
          <ScoreComponentsPanel block={block} />
          <MtfOrderBlocksPanel block={block} blocks={blocks} confluences={confluences} decimals={decimals} onSelect={setSelectedId} />
          <RecentMitigationPanel latest={latest} candles={excerpt} decimals={decimals} tz={tz} />
        </div>
      </div>
    </main>
  );
}
