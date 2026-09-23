import { useCallback, useState } from 'react';

/** useState backed by localStorage. Falls back to in-memory when storage is unavailable. */
export function usePersistentState<T>(key: string, initial: T, validate: (v: unknown) => v is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (validate(parsed)) return parsed;
      }
    } catch {
      /* storage blocked or corrupt — use default */
    }
    return initial;
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [key],
  );

  return [value, set] as const;
}
