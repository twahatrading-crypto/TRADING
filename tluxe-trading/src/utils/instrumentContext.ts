import type { EconomicEvent } from '../types/calendar';
import type { InstrumentDefinition } from '../types/instruments';
import type { NewsItem } from '../types/news';

/** News relevant to an instrument: explicitly tagged, or sharing one of its topics. */
export function newsForInstrument(items: readonly NewsItem[], def: InstrumentDefinition): NewsItem[] {
  return items.filter((n) => n.instruments?.includes(def.id) || n.categories.some((c) => def.newsTopics.includes(c)));
}

/** Economic releases relevant to an instrument's currencies. Events without a currency are kept. */
export function eventsForInstrument(events: readonly EconomicEvent[], def: InstrumentDefinition): EconomicEvent[] {
  return events.filter((e) => e.currency === null || def.calendarCurrencies.includes(e.currency));
}
