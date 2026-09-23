import { useSyncExternalStore } from 'react';

/**
 * Minimal external store. Components subscribe through selectors so a change
 * re-renders only the components whose selected slice changed.
 */
export interface Store<T> {
  getState(): T;
  setState(next: Partial<T> | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(next) {
      const resolved = typeof next === 'function' ? next(state) : { ...state, ...next };
      if (Object.is(resolved, state)) return;
      state = resolved;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Selector must return a stable reference (a primitive or an existing object from state). */
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
