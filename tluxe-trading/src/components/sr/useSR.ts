import { useServices } from '../../app/servicesContext';
import type { SRSettings } from '../../engines/sr/settings';
import { useActiveInstrumentId } from '../../hooks/useMarket';
import { useStore } from '../../store/createStore';
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
