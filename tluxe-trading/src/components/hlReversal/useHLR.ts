import { useServices } from '../../app/servicesContext';
import { useActiveInstrumentId } from '../../hooks/useMarket';
import type { HLRInstrumentState } from '../../services/hlReversal/HLRService';
import { useStore } from '../../store/createStore';

/** Active instrument's live High / Low Reversal state (computed by the service, never in React). */
export function useHLRState<T>(selector: (s: HLRInstrumentState) => T): T {
  const { hlReversal } = useServices();
  const id = useActiveInstrumentId();
  return useStore(hlReversal.store(id), selector);
}
