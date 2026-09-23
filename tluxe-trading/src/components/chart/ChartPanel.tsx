import { ChartCandlestick, Unplug } from 'lucide-react';
import { useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../config/instrument';
import { useMarket } from '../../hooks/useMarket';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { Timeframe } from '../../types/market';
import type { OverlayKind } from '../../types/overlays';
import { EmptyState } from '../ui/EmptyState';
import { Panel } from '../ui/Panel';
import { useChartController } from './useChartController';
import './chart.css';

const isTimeframe = (v: unknown): v is Timeframe => TIMEFRAMES.includes(v as Timeframe);

/** Overlay layers the chart architecture reserves for later phases. */
const OVERLAY_SLOTS: { kind: OverlayKind; label: string }[] = [
  { kind: 'liquidity', label: 'Liquidity' },
  { kind: 'support-resistance', label: 'S/R' },
  { kind: 'order-block', label: 'Order Blocks' },
  { kind: 'fvg', label: 'FVG' },
  { kind: 'bos', label: 'BOS' },
  { kind: 'choch', label: 'CHoCH' },
  { kind: 'session-level', label: 'Session Levels' },
  { kind: 'entry', label: 'Entries' },
  { kind: 'stop-loss', label: 'SL' },
  { kind: 'take-profit', label: 'TP' },
];

export function TimeframeTabs({ value, onChange }: { value: Timeframe; onChange: (tf: Timeframe) => void }) {
  return (
    <div className="seg" role="tablist" aria-label="Chart timeframe">
      {TIMEFRAMES.map((tf) => (
        <button key={tf} type="button" role="tab" className="seg__btn" aria-selected={tf === value} onClick={() => onChange(tf)}>
          {tf}
        </button>
      ))}
    </div>
  );
}

export function ChartPanel() {
  const { market } = useServices();
  const instrument = useMarket((s) => s.instrument);
  const providerName = useMarket((s) => s.provider?.name ?? null);
  const [tf, setTf] = usePersistentState<Timeframe>('tluxe.chart.tf', DEFAULT_TIMEFRAME, isTimeframe);
  const containerRef = useRef<HTMLDivElement>(null);
  const { barCount } = useChartController(market, tf, instrument.priceDecimals, containerRef);
  const empty = barCount === 0;

  return (
    <Panel
      id="chart"
      className="chart-panel"
      title="GC Price Chart"
      subtitle={`${instrument.name} · ${instrument.contract ?? 'front month'} · ${tf}`}
      icon={<ChartCandlestick size={18} />}
      actions={<TimeframeTabs value={tf} onChange={setTf} />}
      bodyClassName="chart-body"
    >
      <div className="chart-legend num" aria-label="Last bar">
        <span className="chart-legend__sym">{instrument.symbol} · {tf}</span>
        {(['O', 'H', 'L', 'C', 'Vol'] as const).map((k) => (
          <span key={k} className="chart-legend__item">
            <span className="chart-legend__k">{k}</span>
            <span className="chart-legend__v">—</span>
          </span>
        ))}
        <span className="chart-legend__src">{providerName ?? 'No provider'}</span>
      </div>
      <div className="chart-stage">
        <div ref={containerRef} className="chart-canvas" hidden={empty} data-testid="chart-canvas" />
        {empty && (
          <div className="chart-empty">
            <div className="chart-empty__grid" aria-hidden="true" />
            <EmptyState
              icon={<Unplug size={18} />}
              title="MARKET DATA NOT CONNECTED"
              message="Connect a market-data provider to stream GC OHLCV candles. No simulated candles are displayed."
              meta={`Provider: ${providerName ?? 'Not Connected'} · Timeframe: ${tf}`}
            />
          </div>
        )}
      </div>
      <div className="chart-overlays" aria-label="Chart overlay layers">
        <span className="chart-overlays__label">Analysis layers</span>
        {OVERLAY_SLOTS.map((o) => (
          <button key={o.kind} type="button" className="chip" disabled title="Engine not built — available in a later phase">
            {o.label}
          </button>
        ))}
        <span className="chart-overlays__note">Available in Phase 2</span>
      </div>
    </Panel>
  );
}
