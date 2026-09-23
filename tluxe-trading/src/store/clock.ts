import { useSyncExternalStore } from 'react';

/**
 * One shared, second-aligned ticker for the whole app. Components choose a
 * resolution so e.g. minute-resolution consumers re-render once a minute.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  timer = setTimeout(() => {
    now = Date.now();
    listeners.forEach((l) => l());
    schedule();
  }, 1000 - (Date.now() % 1000) + 5);
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export type ClockResolution = 'second' | 'minute';

export function useNow(resolution: ClockResolution = 'second'): number {
  return useSyncExternalStore(subscribe, () =>
    resolution === 'minute' ? Math.floor(now / 60000) * 60000 : Math.floor(now / 1000) * 1000,
  );
}
