import { Boxes, Camera, ChartCandlestick, Expand, Play, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import type { OBSettings } from '../../engines/orderBlocks/config';
import type { OBConfluence, OBSnapshot, OrderBlock } from '../../engines/orderBlocks/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import type { OrderBlockReplaySession } from '../../services/orderBlocks/OrderBlockReplay';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { TimeframeTabs } from '../chart/ChartPanel';
import { ChartStage } from '../chart/ChartStage';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { fmtUtc } from './format';
import { OB_VIEW_TITLE, obDrawables, typeShort, type BlockFilters, type OBViewState } from './obView';
import { OrderBlockReplayBar } from './OrderBlockReplayBar';

interface Props {
  chartTf: Timeframe;
  onChartTf: (tf: Timeframe) => void;
  blocks: readonly OrderBlock[];
  snapshot: OBSnapshot | undefined;
  viewState: OBViewState;
  filters: BlockFilters;
  settings: OBSettings;
  showBlocks: boolean;
  onToggleBlocks: () => void;
  selectedId: string | null;
  confluence: OBConfluence | null;
  nearest: { above: OrderBlock | null; below: OrderBlock | null };
  replay: OrderBlockReplaySession | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
}

export function OrderBlockChart(p: Props) {
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
    () => (p.showBlocks ? obDrawables({ blocks: p.blocks, filters: p.filters, settings: p.settings, selectedId: p.selectedId, confluence: p.confluence }) : []),
    [p.blocks, p.filters, p.settings, p.selectedId, p.confluence, p.showBlocks],
  );
  useEffect(() => controller?.setOrderBlocks(drawables), [controller, drawables]);

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
    a.download = `TLUXE_${def.id}_${p.chartTf}_ORDER_BLOCKS.png`;
    a.click();
  };

  const snap = p.snapshot;
  const statusText = p.replay
    ? `ORDER BLOCKS REPLAY · ${snap?.barsProcessed ?? 0} closed bars known · as of ${fmtUtc(replayTime)} · live chart frozen`
    : p.viewState === 'LIVE'
      ? `ORDER BLOCKS LIVE · ${snap?.barsProcessed ?? 0} closed bars analysed${feed?.providerSymbol ? ` · ${feed.providerSymbol}` : ''}`
      : p.viewState === 'STALE'
        ? `DATA STALE · blocks from the last ${snap?.barsProcessed ?? 0} received closed bars — not live`
        : p.viewState === 'INSUFFICIENT_HISTORY' && snap && snap.barsProcessed > 0
          ? `INSUFFICIENT HISTORY · ${snap.barsProcessed}/${snap.requiredBars} bars`
          : OB_VIEW_TITLE[p.viewState];

  const near = (b: OrderBlock | null, label: string, side: 'above' | 'below') => (
    <div className={`obnear obnear--${side}`} data-testid={`ob-nearest-${side}`}>
      <span className="obnear__label">{label}</span>
      {b ? (
        <>
          <strong className="num">{formatPrice(b.low, d)} – {formatPrice(b.high, d)}</strong>
          <span>{typeShort(b.type)} {b.timeframe}</span>
          <span className="obnear__score num">{b.score.total}</span>
        </>
      ) : (
        <span className="srmuted">—</span>
      )}
    </div>
  );

  return (
    <section className="panel srchart obchart" aria-labelledby="obchart-title" ref={stageRef}>
      <div className="srchart__toolbar">
        <TimeframeTabs value={p.chartTf} onChange={p.onChartTf} />
        <div className="srchart__tools">
          <button type="button" className="srtool" aria-pressed={p.showBlocks} onClick={p.onToggleBlocks} title="Show / hide order blocks">
            <Boxes size={15} /> <span>Blocks</span>
          </button>
          <button
            type="button"
            className="srtool"
            aria-pressed={!!p.replay}
            onClick={p.replay ? p.onExitReplay : p.onStartReplay}
            disabled={!p.replay && liveBars === 0}
            title={p.replay ? 'Exit replay' : liveBars === 0 ? 'Replay needs loaded candle history' : 'Replay order blocks bar by bar (no future data)'}
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
      {p.replay && <OrderBlockReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <div className="srchart__head obchart__head">
        <div>
          <h2 id="obchart-title" className="srchart__title">
            {instrument.symbol} · {instrument.name} · {p.chartTf} · Order Blocks
          </h2>
          <div className={`srchart__state ${p.viewState === 'LIVE' ? 'is-ready' : ''} ${p.replay ? 'is-replay' : ''}`} data-testid="ob-chart-state">
            <span className="dot" aria-hidden="true" /> {statusText}
          </div>
        </div>
        <div className="obnearwrap" aria-label="Nearest live order blocks (context only)">
          {near(p.nearest.above, 'ABOVE', 'above')}
          {near(p.nearest.below, 'BELOW', 'below')}
        </div>
      </div>
      <ChartStage containerRef={containerRef} controller={controller} hasBars={barCount > 0}>
        <div className="chart-empty">
          <div className="chart-empty__grid" aria-hidden="true" />
          {p.replay ? (
            <EmptyState icon={<ChartCandlestick size={18} />} title={`NO CLOSED ${p.chartTf} CANDLE YET`} message={`At the replay time no ${p.chartTf} candle had closed yet.`} meta="Replay never shows a candle before it closed." />
          ) : (
            <EmptyState
              icon={p.viewState === 'UNAVAILABLE' ? <ChartCandlestick size={18} /> : <Unplug size={18} />}
              title={p.viewState === 'LIVE' ? 'MARKET DATA NOT CONNECTED' : OB_VIEW_TITLE[p.viewState]}
              message={
                p.viewState === 'UNAVAILABLE'
                  ? `${instrument.symbol} is a category. Order Blocks run once a provider maps it to a specific instrument.`
                  : `Connect a market-data provider to analyse ${instrument.symbol}. No simulated candles or order blocks are displayed.`
              }
              meta="Order Blocks v1 uses real closed candles only and never produces trade signals."
            />
          )}
        </div>
      </ChartStage>
    </section>
  );
}
