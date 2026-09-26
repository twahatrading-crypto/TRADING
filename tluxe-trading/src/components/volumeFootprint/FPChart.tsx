import { Expand, Play, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import type { FPCandle, FPTimeframe } from '../../engines/volumeFootprint/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import type { FPReplaySession } from '../../services/volumeFootprint/FPReplay';
import { formatPrice } from '../../utils/format';
import { ChartStage } from '../chart/ChartStage';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { FPReplayBar } from './FPReplayBar';
import { FP_CHART_TFS, FP_VIEW_TITLE, chartCandle, fmtUtc, type FPMarker, type FPRenderData, type FPViewState } from './fpView';

interface Props {
  tf: FPTimeframe;
  onTf: (tf: FPTimeframe) => void;
  candles: readonly FPCandle[];
  render: Omit<FPRenderData, 'candles'>;
  markers: FPMarker[];
  viewState: FPViewState;
  missing: string | null;
  contract: string | null;
  replay: FPReplaySession | null;
  replayTime: number | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
  onSelect: (time: number) => void;
}

/** The LARGE footprint chart: shared ChartStage navigation + a canvas primitive drawing engine rows only. */
export function FPChart(p: Props) {
  const { market, volumeFootprint } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const stageRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bars = useMemo(() => p.candles.map(chartCandle), [p.candles]);
  const { controller } = useChartController(market, def.id, p.tf, d, containerRef, bars);
  const { render, markers, candles } = p;
  useEffect(() => controller?.setFootprint({ ...render, candles }, markers), [controller, render, candles, markers]);
  useEffect(() => {
    if (controller && render.view.autoScale) controller.autoScalePrice();
  }, [controller, render.view.autoScale, candles.length]);
  const { onSelect } = p;
  useEffect(() => {
    if (!controller) return;
    return controller.onBarClick((t) => {
      if (t !== null) onSelect(t);
    });
  }, [controller, onSelect]);
  useEffect(() => p.replay?.setTimeframe(p.tf), [p.replay, p.tf]);
  const last = candles[candles.length - 1] ?? null;
  const unavailable = p.viewState === 'UNAVAILABLE' || p.viewState === 'UNCLASSIFIED';
  return (
    <section className="panel srchart smcchart fpchart" aria-labelledby="fpchart-title" ref={stageRef}>
      <div className="smcchart__head">
        <div className="smctfs" role="tablist" aria-label="Footprint timeframe">
          {FP_CHART_TFS.map((tf) => (
            <button key={tf} type="button" role="tab" aria-selected={tf === p.tf} onClick={() => p.onTf(tf)}>
              {tf}
            </button>
          ))}
        </div>
        <div className="srchart__tools">
          <button type="button" className="srtool" onClick={() => volumeFootprint.refresh()} disabled={!!p.replay} title="Re-aggregate the recorded trades (no extra data request)">
            <RefreshCw size={14} /> <span>Refresh</span>
          </button>
          <button type="button" className="srtool" aria-pressed={!!p.replay} onClick={p.replay ? p.onExitReplay : p.onStartReplay} disabled={!p.replay && volumeFootprint.recording().length === 0} title={p.replay ? 'Exit replay' : 'Replay the recorded trade stream (no future data)'}>
            <Play size={14} /> <span>Replay</span>
          </button>
          <button type="button" className="srtool" onClick={() => void stageRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={14} /> <span>Full Screen</span>
          </button>
        </div>
      </div>
      <div className="smcchart__title">
        <h2 id="fpchart-title" className="srchart__title">
          {p.contract ?? instrument.symbol} · {p.tf} · {def.exchange ?? def.venue}
        </h2>
        <span className="num smcchart__ohlc">{last ? `O ${formatPrice(last.open, d)}  H ${formatPrice(last.high, d)}  L ${formatPrice(last.low, d)}  C ${formatPrice(last.close, d)}  Δ ${last.delta > 0 ? '+' : ''}${last.delta}` : ''}</span>
        <span className={`smcchart__state is-${p.viewState.toLowerCase()}`} data-testid="fp-chart-state">
          <i aria-hidden="true" /> {p.replay ? `REPLAY · as of ${fmtUtc(p.replayTime)} · live frozen` : FP_VIEW_TITLE[p.viewState]}
        </span>
      </div>
      {p.replay && <FPReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <ChartStage containerRef={containerRef} controller={controller} hasBars={candles.length > 0}>
        <div className="chart-empty" data-testid="fp-empty">
          <div className="chart-empty__grid" aria-hidden="true" />
          <EmptyState
            icon={<Unplug size={18} />}
            title={unavailable ? 'FOOTPRINT DATA UNAVAILABLE' : 'WAITING FOR TRADES'}
            message={p.missing ?? 'No footprint candle yet.'}
            meta="A footprint needs genuine exchange time & sales with aggressor side (e.g. Rithmic / T4 / CQG for GC). Footprint cells are never derived from MT5 candles or tick volume."
          />
        </div>
      </ChartStage>
      <p className="smcnote smcchart__foot">Rows: Bid (aggressive sell) × Ask (aggressive buy) per price; gold box = candle POC; outlined cells = imbalances. Zoom in for full numbers — navigation never changes the recorded data.</p>
    </section>
  );
}
