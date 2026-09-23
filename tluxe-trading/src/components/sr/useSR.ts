import { useServices } from '../../app/servicesContext';
import type { SRSettings } from '../../engines/sr/settings';
import { useActiveInstrumentId } from '../../hooks/useMarket';
import { createStore, useStore, type Store } from '../../store/createStore';
import type { SRInstrumentState } from '../../services/sr/SRService';

/** Active instrument's S&R state (snapshots come from the engine service, never computed in React). */
export function useSRState<T>(selector: (s: SRInstrumentState) => T): T {
  const { sr } = useServices();
  const id = useActiveInstrumentId();
  return useStore(sr.store(id), selector);
}

export function useSRSettings(): [SRSettings, (patch: Partial<SRSettings>) => void, () => void] {
  const { sr } = useServices();
  const settings = useStore(sr.settingsStore, (s) => s.settings);
  return [settings, (p) => sr.setSettings(p), () => sr.resetSettings()];
}

const NO_STORE = createStore<Record<string, never>>({});

/** Subscribe to a store that may not exist (e.g. the replay session when replay is off). */
export function useOptionalStore<T extends object, S>(store: Store<T> | null | undefined, selector: (s: T) => S, fallback: S): S {
  return useStore((store ?? NO_STORE) as Store<T>, (s) => (store ? selector(s) : fallback));
}
