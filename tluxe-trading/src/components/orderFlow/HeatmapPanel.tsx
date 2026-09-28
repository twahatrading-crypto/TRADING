import { Expand, Flame, Pause, Play, RotateCcw, SkipForward, StepForward, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HeatmapViewSettings } from '../../engines/orderFlow/config';
import type { OrderFlowEngine } from '../../engines/orderFlow/engine';
import { REPLAY_SPEEDS, type OrderFlowReplay } from '../../engines/orderFlow/replay';
import type { FeedStatus } from '../../engines/orderFlow/types';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { ChartStage } from '../chart/ChartStage';
import type { Viewport } from './heatmapMath';
import { HeatmapView, type TradeHover } from './HeatmapView';
import { Unavailable } from './OrderFlowPanels';

interface Props {
  source: () => OrderFlowEngine | null;
  version: number;
  view: HeatmapViewSettings;
  decimals: number;
  tickSize: number;
  title: string;
  depthStatus: FeedStatus;
  depthDetail: string | null;
  tradeStatus: FeedStatus;
  supported: boolean;
  reason: string | null;
  hasData: boolean;
  replay: OrderFlowReplay | null;
  canReplay: boolean;
  onStartReplay: () => void;
  onExitReplay: () => void;
  onViewport: (vp: Viewport | null) => void;
  onReady: (v: HeatmapView | null) => void;
  className?: string;
  /** The provider has genuine Level-2 depth (false = trades-only: no liquidity layer is drawn, nothing inferred). */
  depthAvailable: boolean;
  /** UI toggle: liquidity layer on / off. */
  showHeatmap: boolean;
  /** Name of the executed-trade source (hover provenance). */
  tradeSource: string | null;
}

/** The central heatmap, rendered by HeatmapView on a canvas inside the shared ChartStage. */
export function HeatmapPanel(p: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<HeatmapView | null>(null);
  const settingsRef = useRef(p.view);
  settingsRef.current = p.view;
  const sourceRef = useRef(p.source);
  sourceRef.current = p.source;
  const onVp = useRef(p.onViewport);
  onVp.current = p.onViewport;
  const depthRef = useRef(p.depthAvailable || !!p.replay);
  depthRef.current = p.depthAvailable || !!p.replay;
  const cellsRef = useRef(p.showHeatmap);
  cellsRef.current = p.showHeatmap;
  const [hover, setHover] = useState<TradeHover | null>(null);
  const { hasData, decimals, tickSize, onReady } = p;

  // One view (one rAF loop, one set of listeners) per mounted panel; destroyed on unmount / HMR.
  useEffect(() => {
    const host = containerRef.current;
    if (!host || !hasData) return;
    const v = new HeatmapView(host, () => sourceRef.current(), {
      settings: () => settingsRef.current,
      onViewport: (vp) => onVp.current(vp),
      decimals,
      tickSize,
      depthAvailable: () => depthRef.current,
      showCells: () => cellsRef.current,
      onHover: setHover,
    });
    setView(v);
    onReady(v);
    return () => {
      v.destroy();
      setView(null);
      onReady(null);
    };
  }, [hasData, decimals, tickSize, onReady]);
  useEffect(() => view?.invalidate(), [view, p.view, p.version, p.replay, p.depthAvailable, p.showHeatmap]);

  const depthOk = p.depthStatus === 'LIVE' || !!p.replay;
  return (
    <section className={`panel srchart ofheat ${p.className ?? ''}`} aria-labelledby="ofheat-title" ref={sectionRef}>
      <div className="ofheat__head">
        <h2 id="ofheat-title" className="srchart__title">
          <Flame size={15} aria-hidden="true" /> {p.title}
        </h2>
        <span className="ofheat__legend" aria-label="Legend">
          <i className="is-buy" /> buy aggressor <i className="is-sell" /> sell aggressor <i className="is-unk" /> unknown side
        </span>
        <div className="srchart__tools">
          <button type="button" className="srtool" aria-pressed={!!p.replay} onClick={p.replay ? p.onExitReplay : p.onStartReplay} disabled={!p.replay && !p.canReplay} title={p.canReplay ? 'Replay the recorded depth + trades' : 'Replay needs a recorded stream'}>
            <Play size={15} /> <span>Replay</span>
          </button>
          <button type="button" className="srtool srtool--icon" onClick={() => void sectionRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={15} />
          </button>
        </div>
      </div>
      {p.replay && <ReplayBar replay={p.replay} onExit={p.onExitReplay} />}
      <div className="ofheat__stagewrap">
      {p.hasData && !depthOk && (
        <p className="ofheat__depthna" role="status" data-testid="of-depth-na" title={p.depthDetail ?? 'No valid Level-2 book'}>
          <b>DEPTH DATA UNAVAILABLE</b> · LEVEL-2 PROVIDER NOT CONNECTED — executed trades only; no liquidity is drawn or inferred
        </p>
      )}
      {hover && (
        <div className="ofheat__tip" role="tooltip" data-testid="of-trade-tip" style={{ left: hover.x + 14, top: Math.max(4, hover.y - 10) }}>
          <b>{new Date(hover.time).toLocaleTimeString('en-GB', { hour12: false })}</b>
          {hover.aggMs > 1 && <span className="ofdim"> ({hover.aggMs >= 1000 ? `${hover.aggMs / 1000}s` : `${hover.aggMs}ms`} bucket)</span>}
          <span>Price <b className="num">{hover.price.toFixed(p.decimals)}</b></span>
          <span>Size <b className="num">{(hover.buy + hover.sell + hover.unknown).toLocaleString()}</b></span>
          <span>
            Side: <b className="ofbid-t">buy {hover.buy.toLocaleString()}</b> · <b className="ofask-t">sell {hover.sell.toLocaleString()}</b> · <b>unknown {hover.unknown.toLocaleString()}</b>
          </span>
          <span className="ofdim">Source: {p.tradeSource ?? '—'} · executed trades</span>
        </div>
      )}
      <ChartStage containerRef={containerRef} controller={view} hasBars={p.hasData}>
        <div className="chart-empty">
          <div className="chart-empty__grid" aria-hidden="true" />
          {!p.supported ? (
            <Unavailable title="GC DEPTH DATA UNAVAILABLE" detail={p.reason ?? 'This instrument has no exchange Level-2.'} />
          ) : (
            <Unavailable title="LEVEL-2 DATA UNAVAILABLE" detail={<>{p.depthDetail ?? 'LEVEL-2 PROVIDER NOT CONNECTED'}. A liquidity heatmap needs genuine exchange depth (e.g. a Rithmic / T4 / CQG GC COMEX feed). MT5 has no exchange order book and is never used for this page. No synthetic liquidity is ever shown.</>} />
          )}
        </div>
      </ChartStage>
      </div>
    </section>
  );
}

function ReplayBar({ replay, onExit }: { replay: OrderFlowReplay; onExit: () => void }) {
  const st = useOptionalStore(replay.store, (s) => s, null)!;
  const [jump, setJump] = useState('');
  return (
    <div className="ofreplay" data-testid="of-replay">
      <strong>REPLAY</strong>
      <button type="button" className="ofbtn" onClick={() => (st.playing ? replay.pause() : replay.play())} aria-label={st.playing ? 'Pause' : 'Play'}>{st.playing ? <Pause size={13} /> : <Play size={13} />}</button>
      <button type="button" className="ofbtn" onClick={() => replay.step(1)} aria-label="Step one message"><StepForward size={13} /></button>
      <button type="button" className="ofbtn" onClick={() => replay.step(100)} aria-label="Step 100 messages"><SkipForward size={13} /></button>
      <button type="button" className="ofbtn" onClick={() => replay.reset()} aria-label="Reset replay"><RotateCcw size={13} /></button>
      <select value={st.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} aria-label="Replay speed">
        {REPLAY_SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const [h, m, s] = jump.split(':').map(Number);
          if (st.time === null && !replay.store.getState().total) return;
          const base = new Date(st.time ?? Date.now());
          base.setHours(h ?? 0, m ?? 0, s ?? 0, 0);
          replay.jumpTo(base.getTime());
        }}
      >
        <input value={jump} onChange={(e) => setJump(e.target.value)} placeholder="hh:mm:ss" aria-label="Jump to time" />
      </form>
      <span className="num" data-testid="of-replay-count">{st.cursor.toLocaleString()} / {st.total.toLocaleString()}</span>
      <span className="num">{st.time === null ? '—' : new Date(st.time).toLocaleTimeString('en-GB', { hour12: false })}</span>
      <button type="button" className="ofbtn" onClick={onExit} aria-label="Exit replay"><X size={13} /> Exit</button>
    </div>
  );
}
