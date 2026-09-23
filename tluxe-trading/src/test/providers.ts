import { vi } from 'vitest';
import type { DepthProvider, DepthSink } from '../services/market/DepthProvider';
import type { MarketDataProvider, MarketDataSink } from '../services/market/MarketDataProvider';
import type { InstrumentDefinition, ProviderFamily, ProviderMapping } from '../types/instruments';

/** Test double for a price feed of a given family. Tests drive `sink` directly. */
export class ManualPriceProvider implements MarketDataProvider {
  sink!: MarketDataSink;
  readonly subscribed: string[] = [];
  readonly mappings = new Map<string, ProviderMapping>();
  requestCandles = vi.fn();
  unsubscribe = vi.fn((id: string) => {
    const i = this.subscribed.indexOf(id);
    if (i >= 0) this.subscribed.splice(i, 1);
  });
  constructor(
    readonly family: ProviderFamily,
    readonly info = { id: `test-${family}`, name: `Test ${family}`, declaredDelaySec: null },
  ) {}
  connect(sink: MarketDataSink) {
    this.sink = sink;
  }
  disconnect() {}
  subscribe(instrument: InstrumentDefinition, mapping: ProviderMapping) {
    this.subscribed.push(instrument.id);
    this.mappings.set(instrument.id, mapping);
  }
}

export class ManualDepthProvider implements DepthProvider {
  readonly family = 'depth-feed' as const;
  readonly info = { id: 'test-depth', name: 'Test Depth', declaredDelaySec: null };
  sink!: DepthSink;
  readonly subscribed: string[] = [];
  connect(sink: DepthSink) {
    this.sink = sink;
  }
  disconnect() {}
  subscribe(instrument: InstrumentDefinition) {
    this.subscribed.push(instrument.id);
  }
  unsubscribe() {}
}

/** In-memory Storage stand-in. */
export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}
