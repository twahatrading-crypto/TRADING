import { Camera, ChartCandlestick, Droplets, Expand, PencilLine, Play, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import type { LiquiditySettings } from '../../engines/liquidity/config';
import type { LiquidityCluster, LiquidityPool, LiquiditySnapshot } from '../../engines/liquidity/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import type { LiquidityReplaySession } from '../../services/liquidity/LiquidityReplay';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { TimeframeTabs } from '../chart/ChartPanel';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { fmtUtc } from './format';
import { LiquidityReplayBar } from './LiquidityReplayBar';
import { LIQUIDITY_VIEW_TITLE, liquidityDrawables, liquidityMarkers, type LiquidityViewState, type PoolFilters } from './liquidityView';

interface Props {
  chartTf: Timeframe;
  onChartTf: (tf: Timeframe) => void;
  pools: readonly LiquidityPool[];
  snapshot: LiquiditySnapshot | undefined;
  viewState: LiquidityViewState;
  filters: PoolFilters;
  settings: LiquiditySettings;
  showPools: boolean;
  onTogglePools: () => void;
  selectedId: string | null;
  cluster: LiquidityCluster | null;
  nearest: { above: LiquidityPool | null; below: LiquidityPool | null };
  replay: LiquidityReplaySession | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
}

export function LiquidityChart(p: Props) {
  const { market } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const feed = useMarket((s) => s.feed);
  const d = instrument.priceDecimals;
  const stageRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayBars = useOptionalStore(p.replay?.store, (s) => s.visible, null);
  const replayTime = useOptionalStore(p.replay?.store, (s) => s.knowledgeTime, null);
  const { barCount, controller } = useChartController(market, def.id, p.chartTf, d, containerRef, p.replay ? replayBars : null);
  const liveBars = market.getCandles(def.id, p.chartTf).length;

  const drawables = useMemo(
    () => (p.showPools ? liquidityDrawables({ pools: p.pools, filters: p.filters, settings: p.settings, selectedId: p.selectedId, cluster: p.cluster }) : []),
    [p.pools, p.filters, p.settings, p.selectedId, p.cluster, p.showPools],
  );
  const markers = useMemo(
    () => (p.showPools ? liquidityMarkers(p.pools, p.chartTf, { poolIds: new Set([...drawables.map((x) => x.id), ...(p.selectedId ? [p.selectedId] : [])]) }) : []),
    [p.pools, p.chartTf, p.showPools, drawables, p.selectedId],
  );
  useEffect(() => controller?.setLiquidity(drawables), [controller, drawables]);
  useEffect(() => controller?.setEventMarkers(markers), [controller, markers]);

  useEffect(() => {
    const session = p.replay;
    if (!session || !controller) return;
    return controller.onBarClick((t) => {
      if (t === null) return;
      const idx = (session.dataset.candles[session.store.getState().timeframe] ?? []).findIndex((c) => c.time === t);
      if (idx >= 0) session.seek(idx);
    });
  }, [p.replay, controller]);

  const screenshot = () => {
    const canvas = controller?.screenshot();
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `TLUXE_${def.id}_${p.chartTf}_LIQUIDITY.png`;
    a.click();
  };

  const snap = p.snapshot;
  const statusText = p.replay
    ? `LIQUIDITY REPLAY · ${snap?.barsProcessed ?? 0} closed bars known · as of ${fmtUtc(replayTime)} · live chart frozen`
    : p.viewState === 'LIVE'
      ? `LIQUIDITY LIVE · ${snap?.barsProcessed ?? 0} closed bars analysed${feed?.providerSymbol ? ` · ${feed.providerSymbol}` : ''}`
      : p.viewState === 'STALE'
        ? `DATA STALE · pools from the last ${snap?.barsProcessed ?? 0} received closed bars — not live`
        : p.viewState === 'INSUFFICIENT_HISTORY' && snap && snap.barsProcessed > 0
          ? `INSUFFICIENT HISTORY · ${snap.barsProcessed}/${snap.requiredBars} bars`
          : LIQUIDITY_VIEW_TITLE[p.viewState];

  const near = (pool: LiquidityPool | null, label: string, side: 'bsl' | 'ssl') => (
    <div className={`lqnear lqnear--${side}`} data-testid={`nearest-${side}`}>
      <span className="lqnear__label">{label}</span>
      {pool ? (
        <>
          <strong className="num">{formatPrice(pool.level, d)}</strong>
          <span className="num">{pool.distance === null ? '—' : `${pool.distance >= 0 ? '+' : ''}${formatPrice(pool.distance, d)}`}</span>
          <span>{pool.timeframe}</span>
          <span className="lqnear__score num">{pool.score.total}</span>
        </>
      ) : (
        <span className="srmuted">—</span>
      )}
    </div>
  );

  return (
    <section className="panel srchart lqchart" aria-labelledby="lqchart-title" ref={stageRef}>
      <div className="srchart__toolbar">
        <TimeframeTabs value={p.chartTf} onChange={p.onChartTf} />
        <div className="srchart__tools">
          <button type="button" className="srtool" aria-pressed={p.showPools} onClick={p.onTogglePools} title="Show / hide liquidity">
            <Droplets size={15} /> <span>Liquidity</span>
          </button>
          <button type="button" className="srtool" disabled title="Drawing tools — later phase">
            <PencilLine size={15} /> <span>Draw</span>
          </button>
          <button
            type="button"
            className="srtool"
            aria-pressed={!!p.replay}
            onClick={p.replay ? p.onExitReplay : p.onStartReplay}
            disabled={!p.replay && liveBars === 0}
            title={p.replay ? 'Exit replay' : liveBars === 0 ? 'Replay needs loaded candle history' : 'Replay liquidity bar by bar (no future data)'}
          >
            <Play size={15} /> <span>Replay</span>
          </button>
          <span className="srtool__sep" aria-hidden="true" />
          <button type="button" className="srtool srtool--icon" onClick={screenshot} disabled={!controller} aria-label="Save chart image" title="Save chart image">
            <Camera size={15} />
          </button>
          <button type="button" className="srtool srtool--icon" onClick={() => void stageRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={15} />
          </button>
        </div>
      </div>
      {p.replay && <LiquidityReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <div className="srchart__head lqchart__head">
        <div>
          <h2 id="lqchart-title" className="srchart__title">
            {instrument.symbol} · {instrument.name} · {p.chartTf} · Liquidity
          </h2>
          <div className={`srchart__state ${p.viewState === 'LIVE' ? 'is-ready' : ''} ${p.replay ? 'is-replay' : ''}`} data-testid="lq-chart-state">
            <span className="dot" aria-hidden="true" /> {statusText}
          </div>
        </div>
        <div className="lqnearwrap" aria-label="Nearest liquidity (context only)">
          {near(p.nearest.above, 'BSL ABOVE', 'bsl')}
          {near(p.nearest.below, 'SSL BELOW', 'ssl')}
        </div>
      </div>
      <div className="srchart__stage">
        <div ref={containerRef} className="chart-canvas" hidden={barCount === 0} />
        {barCount === 0 && (
          <div className="chart-empty">
            <div className="chart-empty__grid" aria-hidden="true" />
            {p.replay ? (
              <EmptyState icon={<ChartCandlestick size={18} />} title={`NO CLOSED ${p.chartTf} CANDLE YET`} message={`At the replay time no ${p.chartTf} candle had closed yet.`} meta="Replay never shows a candle before it closed." />
            ) : (
              <EmptyState
                icon={p.viewState === 'UNAVAILABLE' ? <ChartCandlestick size={18} /> : <Unplug size={18} />}
                title={p.viewState === 'LIVE' ? 'MARKET DATA NOT CONNECTED' : LIQUIDITY_VIEW_TITLE[p.viewState]}
                message={
                  p.viewState === 'UNAVAILABLE'
                    ? `${instrument.symbol} is a category. Liquidity runs once a provider maps it to a specific instrument.`
                    : `Connect a market-data provider to analyse ${instrument.symbol}. No simulated candles or liquidity are displayed.`
                }
                meta="Liquidity v1 uses real candles only. It is not order-book (Level-2) liquidity."
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
