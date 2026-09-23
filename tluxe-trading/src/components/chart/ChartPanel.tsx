import { ChartCandlestick, Unplug } from 'lucide-react';
import { useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../config/instrument';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { Timeframe } from '../../types/market';
import type { OverlayKind } from '../../types/overlays';
import { formatPrice, formatVolume } from '../../utils/format';
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
  const def = useActiveInstrument();
  // Remount per instrument: timeframe preference and chart state are per symbol.
  return <InstrumentChart key={def.id} />;
}

function InstrumentChart() {
  const { market } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const providerName = useMarket((s) => s.provider?.name ?? null);
  const [tf, setTf] = usePersistentState<Timeframe>(`tluxe.chart.tf.${def.id}`, DEFAULT_TIMEFRAME, isTimeframe);
  const containerRef = useRef<HTMLDivElement>(null);
  const { barCount, lastBar } = useChartController(market, def.id, tf, instrument.priceDecimals, containerRef);
  const feed = useMarket((s) => s.feed);
  const d = instrument.priceDecimals;
  const volKey = lastBar?.volume != null ? 'Vol' : lastBar?.tickVolume != null ? 'Tick vol' : 'Vol';
  const volVal = lastBar?.volume ?? lastBar?.tickVolume ?? null;
  const empty = barCount === 0;
  const where = instrument.exchange ?? instrument.venue;

  return (
    <Panel
      id="chart"
      className="chart-panel"
      title={`${instrument.symbol} Price Chart`}
      subtitle={`${instrument.name} · ${where}${instrument.contract ? ` · ${instrument.contract}` : ''} · ${tf}${feed?.providerSymbol ? ` · MT5 ${feed.providerSymbol}` : ''}`}
      icon={<ChartCandlestick size={18} />}
      actions={<TimeframeTabs value={tf} onChange={setTf} />}
      bodyClassName="chart-body"
    >
      <div className="chart-legend num" aria-label="Last bar">
        <span className="chart-legend__sym">{instrument.symbol} · {tf}</span>
        {(
          [
            ['O', formatPrice(lastBar?.open ?? null, d)],
            ['H', formatPrice(lastBar?.high ?? null, d)],
            ['L', formatPrice(lastBar?.low ?? null, d)],
            ['C', formatPrice(lastBar?.close ?? null, d)],
            [volKey, formatVolume(volVal)],
          ] as const
        ).map(([k, v]) => (
          <span key={k} className="chart-legend__item">
            <span className="chart-legend__k">{k}</span>
            <span className="chart-legend__v">{v}</span>
          </span>
        ))}
        {lastBar && lastBar.isClosed === false && <span className="chart-legend__k">forming</span>}
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
              message={
                def.tradable
                  ? `Connect a market-data provider to stream ${instrument.symbol} OHLCV candles. No simulated candles are displayed.`
                  : `${instrument.symbol} is a category. Candles appear once a provider maps it to a specific instrument (${(def.variants ?? []).map((v) => v.label).join(', ')}).`
              }
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
