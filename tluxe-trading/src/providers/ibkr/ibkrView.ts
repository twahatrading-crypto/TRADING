import { useStore } from '../../store/createStore';
import { ibkrHealth, type IbkrRow, type IbkrState } from './IbkrDepthProvider';

/** IBKR state for one root as reported by the gateway (OFFLINE when the gateway cannot be reached). */
export function useIbkrRootState(root: string): IbkrState {
  const h = useStore(ibkrHealth, (s) => s);
  if (!h.status) return h.fetchedAt ? 'OFFLINE' : 'CONNECTING';
  return (h.status.roots[root]?.state as IbkrState | undefined) ?? 'UNKNOWN';
}

const sum = (rows: IbkrRow[]) => rows.reduce((a, r) => a + r.size, 0);

/** Visible-book imbalance, computed ONLY from the price levels IBKR published (top N rows) - not the full exchange book. */
export function visibleImbalance(bids: IbkrRow[], asks: IbkrRow[]) {
  const bid = sum(bids);
  const ask = sum(asks);
  return { bid, ask, ratio: ask > 0 ? bid / ask : null, imbalance: bid + ask > 0 ? (bid - ask) / (bid + ask) : null };
}

/** IBKR depth state for a GC / SI root when IBKR is the configured depth provider; null otherwise (no IBKR provider
 *  registered, IBKR not configured on the gateway, or an instrument IBKR does not cover). Display only. */
export function useIbkrDepthState(root: string): IbkrState | null {
  const h = useStore(ibkrHealth, (s) => s);
  const state = useIbkrRootState(root);
  const active = h.fetchedAt !== null && (h.status ? h.status.configured : true);
  return active && (root === 'GC' || root === 'SI') ? state : null;
}

/** Headline for the Level-2 depth system (IBKR price levels) - never worded as MBO. */
export function level2Headline(state: IbkrState): string {
  return `LEVEL-2 DEPTH ${state.replace(/_/g, ' ')}`;
}
