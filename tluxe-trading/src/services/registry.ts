import { GC_INSTRUMENT } from '../config/instrument';
import type { EconomicEvent } from '../types/calendar';
import type { NewsItem } from '../types/news';
import type { ProviderStatus } from '../types/providers';
import { NullAiProvider, type AiProvider } from './ai/AiProvider';
import { AiService } from './ai/AiService';
import { createCalendarService, type CalendarProvider, type CalendarService } from './calendar/CalendarProvider';
import { NullFeedProvider } from './feed/FeedProvider';
import { MarketDataService } from './market/MarketDataService';
import type { MarketDataProvider } from './market/MarketDataProvider';
import { NullMarketDataProvider } from './market/NullMarketDataProvider';
import { createNewsService, type NewsProvider, type NewsService } from './news/NewsProvider';

export interface Services {
  market: MarketDataService;
  news: NewsService;
  calendar: CalendarService;
  ai: AiService;
  /** Phase 1 has no persistence layer. */
  databaseStatus: ProviderStatus;
}

export interface ProviderSet {
  market: MarketDataProvider;
  news: NewsProvider;
  calendar: CalendarProvider;
  ai: AiProvider;
}

/**
 * Phase 1 wiring: no real providers exist yet, so every slot uses its Null
 * implementation. Connecting a real feed later = implementing the interface
 * and swapping it in here — no dashboard changes required.
 */
export function defaultProviders(): ProviderSet {
  return {
    market: new NullMarketDataProvider(),
    news: new NullFeedProvider<NewsItem>(),
    calendar: new NullFeedProvider<EconomicEvent>(),
    ai: new NullAiProvider(),
  };
}

export function createServices(providers: ProviderSet = defaultProviders()): Services {
  return {
    market: new MarketDataService(providers.market, GC_INSTRUMENT),
    news: createNewsService(providers.news),
    calendar: createCalendarService(providers.calendar),
    ai: new AiService(providers.ai),
    databaseStatus: 'NOT_CONNECTED',
  };
}

export function connectServices(s: Services): () => void {
  s.market.connect();
  s.news.connect();
  s.calendar.connect();
  return () => {
    s.market.disconnect();
    s.news.disconnect();
    s.calendar.disconnect();
  };
}
