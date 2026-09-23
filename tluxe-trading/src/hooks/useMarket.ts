import { useServices } from '../app/servicesContext';
import { useStore } from '../store/createStore';
import type { InstrumentDefinition } from '../types/instruments';
import type { MarketState } from '../types/market';

/** Id of the instrument the whole dashboard is currently showing. */
export function useActiveInstrumentId(): string {
  return useStore(useServices().instruments.store, (s) => s.activeId);
}

export function useActiveInstrument(): InstrumentDefinition {
  const { instruments } = useServices();
  const id = useActiveInstrumentId();
  return instruments.get(id)!;
}

/** Select from the ACTIVE instrument's market state. Switching instruments switches stores. */
export function useMarket<S>(selector: (s: MarketState) => S): S {
  const { market } = useServices();
  const id = useActiveInstrumentId();
  return useStore(market.store(id), selector);
}
