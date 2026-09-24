import { useServices } from '../../app/servicesContext';
import { useActiveInstrumentId } from '../../hooks/useMarket';
import { useStore } from '../../store/createStore';
import type { LiquidityInstrumentState } from '../../services/liquidity/LiquidityService';

/** Active instrument's live Liquidity state (computed by the service, never in React). */
export function useLiquidityState<T>(selector: (s: LiquidityInstrumentState) => T): T {
  const { liquidity } = useServices();
  const id = useActiveInstrumentId();
  return useStore(liquidity.store(id), selector);
}
