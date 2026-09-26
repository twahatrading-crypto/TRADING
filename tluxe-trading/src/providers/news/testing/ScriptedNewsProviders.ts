/**
 * TEST DATA ONLY — scripted news providers for unit tests and the bannered dev harness.
 * `info.test = true`: the registry refuses them unless `allowTestProviders` is set. Never production.
 */
import type { BreakingNewsProvider, EconomicCalendarProvider, NewsFeedStatus, NewsProviderInfo, NewsProviderSink, RawCalendarEvent, RawHeadline } from '../types';

class Scripted<T> {
  sink: NewsProviderSink<T> | null = null;
  connects = 0;
  disconnects = 0;
  constructor(readonly info: NewsProviderInfo, private readonly initial: T[] = [], private readonly initialStatus: NewsFeedStatus = 'LIVE') {}
  connect(sink: NewsProviderSink<T>): void {
    this.connects += 1;
    this.sink = sink;
    sink.status(this.initialStatus);
    if (this.initial.length) sink.items(this.initial);
  }
  disconnect(): void {
    this.disconnects += 1;
    this.sink = null;
  }
  push(items: T[]): void {
    this.sink?.items(items);
  }
  heartbeat(): void {
    this.sink?.heartbeat();
  }
  setStatus(s: NewsFeedStatus, detail?: string): void {
    this.sink?.status(s, detail ?? null);
  }
}

export class ScriptedCalendarProvider extends Scripted<RawCalendarEvent> implements EconomicCalendarProvider {}
export class ScriptedHeadlineProvider extends Scripted<RawHeadline> implements BreakingNewsProvider {}

export const TEST_CALENDAR_INFO: NewsProviderInfo = { id: 'test-calendar', name: 'TEST DATA — scripted calendar', kind: 'calendar', latency: 'REALTIME', delaySec: null, staleAfterMs: 10 * 60_000, test: true };
export const TEST_WIRE_INFO: NewsProviderInfo = { id: 'test-wire', name: 'TEST DATA — scripted headlines', kind: 'breaking', latency: 'DELAYED', delaySec: 60, staleAfterMs: 10 * 60_000, test: true };
