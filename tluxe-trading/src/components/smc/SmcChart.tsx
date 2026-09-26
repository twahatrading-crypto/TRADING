import { ChartCandlestick, Expand, Play, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import type { SmcSnapshot } from '../../engines/smc/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import type { SmcReplaySession } from '../../services/smc/SmcReplay';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { ChartStage } from '../chart/ChartStage';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { SmcReplayBar } from './SmcReplayBar';
import { SMC_CHART_TFS, SMC_VIEW_TITLE, fmtUtc, smcOverlays, type SmcToggles, type SmcViewState } from './smcView';

interface Props {
  chartTf: Timeframe;
  onChartTf: (tf: Timeframe) => void;
  snapshot: SmcSnapshot | null;
  toggles: SmcToggles;
  viewState: SmcViewState;
  replay: SmcReplaySession | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
}

/** The main SMC chart: real candles of the chart timeframe + overlays built ONLY from engine output. */
export function SmcChart(p: Props) {
  const { market, smc } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const stageRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayBars = useOptionalStore(p.replay?.store, (s) => s.visible, null);
  const replayTime = useOptionalStore(p.replay?.store, (s) => s.knowledgeTime, null);
  const { barCount, controller, lastBar } = useChartController(market, def.id, p.chartTf, d, containerRef, p.replay ? replayBars : null);
  const liveBars = market.getCandles(def.id, p.chartTf).length;
  const ready = p.viewState === 'LIVE' || p.viewState === 'STALE' || p.viewState === 'REPLAY' || p.viewState === 'INSUFFICIENT_DATA';
  const overlay = useMemo(() => (ready ? smcOverlays({ snapshot: p.snapshot, chartTf: p.chartTf, toggles: p.toggles, decimals: d }) : { drawables: [], markers: [] }), [ready, p.snapshot, p.chartTf, p.toggles, d]);
  useEffect(() => controller?.setSmc(overlay.drawables, overlay.markers), [controller, overlay]);
  useEffect(() => {
    const session = p.replay;
    if (!session || !controller) return;
    return controller.onBarClick((t) => {
      if (t === null) return;
      const idx = (session.dataset.candles[session.store.getState().timeframe] ?? []).findIndex((c) => c.time === t);
      if (idx >= 0) session.seek(idx);
    });
  }, [p.replay, controller]);
  useEffect(() => p.replay?.setTimeframe(p.chartTf), [p.replay, p.chartTf]);
  const bar = p.replay ? (replayBars?.at(-1) ?? null) : lastBar;
  const chg = bar ? bar.close - bar.open : null;
  return (
    <section className="panel srchart smcchart" aria-labelledby="smcchart-title" ref={stageRef}>
      <div className="smcchart__head">
        <div className="smctfs" role="tablist" aria-label="Chart timeframe">
          {SMC_CHART_TFS.map((tf) => (
            <button key={tf} type="button" role="tab" aria-selected={tf === p.chartTf} onClick={() => p.onChartTf(tf)}>
              {tf}
            </button>
          ))}
        </div>
        <div className="srchart__tools">
          <button type="button" className="srtool" onClick={() => smc.refresh()} disabled={!!p.replay} title="Re-run the SMC analysis from the loaded candles (no extra data request)">
            <RefreshCw size={14} /> <span>Refresh</span>
          </button>
          <button type="button" className="srtool" aria-pressed={!!p.replay} onClick={p.replay ? p.onExitReplay : p.onStartReplay} disabled={!p.replay && liveBars === 0} title={p.replay ? 'Exit replay' : 'Replay candle by candle (no future data)'}>
            <Play size={14} /> <span>Replay</span>
          </button>
          <button type="button" className="srtool" onClick={() => void stageRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={14} /> <span>Full Screen</span>
          </button>
        </div>
      </div>
      <div className="smcchart__title">
        <h2 id="smcchart-title" className="srchart__title">
          {instrument.symbol} · {p.chartTf}
        </h2>
        <span className="num smcchart__ohlc">
          {bar ? `O ${formatPrice(bar.open, d)}  H ${formatPrice(bar.high, d)}  L ${formatPrice(bar.low, d)}  C ${formatPrice(bar.close, d)}  ${chg !== null ? `${chg >= 0 ? '+' : ''}${formatPrice(chg, d)}` : ''}` : ''}
        </span>
        <span className={`smcchart__state is-${p.viewState.toLowerCase()}`} data-testid="smc-chart-state">
          <i aria-hidden="true" /> {p.replay ? `REPLAY · as of ${fmtUtc(replayTime)} · live chart frozen` : SMC_VIEW_TITLE[p.viewState]}
        </span>
      </div>
      {p.replay && <SmcReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <ChartStage containerRef={containerRef} controller={controller} hasBars={barCount > 0}>
        <div className="chart-empty">
          <div className="chart-empty__grid" aria-hidden="true" />
          <EmptyState
            icon={p.viewState === 'UNAVAILABLE' ? <Unplug size={18} /> : <ChartCandlestick size={18} />}
            title={SMC_VIEW_TITLE[p.viewState === 'LIVE' ? 'UNAVAILABLE' : p.viewState]}
            message={`Connect MT5 through the TLUXE bridge to analyse ${instrument.symbol}. No simulated candles or SMC objects are ever shown.`}
            meta="SMC uses real closed D1 · H4 · H1 · M30 · M15 · M5 · M1 candles only."
          />
        </div>
      </ChartStage>
      <p className="smcnote smcchart__foot">Every overlay is an engine object (toggle on the right). Navigation only changes the view — it never recalculates the engine.</p>
    </section>
  );
}
