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
