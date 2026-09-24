import { BellRing, Camera, ChartCandlestick, Expand, Mail, Play, Unplug, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import type { HLESnapshot, HLETimeframe, Setup } from '../../engines/highLowEngine/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import type { HighLowReplaySession } from '../../services/highLowEngine/HighLowReplay';
import { useStore } from '../../store/createStore';
import { formatPrice } from '../../utils/format';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { HLE_VIEW_TITLE, hleOverlays, type HLETools, type HLEViewState } from './hleView';
import { HighLowReplayBar } from './HighLowReplayBar';
import { fmtUtc } from './useHighLow';

interface Props {
  chartTf: HLETimeframe;
  snapshot: HLESnapshot | null;
  selected: Setup | null;
  viewState: HLEViewState;
  tools: HLETools;
  replay: HighLowReplaySession | null;
  onStartReplay: () => void;
  onExitReplay: () => void;
}

export function HighLowChart(p: Props) {
  const { market } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const stageRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayBars = useOptionalStore(p.replay?.store, (s) => s.visible, null);
  const replayTime = useOptionalStore(p.replay?.store, (s) => s.knowledgeTime, null);
  const { barCount, controller, lastBar } = useChartController(market, def.id, p.chartTf, d, containerRef, p.replay ? replayBars : null);
  const liveBars = market.getCandles(def.id, p.chartTf).length;
  const ready = p.viewState === 'LIVE' || p.viewState === 'STALE' || p.viewState === 'REPLAY';
  const overlay = useMemo(
    () => (ready && p.snapshot ? hleOverlays({ levels: p.snapshot.levels, selected: p.selected, chartTf: p.chartTf, decimals: d, tools: p.tools }) : { drawables: [], markers: [] }),
    [ready, p.snapshot, p.selected, p.chartTf, d, p.tools],
  );
  useEffect(() => controller?.setHighLowEngine(overlay.drawables, overlay.markers), [controller, overlay]);
  useEffect(() => {
    const session = p.replay;
    if (!session || !controller) return;
    return controller.onBarClick((t) => {
      if (t === null) return;
      const idx = (session.dataset.candles[session.store.getState().timeframe] ?? []).findIndex((c) => c.time === t);
      if (idx >= 0) session.seek(idx);
    });
  }, [p.replay, controller]);
  const shot = () => {
    const canvas = controller?.screenshot();
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `TLUXE_${def.id}_${p.chartTf}_HIGH_LOW_ENGINE.png`;
    a.click();
  };
  const bar = p.replay ? (replayBars?.at(-1) ?? null) : lastBar;
  return (
    <section className="panel srchart hlechart" aria-labelledby="hlechart-title" ref={stageRef}>
      <div className="hlechart__head">
        <h2 id="hlechart-title" className="srchart__title">
          {instrument.symbol} · {p.chartTf}
        </h2>
        <span className="hlechart__ohlc num">{bar ? `O ${formatPrice(bar.open, d)}  H ${formatPrice(bar.high, d)}  L ${formatPrice(bar.low, d)}  C ${formatPrice(bar.close, d)}` : ''}</span>
        <span className="hlechart__note">Bands and markers come from the engine result — nothing else is drawn.</span>
        <div className="srchart__tools">
          <button type="button" className="srtool" aria-pressed={!!p.replay} onClick={p.replay ? p.onExitReplay : p.onStartReplay} disabled={!p.replay && liveBars === 0} title={p.replay ? 'Exit replay' : 'Replay bar by bar (no future data)'}>
            <Play size={15} /> <span>Replay</span>
          </button>
          <button type="button" className="srtool srtool--icon" onClick={() => void stageRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={15} />
          </button>
          <button type="button" className="srtool srtool--icon" onClick={shot} disabled={!controller} aria-label="Save chart image" title="Save chart image">
            <Camera size={15} />
          </button>
        </div>
      </div>
      {p.replay && <HighLowReplayBar session={p.replay} onExit={p.onExitReplay} />}
      <div className={`srchart__state ${p.viewState === 'LIVE' ? 'is-ready' : ''} ${p.replay ? 'is-replay' : ''}`} data-testid="hle-chart-state">
        <span className="dot" aria-hidden="true" /> {p.replay ? `REPLAY · as of ${fmtUtc(replayTime)} · live chart frozen` : HLE_VIEW_TITLE[p.viewState]}
      </div>
      <div className="srchart__stage">
        <div ref={containerRef} className="chart-canvas" hidden={barCount === 0} />
        {barCount === 0 && (
          <div className="chart-empty">
            <div className="chart-empty__grid" aria-hidden="true" />
            <EmptyState
              icon={p.viewState === 'UNAVAILABLE' ? <ChartCandlestick size={18} /> : <Unplug size={18} />}
              title={p.viewState === 'LIVE' ? 'MARKET DATA NOT CONNECTED' : HLE_VIEW_TITLE[p.viewState]}
              message={`Connect MT5 through the TLUXE bridge to analyse ${instrument.symbol}. No simulated candles, levels or signals are ever shown.`}
              meta="High / Low Engine uses real closed H4 · H1 · M15 · M5 · M1 candles only."
            />
          </div>
        )}
      </div>
    </section>
  );
}

const TOOL_LABEL: [keyof HLETools, string][] = [
  ['levels', 'Major High/Low'],
  ['liquidity', 'BSL / SSL'],
  ['sweeps', 'Sweeps'],
  ['structure', 'CHOCH / BOS'],
  ['risk', 'Entry / SL / TP'],
];
const TFS: HLETimeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4'];

export function ToolsPanel({ tools, onTools, chartTf, onChartTf }: { tools: HLETools; onTools: (t: HLETools) => void; chartTf: HLETimeframe; onChartTf: (tf: HLETimeframe) => void }) {
  const { highLow } = useServices();
  const a = useStore(highLow.alerts.store, (s) => s);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <aside className="panel hletools" aria-label="Chart tools and alerts">
      <h3>TOOLS</h3>
      {TOOL_LABEL.map(([k, label]) => (
        <button key={k} type="button" className="hletools__tog" aria-pressed={tools[k]} onClick={() => onTools({ ...tools, [k]: !tools[k] })}>
          <i aria-hidden="true" /> {label}
        </button>
      ))}
      <h3>TIMEFRAME</h3>
      <div className="hletools__tfs" role="tablist" aria-label="Chart timeframe">
        {TFS.map((tf) => (
          <button key={tf} type="button" role="tab" aria-selected={tf === chartTf} className="hletools__tf" onClick={() => onChartTf(tf)}>
            {tf}
          </button>
        ))}
      </div>
      <h3>ENTRY ALERTS</h3>
      <button type="button" className={`hletools__btn ${a.alarmOn ? 'is-on' : ''}`} aria-pressed={a.alarmOn} onClick={() => highLow.alerts.setAlarm(!a.alarmOn)} data-testid="hle-alarm">
        <BellRing size={14} /> {a.alarmOn ? 'ALARM ON' : 'ALARM OFF'}
      </button>
      <button type="button" className="hletools__btn" onClick={() => setMsg(highLow.alerts.testAlarm() ? 'Test alarm played.' : 'Sound unavailable in this browser.')}>
        <Volume2 size={14} /> TEST ALARM
      </button>
      <button type="button" className="hletools__btn" onClick={() => setMsg('Email is not configured: TLUXE has no mail service, so no email is sent and no credentials are stored in the browser.')} data-testid="hle-test-email">
        <Mail size={14} /> TEST EMAIL
      </button>
      {msg && <p className="hletools__msg" role="status">{msg}</p>}
      <dl className="hletools__st">
        <dt>Sound</dt><dd className={a.sound === 'armed' ? 'ok' : 'muted'}>{a.sound}</dd>
        <dt>Desktop</dt>
        <dd className={a.desktop === 'granted' ? 'ok' : a.desktop === 'denied' ? 'bad' : 'muted'}>
          {a.desktop === 'granted' ? 'on' : a.desktop === 'denied' ? 'blocked' : a.desktop === 'unsupported' ? 'unsupported' : <button type="button" className="hletools__link" onClick={() => void highLow.alerts.requestDesktop()}>enable</button>}
        </dd>
        <dt>Email</dt><dd className="muted">not configured</dd>
      </dl>
      {a.last && <p className="hletools__last">Last alert: {a.last.side} CONFIRMED · {fmtUtc(a.last.at)} · {a.last.channels.join(' + ') || 'silent (alarm off)'}</p>}
    </aside>
  );
}
