import { Expand, LineChart } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useServices } from '../../app/servicesContext';
import type { NewsEventView, ReactionResult } from '../../engines/news/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { ChartStage } from '../chart/ChartStage';
import { useChartController } from '../chart/useChartController';
import { EmptyState } from '../ui/EmptyState';
import { reactionOverlay } from './newsView';

/** Event reaction chart: REAL M1 candles of the active instrument (existing stream) + release / horizon marks. */
export function ReactionChart({ event, reaction }: { event: NewsEventView | null; reaction: ReactionResult | null }) {
  const { market } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const d = instrument.priceDecimals;
  const stageRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { barCount, controller } = useChartController(market, def.id, 'M1', d, containerRef);
  const t0 = event ? (event.kind === 'SCHEDULED' ? event.scheduledAt : event.publishedAt) : null;
  const overlay = useMemo(() => reactionOverlay(reaction, t0, d), [reaction, t0, d]);
  useEffect(() => controller?.setNewsReaction(overlay.markers, overlay.lines), [controller, overlay]);
  const state = !barCount ? 'DATA UNAVAILABLE' : !event ? 'NO EVENT SELECTED' : !reaction || reaction.status === 'UNAVAILABLE' ? 'REACTION DATA UNAVAILABLE' : `REACTION ${reaction.status}`;
  return (
    <section className="panel srchart nwchart" aria-labelledby="nwchart-title" ref={stageRef} data-testid="nw-chart">
      <div className="nwchart__head">
        <h2 id="nwchart-title" className="srchart__title">
          <LineChart size={15} /> Event Reaction · {instrument.symbol} M1{event ? ` · ${event.title}` : ''}
        </h2>
        <span className={`nwchart__state ${state.startsWith('REACTION COMPLETE') || state.startsWith('REACTION PARTIAL') ? 'is-ok' : 'is-warn'}`} data-testid="nw-chart-state">{state}</span>
        <div className="srchart__tools">
          <button type="button" className="srtool" onClick={() => void stageRef.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
            <Expand size={14} /> <span>Full Screen</span>
          </button>
        </div>
      </div>
      <ChartStage containerRef={containerRef} controller={controller} hasBars={barCount > 0}>
        <div className="chart-empty">
          <div className="chart-empty__grid" aria-hidden="true" />
          <EmptyState icon={<LineChart size={18} />} title="DATA UNAVAILABLE" message={`No MT5 M1 candles for ${instrument.symbol}. Reactions are measured only from real candles — never simulated.`} meta="Uses the existing MT5 stream of the active instrument (no extra polling)." />
        </div>
      </ChartStage>
      <p className="nwnote nwchart__foot">Marks: release (gold) · pre-event price line · +1 / +5 / +15 / +30 / +60 min closes. Select an event in the calendar or feed; select the instrument in the top bar.</p>
    </section>
  );
}
