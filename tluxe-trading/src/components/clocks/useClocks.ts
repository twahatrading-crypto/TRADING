import { CLOCK_CATALOG, DEFAULT_CLOCKS, MAX_CLOCKS, type ClockConfig } from '../../config/clocks';
import { usePersistentState } from '../../hooks/usePersistentState';
import { isValidTimeZone } from '../../utils/time';

const isClockList = (v: unknown): v is ClockConfig[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (c) =>
      c && typeof c === 'object' &&
      typeof (c as ClockConfig).id === 'string' &&
      typeof (c as ClockConfig).city === 'string' &&
      typeof (c as ClockConfig).timeZone === 'string' &&
      isValidTimeZone((c as ClockConfig).timeZone),
  );

export function useClocks() {
  const [clocks, setClocks] = usePersistentState<ClockConfig[]>('tluxe.clocks.v1', DEFAULT_CLOCKS, isClockList);
  const available = CLOCK_CATALOG.filter((c) => !clocks.some((x) => x.id === c.id));
  return {
    clocks,
    available,
    canAdd: clocks.length < MAX_CLOCKS && available.length > 0,
    add: (id: string) => {
      const c = CLOCK_CATALOG.find((x) => x.id === id);
      if (c && clocks.length < MAX_CLOCKS) setClocks([...clocks, c]);
    },
    remove: (id: string) => {
      if (clocks.length > 1) setClocks(clocks.filter((c) => c.id !== id));
    },
    reset: () => setClocks(DEFAULT_CLOCKS),
  };
}
