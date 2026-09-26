import { ChartCandlestick, Expand, Play, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import type { SmcSnapshot } from '../../engines/smc/types';
import type { SRZone } from '../../engines/sr/types';
import type { VPSnapshot, VolumeProfile } from '../../engines/volumeProfile/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import type { VPReplaySession } from '../../services/volumeProfile/VPReplay';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { ChartStage } from '../chart/ChartStage';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { VPReplayBar } from './VPReplayBar';
import { VP_CHART_TFS, VP_PROFILE_CHOICES, VP_VIEW_TITLE, fmtUtc, vpOverlays, type VPProfileChoice, type VPToggles, type VPViewState } from './vpView';

interface Props {
  chartTf: Timeframe;
  onChartTf: (tf: Timeframe) => void;
  choice: VPProfileChoice;
  onChoice: (c: VPProfileChoice) => void;
  fixed: { from: string; to: string };
  onFixed: (v: { from: string; to: string }) => void;
  onVisibleRange: (r: { from: number; to: number } | null) => void;
  snapshot: VPSnapshot | null;
  profile: VolumeProfile | null;
  smc: SmcSnapshot | null;
  srZones: readonly SRZone[] | null;
  toggles: VPToggles;
  viewState: VPViewState;
  replay: VPReplaySession | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
}

/** Volume Profile chart: real candles of the chart timeframe + the engine's profile histogram / levels. */
export function VPChart(p: Props) {
  const { market, volumeProfile } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const stageRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayBars = useOptionalStore(p.replay?.store, (s) => s.visible, null);
  const replayTime = useOptionalStore(p.replay?.store, (s) => s.knowledgeTime, null);
  const { barCount, controller, lastBar } = useChartController(market, def.id, p.chartTf, d, containerRef, p.replay ? replayBars : null);
  const liveBars = market.getCandles(def.id, p.chartTf);
  const barTimes = useMemo(() => (p.replay ? (replayBars ?? []) : liveBars).map((c) => c.time), [p.replay, replayBars, liveBars, lastBar]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = p.viewState !== 'UNAVAILABLE';
  const overlay = useMemo(
    () => (ready ? vpOverlays({ snapshot: p.snapshot, profile: p.profile, smc: p.smc, srZones: p.srZones, chartTf: p.chartTf, toggles: p.toggles, decimals: d, barTimes }) : { hist: null, drawables: [], markers: [] }),
    [ready, p.snapshot, p.profile, p.smc, p.srZones, p.chartTf, p.toggles, d, barTimes],
  );
  useEffect(() => controller?.setVolumeProfile(overlay.hist, overlay.drawables, overlay.markers), [controller, overlay]);
  const { onVisibleRange } = p;
  useEffect(() => {
    if (!controller) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = controller.onVisibleRange((r) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => onVisibleRange(r), 250);
    });
    return () => {
      if (t) clearTimeout(t);
      off();
    };
  }, [controller, onVisibleRange]);
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
    <section className="panel srchart smcchart vpchart" aria-labelledby="vpchart-title" ref={stageRef}>
      <div className="smcchart__head">
        <div className="smctfs" role="tablist" aria-label="Chart timeframe">
          {VP_CHART_TFS.map((tf) => (
            <button key={tf} type="button" role="tab" aria-selected={tf === p.chartTf} onClick={() => p.onChartTf(tf)}>
              {tf}
            </button>
          ))}
        </div>
        <label className="vpselect">
          <span>Profile</span>
          <select value={p.choice} onChange={(e) => p.onChoice(e.target.value as VPProfileChoice)} aria-label="Profile type" data-testid="vp-profile-select">
            {VP_PROFILE_CHOICES.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {p.choice === 'FIXED' && (
          <div className="vpfixed" data-testid="vp-fixed">
            <input type="datetime-local" value={p.fixed.from} onChange={(e) => p.onFixed({ ...p.fixed, from: e.target.value })} aria-label="Fixed range start (UTC)" />
            <span>→</span>
            <input type="datetime-local" value={p.fixed.to} onChange={(e) => p.onFixed({ ...p.fixed, to: e.target.value })} aria-label="Fixed range end (UTC)" />
            <span className="srmuted">UTC</span>
          </div>
        )}
        <div className="srchart__tools">
          <button type="button" className="srtool" onClick={() => volumeProfile.refresh()} disabled={!!p.replay} title="Rebuild the profiles from the loaded candles (no extra data request)">
            <RefreshCw size={14} /> <span>Refresh</span>
          </button>
          <button type="button" className="srtool" aria-pressed={!!p.replay} onClick={p.replay ? p.onExitReplay : p.onStartReplay} disabled={!p.replay && liveBars.length === 0} title={p.replay ? 'Exit replay' : 'Replay candle by candle (no future data)'}>
            <Play size={14} /> <span>Replay</span>
          </button>
          <button type="button" className="srtool" onClick={() => void stageRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={14} /> <span>Full Screen</span>
          </button>
        </div>
      </div>
      <div className="smcchart__title">
        <h2 id="vpchart-title" className="srchart__title">
          {instrument.symbol} · {p.chartTf} · {p.profile?.label ?? VP_PROFILE_CHOICES.find(([k]) => k === p.choice)?.[1]}
        </h2>
        <span className="num smcchart__ohlc">
          {bar ? `O ${formatPrice(bar.open, d)}  H ${formatPrice(bar.high, d)}  L ${formatPrice(bar.low, d)}  C ${formatPrice(bar.close, d)}  ${chg !== null ? `${chg >= 0 ? '+' : ''}${formatPrice(chg, d)}` : ''}` : ''}
        </span>
        <span className={`smcchart__state is-${p.viewState.toLowerCase()}`} data-testid="vp-chart-state">
          <i aria-hidden="true" /> {p.replay ? `REPLAY · as of ${fmtUtc(replayTime)} · live chart frozen` : VP_VIEW_TITLE[p.viewState]}
        </span>
      </div>
      {p.replay && <VPReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <ChartStage containerRef={containerRef} controller={controller} hasBars={barCount > 0}>
        <div className="chart-empty">
          <div className="chart-empty__grid" aria-hidden="true" />
          <EmptyState
            icon={p.viewState === 'UNAVAILABLE' ? <Unplug size={18} /> : <ChartCandlestick size={18} />}
            title={VP_VIEW_TITLE[p.viewState === 'LIVE' ? 'UNAVAILABLE' : p.viewState]}
            message={`Connect MT5 through the TLUXE bridge to build the ${instrument.symbol} volume profile. Volume is never estimated or simulated.`}
            meta="Volume Profile uses real closed M5 · M15 · M30 · H1 · H4 · D1 candles and their reported volume only."
          />
        </div>
      </ChartStage>
      <p className="smcnote smcchart__foot">
        Histogram = {p.profile ? `${p.profile.label} (${p.profile.source.label})` : 'no profile'} · red = POC row, blue = value area. Navigation only changes the view — it never recalculates the engine.
      </p>
    </section>
  );
}
