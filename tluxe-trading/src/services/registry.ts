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
import { MarketDataService } from './market/MarketDataService';
import type { MarketDataProvider } from './market/MarketDataProvider';
import { createNewsService, type NewsProvider, type NewsService } from './news/NewsProvider';
import { SRService } from './sr/SRService';

export interface Services {
  instruments: InstrumentSelection;
  market: MarketDataService;
  news: NewsService;
  calendar: CalendarService;
  ai: AiService;
  /** Support & Resistance engine runtime (real candles only). */
  sr: SRService;
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
}

export interface ServiceOptions {
  instruments?: readonly InstrumentDefinition[];
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/**
 * Phase 1 wiring: no real providers exist yet. Price and depth lists are empty,
 * so every instrument reports DATA UNAVAILABLE / Provider: Not Connected.
 * Connecting MT5 or Bookmap later = implement the interface and add it here.
 */
export function defaultProviders(): ProviderSet {
  return {
    price: [],
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
    databaseStatus: 'NOT_CONNECTED',
  };
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Connects providers and keeps the market subscription on the selected instrument. */
export function connectServices(s: Services): () => void {
  s.market.connect();
  s.news.connect();
  s.calendar.connect();
  s.market.activate(s.instruments.store.getState().activeId);
  const stop = s.instruments.store.subscribe(() => s.market.activate(s.instruments.store.getState().activeId));
  const stopSR = s.sr.start();
  return () => {
    stop();
    stopSR();
    s.market.disconnect();
    s.news.disconnect();
    s.calendar.disconnect();
  };
}
