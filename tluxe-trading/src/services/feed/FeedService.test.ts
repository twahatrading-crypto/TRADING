import { describe, expect, it } from 'vitest';
import type { EconomicEvent } from '../../types/calendar';
import type { NewsItem } from '../../types/news';
import { createCalendarService } from '../calendar/CalendarProvider';
import { createNewsService } from '../news/NewsProvider';
import { NullFeedProvider, type FeedProvider, type FeedSink } from './FeedProvider';

class ManualFeed<T> implements FeedProvider<T> {
  readonly name = 'Manual';
  sink: FeedSink<T> | null = null;
  connect(sink: FeedSink<T>) {
    this.sink = sink;
  }
  disconnect() {}
}

describe('Null news / calendar providers', () => {
  it('report NOT_CONNECTED with no provider name and no items', () => {
    for (const svc of [createNewsService(new NullFeedProvider()), createCalendarService(new NullFeedProvider())]) {
      svc.connect();
      const s = svc.store.getState();
      expect(s.status).toBe('NOT_CONNECTED');
      expect(s.providerName).toBeNull();
      expect(s.items).toEqual([]);
      expect(s.lastUpdated).toBeNull();
    }
  });
});

describe('news normalization', () => {
  it('drops headline-less items, dedupes, sorts newest first', () => {
    const feed = new ManualFeed<NewsItem>();
    const svc = createNewsService(feed, () => 5);
    svc.connect();
    const n = (id: string, headline: string, publishedAt: number): NewsItem => ({
      id, headline, publishedAt, source: 'X', url: null, categories: ['GOLD', 'GOLD'],
    });
    feed.sink!.items([n('a', 'A', 1), n('b', '  ', 2), n('c', 'C', 3)], 'replace');
    const s = svc.store.getState();
    expect(s.items.map((i) => i.id)).toEqual(['c', 'a']);
    expect(s.items[0]!.categories).toEqual(['GOLD']);
    expect(s.lastUpdated).toBe(5);
  });
});

describe('calendar normalization', () => {
  it('keeps unpublished values as null, never "0"', () => {
    const feed = new ManualFeed<EconomicEvent>();
    const svc = createCalendarService(feed);
    svc.connect();
    feed.sink!.items(
      [{ id: '1', time: 10, country: 'us', currency: 'USD', event: 'CPI y/y', importance: 'HIGH', previous: '3.1%', forecast: '', actual: null }],
      'replace',
    );
    const e = svc.store.getState().items[0]!;
    expect(e).toMatchObject({ country: 'US', previous: '3.1%', forecast: null, actual: null });
  });

  it('rejects events with an unknown importance', () => {
    const feed = new ManualFeed<EconomicEvent>();
    const svc = createCalendarService(feed);
    svc.connect();
    feed.sink!.items(
      [{ id: '1', time: 10, country: 'US', currency: null, event: 'X', importance: 'EXTREME' as never, previous: null, forecast: null, actual: null }],
      'replace',
    );
    expect(svc.store.getState().items).toEqual([]);
  });
});
