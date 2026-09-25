import { INSTRUMENTS } from '../config/instruments';
import type { EconomicEvent } from '../types/calendar';
import type { InstrumentDefinition } from '../types/instruments';
import type { NewsItem } from '../types/news';
import type { ProviderStatus } from '../types/providers';
import { NullAiProvider, type AiProvider } from './ai/AiProvider';
import { AiService } from './ai/AiService';
import { createCalendarService, type CalendarProvider, type CalendarService } from './calendar/CalendarProvider';
import { NullFeedProvider } from './feed/FeedProvider';
import { InstrumentSelection } from './instruments/InstrumentSelection';
import type { DepthProvider } from './market/DepthProvider';
import { NO_ORDER_FLOW_PROVIDERS, type OrderFlowProviders } from '../providers/orderFlow/types';
import { OrderFlowService } from './orderFlow/OrderFlowService';
import { MarketDataService } from './market/MarketDataService';
import type { MarketDataProvider } from './market/MarketDataProvider';
import { createNewsService, type NewsProvider, type NewsService } from './news/NewsProvider';
import { SRService } from './sr/SRService';
import { LiquidityService } from './liquidity/LiquidityService';
import { OrderBlockService } from './orderBlocks/OrderBlockService';
import { HLRService } from './hlReversal/HLRService';
import { HighLowEngineService } from './highLowEngine/HighLowEngineService';
import { loadMt5Config } from './mt5/config';
import { Mt5Provider } from './mt5/Mt5Provider';

export interface Services {
  instruments: InstrumentSelection;
  market: MarketDataService;
  news: NewsService;
  calendar: CalendarService;
  ai: AiService;
  /** Support & Resistance engine runtime (real candles only). */
  sr: SRService;
  /** Liquidity Engine v1 runtime (real candles only; independent of S&R). */
  liquidity: LiquidityService;
  /** Order Block Engine v1 runtime (real candles only; independent of S&R and Liquidity). */
  orderBlocks: OrderBlockService;
  hlReversal: HLRService;
  highLow: HighLowEngineService;
  /** Order flow / Liquidity Heatmap runtime (exchange Level-2 + time & sales only; never MT5). */
  orderFlow: OrderFlowService;
  /** MT5 price provider, when enabled in Settings (null otherwise). */
  mt5: Mt5Provider | null;
  /** Phase 1 has no persistence layer. */
  databaseStatus: ProviderStatus;
}

export interface ProviderSet {
  /** Price feeds in priority order (e.g. futures vendor, MT5, crypto exchange). */
  price: MarketDataProvider[];
  /** Order-book / depth feeds (e.g. Bookmap). Independent of price feeds. */
  depth: DepthProvider[];
  news: NewsProvider;
  calendar: CalendarProvider;
  ai: AiProvider;
  /** Exchange Level-2 depth + time & sales for futures (e.g. GC). None connected by default. */
  orderFlow?: OrderFlowProviders;
}

export interface ServiceOptions {
  instruments?: readonly InstrumentDefinition[];
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Tests and the dev harness only: allow TEST order-flow providers (refused otherwise). */
  allowTestProviders?: boolean;
}

/**
 * Phase 1 wiring: no real providers exist yet. Price and depth lists are empty,
 * so every instrument reports DATA UNAVAILABLE / Provider: Not Connected.
 * Connecting MT5 or Bookmap later = implement the interface and add it here.
 */
export function defaultProviders(storage: Pick<Storage, 'getItem' | 'setItem'> | null = null): ProviderSet {
  // Real MT5 data only when the user has configured and enabled the private bridge.
  const mt5 = loadMt5Config(storage);
  return {
    price: mt5.enabled && mt5.token ? [new Mt5Provider(mt5)] : [],
    depth: [],
    news: new NullFeedProvider<NewsItem>(),
    calendar: new NullFeedProvider<EconomicEvent>(),
    ai: new NullAiProvider(),
  };
}

export function createServices(providers: ProviderSet = defaultProviders(), opts: ServiceOptions = {}): Services {
  const instruments = opts.instruments ?? INSTRUMENTS;
  const selection = new InstrumentSelection(instruments, opts.storage);
  const market = new MarketDataService({ instruments, price: providers.price, depth: providers.depth });
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  return {
    instruments: selection,
    market,
    news: createNewsService(providers.news),
    calendar: createCalendarService(providers.calendar),
    ai: new AiService(providers.ai),
    sr: new SRService(market, selection, storage),
    liquidity: new LiquidityService(market, selection),
    orderBlocks: new OrderBlockService(market, selection),
    hlReversal: new HLRService(market, selection),
    highLow: new HighLowEngineService(market, selection, storage),
    orderFlow: new OrderFlowService(selection, orderFlowProviders(providers.orderFlow, opts.allowTestProviders ?? false)),
    mt5: (providers.price.find((p) => p instanceof Mt5Provider) as Mt5Provider | undefined) ?? null,
    databaseStatus: 'NOT_CONNECTED',
  };
}

/** Production never runs on TEST order-flow data: a test provider is refused unless explicitly allowed. */
function orderFlowProviders(p: OrderFlowProviders | undefined, allowTest: boolean): OrderFlowProviders {
  if (!p) return NO_ORDER_FLOW_PROVIDERS;
  const ok = (x: { info: { test?: boolean } } | null) => !!x && (!x.info.test || allowTest);
  return { depth: ok(p.depth) ? p.depth : null, trade: ok(p.trade) ? p.trade : null };
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const connected = new WeakMap<Services, () => void>();

/**
 * Connects providers and keeps the market subscription on the selected instrument.
 * Idempotent: a second call returns the existing teardown instead of opening
 * duplicate provider connections / polling loops.
 */
export function connectServices(s: Services): () => void {
  const existing = connected.get(s);
  if (existing) return existing;
  s.market.connect();
  s.news.connect();
  s.calendar.connect();
  s.market.activate(s.instruments.store.getState().activeId);
  const stop = s.instruments.store.subscribe(() => s.market.activate(s.instruments.store.getState().activeId));
  const stopSR = s.sr.start();
  const stopLiquidity = s.liquidity.start();
  const stopOrderBlocks = s.orderBlocks.start();
  const stopHLR = s.hlReversal.start();
  const stopHighLow = s.highLow.start();
  const stopOrderFlow = s.orderFlow.start();
  const teardown = () => {
    if (connected.get(s) !== teardown) return;
    connected.delete(s);
    stop();
    stopSR();
    stopLiquidity();
    stopOrderBlocks();
    stopHLR();
    stopHighLow();
    stopOrderFlow();
    s.market.disconnect();
    s.news.disconnect();
    s.calendar.disconnect();
  };
  connected.set(s, teardown);
  return teardown;
}
