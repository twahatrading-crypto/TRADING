import { createStore, type Store } from '../../store/createStore';
import { EMPTY_QUOTE, type Candle, type InstrumentInfo, type MarketState, type Timeframe } from '../../types/market';
import type { MarketDataProvider, MarketDataSink } from './MarketDataProvider';
import { mergeQuote, normalizeCandles } from './normalize';

type CandleListener = (candles: readonly Candle[], changed: 'replace' | 'upsert') => void;

/**
 * Owns the provider connection and the normalized market state.
 * Quote state lives in a React-subscribable store; candle arrays live outside
 * React and are pushed straight to chart consumers for cheap incremental updates.
 */
export class MarketDataService {
  readonly store: Store<MarketState>;
  private readonly candles = new Map<Timeframe, Candle[]>();
  private readonly candleListeners = new Map<Timeframe, Set<CandleListener>>();
  private readonly provider: MarketDataProvider;

  constructor(provider: MarketDataProvider, instrument: InstrumentInfo, private readonly clock: () => number = Date.now) {
    this.provider = provider;
    this.store = createStore<MarketState>({
      instrument,
      provider: provider.info,
      connection: provider.info ? 'DISCONNECTED' : 'UNAVAILABLE',
      quote: { ...EMPTY_QUOTE },
      lastMessageAt: null,
      error: null,
    });
  }

  private readonly sink: MarketDataSink = {
    connection: (connection, error = null) => this.store.setState({ connection, error }),
    quote: (update, instrument) =>
      this.store.setState((s) => ({
        ...s,
        quote: mergeQuote(s.quote, update),
        instrument: instrument?.contract !== undefined ? { ...s.instrument, contract: instrument.contract } : s.instrument,
        lastMessageAt: this.clock(),
      })),
    candles: (tf, incoming, mode) => {
      const clean = normalizeCandles(incoming);
      if (mode === 'replace') {
        this.candles.set(tf, clean);
      } else {
        const current = this.candles.get(tf) ?? [];
        this.candles.set(tf, normalizeCandles([...current, ...clean]));
      }
      this.store.setState({ lastMessageAt: this.clock() });
      const data = this.candles.get(tf) ?? [];
      this.candleListeners.get(tf)?.forEach((l) => l(data, mode));
    },
  };

  connect(): void {
    this.provider.connect(this.store.getState().instrument.symbol, this.sink);
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  getCandles(tf: Timeframe): readonly Candle[] {
    return this.candles.get(tf) ?? [];
  }

  /** Subscribe to candle updates for a timeframe; requests history on first subscribe. */
  subscribeCandles(tf: Timeframe, listener: CandleListener): () => void {
    let set = this.candleListeners.get(tf);
    if (!set) {
      set = new Set();
      this.candleListeners.set(tf, set);
      this.provider.requestCandles(tf);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
}
