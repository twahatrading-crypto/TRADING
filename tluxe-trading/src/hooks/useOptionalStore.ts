import { createStore, useStore, type Store } from '../store/createStore';

const NONE = createStore<Record<string, never>>({});

/** Subscribe to a store that may not exist (e.g. a replay session when replay is off). */
export function useOptionalStore<T extends object, S>(store: Store<T> | null | undefined, selector: (s: T) => S, fallback: S): S {
  return useStore((store ?? NONE) as Store<T>, (s) => (store ? selector(s) : fallback));
}
