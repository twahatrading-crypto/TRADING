import { createStore, type Store } from '../../store/createStore';
import {
  DEPTH_CAPABILITIES,
  type DataCapability,
  type InstrumentDefinition,
  type InstrumentId,
  type ProviderMapping,
} from '../../types/instruments';
import { EMPTY_QUOTE, type Candle, type InstrumentInfo, type MarketState, type Timeframe } from '../../types/market';
import type { DepthProvider, DepthSink, DepthSnapshot } from './DepthProvider';
import type { MarketDataProvider, MarketDataSink } from './MarketDataProvider';
import { mergeQuote, normalizeCandles } from './normalize';

type CandleListener = (candles: readonly Candle[], changed: 'replace' | 'upsert') => void;
type DepthListener = (book: DepthSnapshot) => void;

interface Route<P> {
  provider: P;
  mapping: ProviderMapping;
}

export interface MarketDataServiceOptions {
  instruments: readonly InstrumentDefinition[];
  price?: readonly MarketDataProvider[];
  depth?: readonly DepthProvider[];
  clock?: () => number;
}

export function toInstrumentInfo(def: InstrumentDefinition): InstrumentInfo {
  return {
    id: def.id,
    symbol: def.shortName,
    displayName: def.displayName,
    name: def.name,
    assetClass: def.assetClass,
    exchange: def.exchange,
    venue: def.venue,
    currency: def.currency,
    priceDecimals: def.pricePrecision,
    contract: null,
  };
}

const candleKey = (id: InstrumentId, tf: Timeframe) => `${id}|${tf}`;
const hasAny = (caps: readonly DataCapability[], wanted: readonly DataCapability[]) => wanted.some((c) => caps.includes(c));

/**
 * Multi-instrument market-data hub.
 *
 * - One store per instrument; nothing is shared between instruments, so
 *   switching can never show another instrument's data.
 * - Price and depth are routed independently from each instrument's mappings.
 * - A provider may only update instruments routed to it, and only with data
 *   its mapping declares; everything else is dropped.
 * - Candles/books live outside React and are pushed straight to consumers.
 */
export class MarketDataService {
  private readonly defs = new Map<InstrumentId, InstrumentDefinition>();
  private readonly stores = new Map<InstrumentId, Store<MarketState>>();
  private readonly priceRoutes = new Map<InstrumentId, Route<MarketDataProvider>>();
  private readonly depthRoutes = new Map<InstrumentId, Route<DepthProvider>>();
  private readonly candles = new Map<string, Candle[]>();
  private readonly candleListeners = new Map<string, Set<CandleListener>>();
  private readonly books = new Map<InstrumentId, DepthSnapshot>();
  private readonly depthListeners = new Map<InstrumentId, Set<DepthListener>>();
  private readonly subscribed = new Set<InstrumentId>();
  private readonly priceProviders: readonly MarketDataProvider[];
  private readonly depthProviders: readonly DepthProvider[];
  private readonly clock: () => number;

  constructor(opts: MarketDataServiceOptions) {
    this.priceProviders = opts.price ?? [];
    this.depthProviders = opts.depth ?? [];
    this.clock = opts.clock ?? Date.now;

    for (const def of opts.instruments) {
      this.defs.set(def.id, def);
      const price = this.route(def, 'price', this.priceProviders);
      const depth = this.route(def, 'depth', this.depthProviders);
      if (price) this.priceRoutes.set(def.id, price);
      if (depth) this.depthRoutes.set(def.id, depth);
      this.stores.set(
        def.id,
        createStore<MarketState>({
          instrument: toInstrumentInfo(def),
          provider: price?.provider.info ?? null,
          connection: price ? 'DISCONNECTED' : 'UNAVAILABLE',
          quote: { ...EMPTY_QUOTE },
          lastMessageAt: null,
          error: null,
          depth: {
            supported: def.providerMappings.some((m) => m.role === 'depth'),
            provider: depth?.provider.info ?? null,
            connection: depth ? 'DISCONNECTED' : 'UNAVAILABLE',
            lastMessageAt: null,
            error: null,
          },
          capabilities: [],
          feed: null,
        }),
      );
    }
  }

  /** First provider (in registration order) whose family has a mapping for this role. */
  private route<P extends { family: string }>(def: InstrumentDefinition, role: 'price' | 'depth', providers: readonly P[]): Route<P> | null {
    for (const provider of providers) {
      const mapping = def.providerMappings.find((m) => m.role === role && m.family === provider.family);
      if (mapping) return { provider, mapping };
    }
    return null;
  }

  has(id: InstrumentId): boolean {
    return this.stores.has(id);
  }

  store(id: InstrumentId): Store<MarketState> {
    const s = this.stores.get(id);
    if (!s) throw new Error(`Unknown instrument "${id}"`);
    return s;
  }

  private ownedPrice(provider: MarketDataProvider, id: InstrumentId): Route<MarketDataProvider> | null {
    const r = this.priceRoutes.get(id);
    return r && r.provider === provider ? r : null;
  }

  private ownedDepth(provider: DepthProvider, id: InstrumentId): Route<DepthProvider> | null {
    const r = this.depthRoutes.get(id);
    return r && r.provider === provider ? r : null;
  }

  private setSupplied(id: InstrumentId, role: 'price' | 'depth', caps: DataCapability[]) {
    const store = this.store(id);
    const keep = store.getState().capabilities.filter((c) => (role === 'price' ? DEPTH_CAPABILITIES.includes(c) : !DEPTH_CAPABILITIES.includes(c)));
    store.setState({ capabilities: [...new Set([...keep, ...caps])] });
  }

  private priceSink(provider: MarketDataProvider): MarketDataSink {
    return {
      connection: (id, connection, error = null) => {
        if (!this.ownedPrice(provider, id)) return;
        this.store(id).setState({ connection, error });
      },
      capabilities: (id, caps) => {
        const r = this.ownedPrice(provider, id);
        if (r) this.setSupplied(id, 'price', caps.filter((c) => r.mapping.capabilities.includes(c) && !DEPTH_CAPABILITIES.includes(c)));
      },
      quote: (id, update, meta) => {
        const r = this.ownedPrice(provider, id);
        if (!r || !r.mapping.capabilities.includes('quote')) return;
        this.store(id).setState((s) => ({
          ...s,
          quote: mergeQuote(s.quote, update),
          instrument: meta?.contract !== undefined ? { ...s.instrument, contract: meta.contract } : s.instrument,
          lastMessageAt: this.clock(),
        }));
      },
      candles: (id, tf, incoming, mode) => {
        const r = this.ownedPrice(provider, id);
        if (!r || !hasAny(r.mapping.capabilities, ['ohlcv', 'historicalCandles'])) return;
        const key = candleKey(id, tf);
        const clean = normalizeCandles(mode === 'replace' ? incoming : [...(this.candles.get(key) ?? []), ...incoming]);
        this.candles.set(key, clean);
        this.store(id).setState({ lastMessageAt: this.clock() });
        this.candleListeners.get(key)?.forEach((l) => l(clean, mode));
      },
      feed: (id, detail) => {
        if (!this.ownedPrice(provider, id)) return;
        this.store(id).setState((s) => ({
          ...s,
          feed: detail,
          // Broker metadata may refine display precision; the instrument identity never changes.
          instrument:
            detail.meta?.digits != null && detail.meta.digits !== s.instrument.priceDecimals
              ? { ...s.instrument, priceDecimals: detail.meta.digits }
              : s.instrument,
        }));
      },
    };
  }

  private depthSink(provider: DepthProvider): DepthSink {
    return {
      connection: (id, connection, error = null) => {
        if (!this.ownedDepth(provider, id)) return;
        this.store(id).setState((s) => ({ ...s, depth: { ...s.depth, connection, error } }));
      },
      capabilities: (id, caps) => {
        const r = this.ownedDepth(provider, id);
        if (r) this.setSupplied(id, 'depth', caps.filter((c) => r.mapping.capabilities.includes(c) && DEPTH_CAPABILITIES.includes(c)));
      },
      book: (snapshot) => {
        const r = this.ownedDepth(provider, snapshot.instrumentId);
        if (!r || !hasAny(r.mapping.capabilities, DEPTH_CAPABILITIES)) return;
        this.books.set(snapshot.instrumentId, snapshot);
        this.store(snapshot.instrumentId).setState((s) => ({ ...s, depth: { ...s.depth, lastMessageAt: this.clock() } }));
        this.depthListeners.get(snapshot.instrumentId)?.forEach((l) => l(snapshot));
      },
    };
  }

  connect(): void {
    this.priceProviders.forEach((p) => p.connect(this.priceSink(p)));
    this.depthProviders.forEach((p) => p.connect(this.depthSink(p)));
  }

  disconnect(): void {
    this.subscribed.forEach((id) => this.release(id));
    this.priceProviders.forEach((p) => p.disconnect());
    this.depthProviders.forEach((p) => p.disconnect());
  }

  /** Make `id` the streaming instrument. Other subscriptions are released. */
  activate(id: InstrumentId): void {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Unknown instrument "${id}"`);
    for (const other of [...this.subscribed]) if (other !== id) this.release(other);
    if (this.subscribed.has(id)) return;
    this.subscribed.add(id);
    const price = this.priceRoutes.get(id);
    const depth = this.depthRoutes.get(id);
    price?.provider.subscribe(def, price.mapping);
    depth?.provider.subscribe(def, depth.mapping);
  }

  private release(id: InstrumentId) {
    this.subscribed.delete(id);
    this.priceRoutes.get(id)?.provider.unsubscribe(id);
    this.depthRoutes.get(id)?.provider.unsubscribe(id);
  }

  getCandles(id: InstrumentId, tf: Timeframe): readonly Candle[] {
    return this.candles.get(candleKey(id, tf)) ?? [];
  }

  /** Subscribe to one instrument's candles on one timeframe; requests history on first subscribe. */
  subscribeCandles(id: InstrumentId, tf: Timeframe, listener: CandleListener): () => void {
    const key = candleKey(id, tf);
    let set = this.candleListeners.get(key);
    if (!set) {
      set = new Set();
      this.candleListeners.set(key, set);
      this.priceRoutes.get(id)?.provider.requestCandles(id, tf);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  getDepth(id: InstrumentId): DepthSnapshot | null {
    return this.books.get(id) ?? null;
  }

  subscribeDepth(id: InstrumentId, listener: DepthListener): () => void {
    let set = this.depthListeners.get(id);
    if (!set) this.depthListeners.set(id, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }
}
