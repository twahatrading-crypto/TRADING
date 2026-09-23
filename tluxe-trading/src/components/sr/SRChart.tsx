import { Camera, ChartCandlestick, Expand, Layers, PencilLine, Play, Settings2, SlidersHorizontal, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import type { SRConfluence, SRSnapshot, SRZone } from '../../engines/sr/types';
import type { SRReplaySession } from '../../services/sr/SRReplay';
import type { Timeframe } from '../../types/market';
import { TimeframeTabs } from '../chart/ChartPanel';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { useOptionalStore, useSRSettings } from './useSR';
import { ReplayBar } from './ReplayBar';
import { chartDrawables, SR_VIEW_TITLE, type SRViewState, type ZoneFilters } from './srView';

interface Props {
  chartTf: Timeframe;
  onChartTf: (tf: Timeframe) => void;
  zones: readonly SRZone[];
  filters: ZoneFilters;
  showZones: boolean;
  onToggleZones: () => void;
  selectedZoneId: string | null;
  confluence: SRConfluence | null;
  onOpenSettings: () => void;
  /** Snapshot of the chart timeframe (live or replay). */
  snapshot: SRSnapshot | undefined;
  viewState: SRViewState;
  replay: SRReplaySession | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
}

export function SRChart(p: Props) {
  const { market } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const snapshot = p.snapshot;
  const [settings] = useSRSettings();
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayBars = useOptionalStore(p.replay?.store, (s) => s.visible, null);
  const replayTime = useOptionalStore(p.replay?.store, (s) => s.knowledgeTime, null);
  const { barCount, controller } = useChartController(market, def.id, p.chartTf, instrument.priceDecimals, containerRef, p.replay ? replayBars : null);
  const liveBars = market.getCandles(def.id, p.chartTf).length;
  const state = p.viewState;

  // Replay: clicking a candle moves the replay clock to that candle's close.
  useEffect(() => {
    const session = p.replay;
    if (!session || !controller) return;
    return controller.onBarClick((t) => {
      if (t === null) return;
      const idx = (session.dataset.candles[session.store.getState().timeframe] ?? []).findIndex((c) => c.time === t);
      if (idx >= 0) session.seek(idx);
    });
  }, [p.replay, controller]);

  const drawables = useMemo(
    () =>
      p.showZones
        ? chartDrawables({ zones: p.zones, filters: p.filters, settings, selectedZoneId: p.selectedZoneId, confluence: p.confluence })
        : [],
    [p.zones, p.filters, settings, p.selectedZoneId, p.confluence, p.showZones],
  );
  useEffect(() => controller?.setZones(drawables), [controller, drawables]);

  const screenshot = () => {
    const canvas = controller?.screenshot();
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `TLUXE_${def.id}_${p.chartTf}_SR.png`;
    a.click();
  };

  const feed = useMarket((s) => s.feed);
  const statusText = p.replay
    ? `REPLAY · ${snapshot?.barsProcessed ?? 0} closed bars known · as of ${replayTime === null ? '—' : new Date(replayTime * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC · live chart frozen`
    : state === 'READY'
      ? `S&R LIVE · ${snapshot?.barsProcessed ?? 0} closed bars analysed${feed?.providerSymbol ? ` · ${feed.providerSymbol}` : ''}`
      : state === 'STALE'
        ? `MARKET DATA STALE · zones from the last ${snapshot?.barsProcessed ?? 0} received closed bars`
      : state === 'INSUFFICIENT_HISTORY' && snapshot && snapshot.barsProcessed > 0
        ? `INSUFFICIENT HISTORY · ${snapshot.barsProcessed}/${snapshot.requiredBars} bars`
        : SR_VIEW_TITLE[state];

  return (
    <section className="panel srchart" aria-labelledby="srchart-title" ref={stageRef}>
      <div className="srchart__toolbar">
        <TimeframeTabs value={p.chartTf} onChange={p.onChartTf} />
        <div className="srchart__tools">
          <button type="button" className="srtool" disabled title="Indicators — later phase">
            <SlidersHorizontal size={15} /> <span>Indicators</span>
          </button>
          <button type="button" className="srtool" aria-pressed={p.showZones} onClick={p.onToggleZones} title="Show / hide S&R zones">
            <Layers size={15} /> <span>S&amp;R</span>
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
            title={p.replay ? 'Exit replay' : liveBars === 0 ? 'Replay needs loaded candle history' : 'Replay history bar by bar (no future data)'}
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
          <button type="button" className="srtool srtool--icon" onClick={p.onOpenSettings} aria-label="S&R settings" title="S&R settings">
            <Settings2 size={15} />
          </button>
        </div>
      </div>
      {p.replay && <ReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <div className="srchart__head">
        <div>
          <h2 id="srchart-title" className="srchart__title">
            {instrument.symbol} · {instrument.name} · {p.chartTf} · {instrument.exchange ?? instrument.venue}
          </h2>
          <div className={`srchart__state ${state === 'READY' ? 'is-ready' : ''} ${p.replay ? 'is-replay' : ''}`} data-testid="sr-chart-state">
            <span className="dot" aria-hidden="true" /> {statusText}
          </div>
        </div>
      </div>
      <div className="srchart__stage">
        <div ref={containerRef} className="chart-canvas" hidden={barCount === 0} />
        {barCount === 0 && (
          <div className="chart-empty">
            <div className="chart-empty__grid" aria-hidden="true" />
            {p.replay ? (
              <EmptyState
                icon={<ChartCandlestick size={18} />}
                title={`NO CLOSED ${p.chartTf} CANDLE YET`}
                message={`At the replay time no ${p.chartTf} candle had closed yet. Step forward or choose a smaller timeframe.`}
                meta="Replay never shows a candle before it closed."
              />
            ) : (
            <EmptyState
              icon={state === 'CATEGORY' ? <ChartCandlestick size={18} /> : <Unplug size={18} />}
              title={state === 'READY' ? 'MARKET DATA NOT CONNECTED' : SR_VIEW_TITLE[state]}
              message={
                state === 'CATEGORY'
                  ? `${instrument.symbol} is a category. S&R runs once a provider maps it to a specific instrument.`
                  : state === 'INSUFFICIENT_HISTORY'
                    ? `Waiting for enough closed ${p.chartTf} candles (${settings.minHistoryBars} required). No zones are shown until then.`
                    : `Connect a market-data provider to analyse ${instrument.symbol}. No simulated candles or zones are displayed.`
              }
              meta="S&R zones are calculated only from real candle history."
            />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
