import { Camera, ChartCandlestick, Expand, Layers, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import type { AnalysisInput } from '../../engines/srPro/analysis';
import type { FeedStatus } from '../../engines/srPro/feedState';
import type { AsiaSessionId, KeyLevel } from '../../engines/srPro/keyLevels';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import type { Timeframe } from '../../types/market';
import { TimeframeTabs } from '../chart/ChartPanel';
import { ChartStage } from '../chart/ChartStage';
import { useChartController } from '../chart/useChartController';
import { smcOverlays } from '../smc/smcView';
import { EmptyState } from '../ui/EmptyState';
import { declutterLineLabels, declutterSmc, levelDrawables, OVERLAY_LABELS, smcToggles, timeBands, zoneDrawables, type OverlayKey, type Overlays } from './srProView';

interface Props {
  chartTf: Timeframe;
  onChartTf: (tf: Timeframe) => void;
  input: AnalysisInput;
  feed: FeedStatus;
  levels: readonly KeyLevel[];
  asia: AsiaSessionId;
  overlays: Overlays;
  onToggle: (k: OverlayKey) => void;
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
}

export function SRProChart(p: Props) {
  const { market } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const { barCount, controller } = useChartController(market, def.id, p.chartTf, d, containerRef, null);
  const bars = useMemo(() => p.input.candles[p.chartTf] ?? [], [p.input.candles, p.chartTf]);
  const first = bars[0]?.time ?? null;
  const last = bars[bars.length - 1]?.time ?? null;

  const zones = useMemo(() => zoneDrawables(p.input, p.chartTf, p.overlays, p.selectedZoneId, d), [p.input, p.chartTf, p.overlays, p.selectedZoneId, d]);
  useEffect(() => controller?.setZones(zones), [controller, zones]);
  const bands = useMemo(() => timeBands(p.input, p.chartTf, p.asia, p.overlays, first, last), [p.input, p.chartTf, p.asia, p.overlays, first, last]);
  useEffect(() => controller?.setTimeBands(bands), [controller, bands]);
  const smc = useMemo(
    () => (p.input.smc ? smcOverlays({ snapshot: p.input.smc, chartTf: p.chartTf, toggles: smcToggles(p.overlays), decimals: d }) : { drawables: [], markers: [] }),
    [p.input.smc, p.chartTf, p.overlays, d],
  );
  const lines = useMemo(() => levelDrawables(p.levels, p.overlays, d), [p.levels, p.overlays, d]);
  const atr = p.input.byTf[p.chartTf]?.atr ?? null;
  const smcDrawn = useMemo(() => {
    const base = declutterSmc(smc.drawables, p.input.price);
    const breaks = base.filter((x) => x.id.startsWith('smc:brk:') || x.kind === 'zone');
    const levelsFirst = [...lines, ...base.filter((x) => x.id.startsWith('smc:lq:'))];
    return [...breaks, ...declutterLineLabels(levelsFirst, zones, atr)];
  }, [smc, lines, zones, atr, p.input.price]);
  useEffect(() => controller?.setSmc(smcDrawn, smc.markers.slice(-12)), [controller, smcDrawn, smc]);

  // Clicking inside a drawn zone selects it (the table selects too).
  useEffect(() => {
    if (!controller) return;
    return controller.onBarClick((t) => {
      if (t === null) return;
      const bar = bars.find((b) => b.time === t);
      if (!bar) return;
      const hit = zones.find((z) => bar.low <= z.high && bar.high >= z.low);
      p.onSelectZone(hit ? hit.id : null);
    });
  }, [controller, zones, bars, p]);

  const screenshot = () => {
    const canvas = controller?.screenshot();
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `TLUXE_${def.id}_${p.chartTf}_SR-Pro.png`;
    a.click();
  };
  const snap = p.input.byTf[p.chartTf];
  const lastBar = bars[bars.length - 1];

  return (
    <section className="panel srp-chart" aria-labelledby="srp-chart-title" ref={stageRef}>
      <div className="srp-chart__toolbar">
        <TimeframeTabs value={p.chartTf} onChange={p.onChartTf} />
        <div className="srp-chart__tools">
          <div className="srp-menu">
            <button type="button" className="srtool" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <Layers size={15} /> <span>Overlays</span>
            </button>
            {menu && (
              <div className="srp-menu__pop" role="group" aria-label="Chart overlays">
                {OVERLAY_LABELS.map(([k, label, help]) => (
                  <label key={k} className="srp-check" title={help}>
                    <input type="checkbox" checked={p.overlays[k]} onChange={() => p.onToggle(k)} /> {label}
                  </label>
                ))}
              </div>
            )}
          </div>
          {(['zones', 'levels', 'bos', 'choch', 'liquidity'] as OverlayKey[]).map((k) => (
            <button key={k} type="button" className="srtool srtool--chip" aria-pressed={p.overlays[k]} onClick={() => p.onToggle(k)}>
              {OVERLAY_LABELS.find(([x]) => x === k)![1]}
            </button>
          ))}
          <span className="srtool__sep" aria-hidden="true" />
          <button type="button" className="srtool srtool--icon" onClick={screenshot} disabled={!controller} aria-label="Save chart image" title="Save chart image">
            <Camera size={15} />
          </button>
          <button type="button" className="srtool srtool--icon" onClick={() => void stageRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={15} />
          </button>
        </div>
      </div>
      <div className="srp-chart__head">
        <h2 id="srp-chart-title" className="srp-chart__title">
          {instrument.symbol} · {instrument.name} · {p.chartTf} · {instrument.exchange ?? instrument.venue}
          <span className={`srp-badge is-${p.feed.state.toLowerCase()}`} data-testid="srp-feed">
            {p.feed.label}
          </span>
        </h2>
        <div className="srp-chart__ohlc">
          {lastBar ? (
            <>
              O <b>{lastBar.open.toFixed(d)}</b> H <b>{lastBar.high.toFixed(d)}</b> L <b>{lastBar.low.toFixed(d)}</b> C <b>{lastBar.close.toFixed(d)}</b>
              <span className="srp-muted"> · {snap ? `${snap.barsProcessed} closed bars analysed` : 'no analysis yet'} · {p.feed.detail}</span>
            </>
          ) : (
            <span className="srp-muted">{p.feed.detail}</span>
          )}
        </div>
      </div>
      <ChartStage containerRef={containerRef} controller={controller} hasBars={barCount > 0}>
        <div className="chart-empty">
          <div className="chart-empty__grid" aria-hidden="true" />
          <EmptyState
            icon={p.feed.state === 'NO_DATA' ? <ChartCandlestick size={18} /> : <Unplug size={18} />}
            title={p.feed.state === 'NO_DATA' ? 'NO MARKET DATA' : p.feed.label}
            message={`No ${p.chartTf} candles to draw. Nothing is simulated: the chart stays empty until real candles arrive.`}
            meta={p.feed.detail}
          />
        </div>
      </ChartStage>
    </section>
  );
}
