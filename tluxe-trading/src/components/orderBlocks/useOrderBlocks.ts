import { useSyncExternalStore } from 'react';
import { useServices } from '../../app/servicesContext';
import type { OBSettings } from '../../engines/orderBlocks/config';
import { useActiveInstrumentId } from '../../hooks/useMarket';
import type { OBInstrumentState } from '../../services/orderBlocks/OrderBlockService';
import { useStore } from '../../store/createStore';

/** Active instrument's live Order Block state (computed by the service, never in React). */
export function useOrderBlockState<T>(selector: (s: OBInstrumentState) => T): T {
  const { orderBlocks } = useServices();
  const id = useActiveInstrumentId();
  return useStore(orderBlocks.store(id), selector);
}

/** Current Order Block engine settings (changes only through `configure`). */
export function useOrderBlockSettings(): OBSettings {
  const { orderBlocks } = useServices();
  return useSyncExternalStore(
    (l) => orderBlocks.onSettings(l),
    () => orderBlocks.settings,
  );
}
