import { Camera, ChartCandlestick, Expand, Play, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import { HLR_TIMEFRAMES } from '../../engines/hlReversal/config';
import type { HLRSnapshot, HLRTimeframe, Setup } from '../../engines/hlReversal/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import type { HLRReplaySession } from '../../services/hlReversal/HLRReplay';
import { ChartStage } from '../chart/ChartStage';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { fmtUtc } from './format';
import { HLR_VIEW_TITLE, hlrOverlays, missingTimeframes, type HLRViewState } from './hlrView';
import { HLRReplayBar } from './HLRReplayBar';

interface Props {
  chartTf: HLRTimeframe;
  onChartTf: (tf: HLRTimeframe) => void;
  snapshot: HLRSnapshot | null;
  selected: Setup | null;
  viewState: HLRViewState;
  replay: HLRReplaySession | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
}

export function HLRChart(p: Props) {
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
  const ready = p.viewState === 'LIVE' || p.viewState === 'STALE' || p.viewState === 'REPLAY';

  const overlay = useMemo(
    () => (ready && p.snapshot ? hlrOverlays({ levels: p.snapshot.levels, setups: p.snapshot.setups, selected: p.selected, price: p.snapshot.price, chartTf: p.chartTf, decimals: d }) : { drawables: [], markers: [] }),
    [ready, p.snapshot, p.selected, p.chartTf, d],
  );
  useEffect(() => controller?.setHighLowReversal(overlay.drawables, overlay.markers), [controller, overlay]);

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
    a.download = `TLUXE_${def.id}_${p.chartTf}_HIGH_LOW_REVERSAL.png`;
    a.click();
  };

  const snap = p.snapshot;
  const miss = missingTimeframes(snap);
  const statusText = p.replay
    ? `REPLAY · as of ${fmtUtc(replayTime)} · live chart frozen`
    : p.viewState === 'LIVE'
      ? `LIVE · closed bars only${feed?.providerSymbol ? ` · ${feed.providerSymbol}` : ''}`
      : p.viewState === 'STALE'
        ? 'DATA STALE · last received closed bars — not live'
        : p.viewState === 'DEPENDENCY_UNAVAILABLE'
          ? `DEPENDENCY DATA UNAVAILABLE · no ${miss.none.join(' / ')} candles`
          : p.viewState === 'INSUFFICIENT_HISTORY' && miss.short.length
            ? `INSUFFICIENT HISTORY · ${miss.short.map((tf) => `${tf} ${snap!.timeframes[tf].bars}/${snap!.timeframes[tf].required}`).join(' · ')}`
            : HLR_VIEW_TITLE[p.viewState];

  return (
    <section className="panel srchart hlrchart" aria-labelledby="hlrchart-title" ref={stageRef}>
      <div className="srchart__toolbar">
        <div className="seg" role="tablist" aria-label="Chart timeframe">
          {HLR_TIMEFRAMES.slice().reverse().map((tf) => (
            <button key={tf} type="button" role="tab" className="seg__btn" aria-selected={tf === p.chartTf} onClick={() => p.onChartTf(tf)}>
              {tf}
            </button>
          ))}
        </div>
        <div className="srchart__tools">
          <button
            type="button"
            className="srtool"
            aria-pressed={!!p.replay}
            onClick={p.replay ? p.onExitReplay : p.onStartReplay}
            disabled={!p.replay && liveBars === 0}
            title={p.replay ? 'Exit replay' : liveBars === 0 ? 'Replay needs loaded candle history' : 'Replay the reversal engine bar by bar (no future data)'}
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
      {p.replay && <HLRReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <div className="srchart__head">
        <h2 id="hlrchart-title" className="srchart__title">
          {instrument.symbol} · {p.chartTf} · High / Low Reversal
        </h2>
        <div className={`srchart__state ${p.viewState === 'LIVE' ? 'is-ready' : ''} ${p.replay ? 'is-replay' : ''}`} data-testid="hlr-chart-state">
          <span className="dot" aria-hidden="true" /> {statusText}
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
              title={p.viewState === 'LIVE' ? 'MARKET DATA NOT CONNECTED' : HLR_VIEW_TITLE[p.viewState]}
              message={
                p.viewState === 'UNAVAILABLE'
                  ? `${instrument.symbol} is a category. The reversal engine runs once a provider maps it to a specific instrument.`
                  : `Connect a market-data provider to analyse ${instrument.symbol}. No simulated candles, levels or setups are displayed.`
              }
              meta="High / Low Reversal v1 uses real closed H4 · H1 · M15 · M5 · M1 candles only."
            />
          )}
        </div>
      </ChartStage>
    </section>
  );
}
