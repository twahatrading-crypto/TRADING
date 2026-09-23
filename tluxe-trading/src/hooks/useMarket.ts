import { useServices } from '../app/servicesContext';
import { useStore } from '../store/createStore';
import type { MarketState } from '../types/market';

export function useMarket<S>(selector: (s: MarketState) => S): S {
  return useStore(useServices().market.store, selector);
}
