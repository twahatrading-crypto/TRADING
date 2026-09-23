import { DEFAULT_INSTRUMENT_ID } from '../../config/instruments';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';

export const SELECTED_INSTRUMENT_KEY = 'tluxe.instrument.v1';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface SelectionState {
  activeId: InstrumentId;
}

/**
 * The single source of truth for which instrument the dashboard shows.
 * Persisted between sessions; an unknown stored id falls back to the default.
 */
export class InstrumentSelection {
  readonly store: Store<SelectionState>;
  private readonly byId: Map<InstrumentId, InstrumentDefinition>;

  constructor(
    instruments: readonly InstrumentDefinition[],
    private readonly storage: KeyValueStorage | null = browserStorage(),
    defaultId: InstrumentId = DEFAULT_INSTRUMENT_ID,
  ) {
    this.byId = new Map(instruments.map((i) => [i.id, i]));
    if (!this.byId.has(defaultId)) throw new Error(`Default instrument "${defaultId}" is not registered`);
    let initial = defaultId;
    try {
      const stored = this.storage?.getItem(SELECTED_INSTRUMENT_KEY);
      if (stored && this.byId.has(stored)) initial = stored;
    } catch {
      /* storage blocked */
    }
    this.store = createStore<SelectionState>({ activeId: initial });
  }

  get(id: InstrumentId): InstrumentDefinition | undefined {
    return this.byId.get(id);
  }

  get list(): InstrumentDefinition[] {
    return [...this.byId.values()];
  }

  get active(): InstrumentDefinition {
    return this.byId.get(this.store.getState().activeId)!;
  }

  select(id: InstrumentId): void {
    if (!this.byId.has(id)) throw new Error(`Unknown instrument "${id}"`);
    if (id === this.store.getState().activeId) return;
    this.store.setState({ activeId: id });
    try {
      this.storage?.setItem(SELECTED_INSTRUMENT_KEY, id);
    } catch {
      /* storage blocked — selection still applies for this session */
    }
  }
}
