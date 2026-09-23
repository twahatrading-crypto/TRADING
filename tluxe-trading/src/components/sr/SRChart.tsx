import { Camera, ChartCandlestick, Expand, Layers, PencilLine, Play, Settings2, SlidersHorizontal, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import type { SRConfluence, SRZone } from '../../engines/sr/types';
import type { Timeframe } from '../../types/market';
import { TimeframeTabs } from '../chart/ChartPanel';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { useSRSettings, useSRState } from './useSR';
import { chartDrawables, SR_VIEW_TITLE, srViewState, type ZoneFilters } from './srView';

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
}

export function SRChart(p: Props) {
  const { market } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const connection = useMarket((s) => s.connection);
  const snapshot = useSRState((s) => s.byTimeframe[p.chartTf]);
  const [settings] = useSRSettings();
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { barCount, controller } = useChartController(market, def.id, p.chartTf, instrument.priceDecimals, containerRef);
  const state = srViewState({ tradable: def.tradable, connection, snapshots: [snapshot] });

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
  const statusText =
    state === 'READY'
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
          <button type="button" className="srtool" disabled title="Chart replay — later phase">
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
      <div className="srchart__head">
        <div>
          <h2 id="srchart-title" className="srchart__title">
            {instrument.symbol} · {instrument.name} · {p.chartTf} · {instrument.exchange ?? instrument.venue}
          </h2>
          <div className={`srchart__state ${state === 'READY' ? 'is-ready' : ''}`} data-testid="sr-chart-state">
            <span className="dot" aria-hidden="true" /> {statusText}
          </div>
        </div>
      </div>
      <div className="srchart__stage">
        <div ref={containerRef} className="chart-canvas" hidden={barCount === 0} />
        {barCount === 0 && (
          <div className="chart-empty">
            <div className="chart-empty__grid" aria-hidden="true" />
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
          </div>
        )}
      </div>
    </section>
  );
}
