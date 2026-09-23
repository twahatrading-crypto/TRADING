import type { EconomicEvent } from '../../types/calendar';
import { FeedService } from '../feed/FeedService';
import type { FeedProvider } from '../feed/FeedProvider';

export type CalendarProvider = FeedProvider<EconomicEvent>;

const IMPORTANCE = new Set(['LOW', 'MEDIUM', 'HIGH']);
const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function normalizeEconomicEvent(e: EconomicEvent): EconomicEvent | null {
  if (!e.id || !e.event?.trim() || !Number.isFinite(e.time) || !IMPORTANCE.has(e.importance)) return null;
  return {
    ...e,
    event: e.event.trim(),
    country: e.country.toUpperCase(),
    previous: clean(e.previous),
    forecast: clean(e.forecast),
    actual: clean(e.actual),
  };
}

export function createCalendarService(provider: CalendarProvider, clock?: () => number) {
  return new FeedService<EconomicEvent>(
    provider,
    {
      normalize: normalizeEconomicEvent,
      key: (e) => e.id,
      sort: (a, b) => a.time - b.time,
      maxItems: 200,
    },
    clock,
  );
}

export type CalendarService = ReturnType<typeof createCalendarService>;
