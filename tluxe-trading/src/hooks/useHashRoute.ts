import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** Current hash path, e.g. "#/engines" → "/engines"; empty hash → "/". */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash.replace(/^#/, '') || '/');
}
