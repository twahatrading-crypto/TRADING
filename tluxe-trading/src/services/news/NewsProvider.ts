import type { NewsItem } from '../../types/news';
import { FeedService } from '../feed/FeedService';
import type { FeedProvider } from '../feed/FeedProvider';

export type NewsProvider = FeedProvider<NewsItem>;

export function normalizeNewsItem(item: NewsItem): NewsItem | null {
  if (!item.id || !item.headline?.trim() || !Number.isFinite(item.publishedAt)) return null;
  return { ...item, headline: item.headline.trim(), categories: [...new Set(item.categories)] };
}

export function createNewsService(provider: NewsProvider, clock?: () => number) {
  return new FeedService<NewsItem>(
    provider,
    {
      normalize: normalizeNewsItem,
      key: (n) => n.id,
      sort: (a, b) => b.publishedAt - a.publishedAt,
      maxItems: 100,
    },
    clock,
  );
}

export type NewsService = ReturnType<typeof createNewsService>;
