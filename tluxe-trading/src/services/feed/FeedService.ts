import { createStore, type Store } from '../../store/createStore';
import type { ProviderSnapshot } from '../../types/providers';
import type { FeedProvider, FeedSink } from './FeedProvider';

export interface FeedOptions<T> {
  /** Validate / clean one upstream item; return null to drop it. */
  normalize: (item: T) => T | null;
  key: (item: T) => string;
  sort: (a: T, b: T) => number;
  maxItems: number;
}

export class FeedService<T> {
  readonly store: Store<ProviderSnapshot<T>>;

  constructor(
    private readonly provider: FeedProvider<T>,
    private readonly options: FeedOptions<T>,
    private readonly clock: () => number = Date.now,
  ) {
    this.store = createStore<ProviderSnapshot<T>>({
      status: 'NOT_CONNECTED',
      providerName: provider.name,
      items: [],
      lastUpdated: null,
      error: null,
    });
  }

  private readonly sink: FeedSink<T> = {
    status: (status, error = null) => this.store.setState({ status, error }),
    items: (incoming, mode) => {
      const { normalize, key, sort, maxItems } = this.options;
      const base = mode === 'append' ? this.store.getState().items : [];
      const byKey = new Map<string, T>();
      for (const item of [...base, ...incoming]) {
        const clean = normalize(item);
        if (clean) byKey.set(key(clean), clean);
      }
      const items = [...byKey.values()].sort(sort).slice(0, maxItems);
      this.store.setState({ items, lastUpdated: this.clock() });
    },
  };

  connect(): void {
    this.provider.connect(this.sink);
  }

  disconnect(): void {
    this.provider.disconnect();
  }
}
