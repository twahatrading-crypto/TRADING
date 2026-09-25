import type { OrderFlowEngine, OrderFlowTotals } from '../../engines/orderFlow/engine';
import type { CvdAvailability, OrderBookView, OrderFlowEvent, VolumeAtPrice } from '../../engines/orderFlow/types';

/** Panel data derived from one engine (live or replay) — identical shape for both, so replay renders exactly like live. */
export interface OrderFlowPanelsData {
  book: OrderBookView | null;
  totals: OrderFlowTotals | null;
  cvd: CvdAvailability;
  profile: VolumeAtPrice[];
  events: OrderFlowEvent[];
  limitations: string[];
  lastTrade: { price: number; size: number; aggressor: string; time: number } | null;
  cvdSeries: number[];
  version: number;
}

export function panelsOf(e: OrderFlowEngine | null, maxSeries = 300): OrderFlowPanelsData {
  if (!e) return { book: null, totals: null, cvd: 'UNAVAILABLE', profile: [], events: [], limitations: [], lastTrade: null, cvdSeries: [], version: 0 };
  const cols = e.allColumns();
  return {
    book: e.bookValid ? e.bookView(20) : null,
    totals: e.trade.state !== 'NO_DATA' ? e.sessionTotals() : null,
    cvd: e.cvdAvailability(),
    profile: e.sessionProfile(),
    events: [...e.events()].slice(-200).reverse(),
    limitations: [...e.limitations()],
    lastTrade: e.lastTradeInfo(),
    cvdSeries: cols.slice(-maxSeries).map((c) => c.cvd),
    version: e.version,
  };
}
