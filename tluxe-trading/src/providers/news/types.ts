import type { NewsImpact, NewsLatency, NewsProviderKind } from '../../engines/news/types';

/* ============================================================================
 * NEWS PROVIDER CONTRACT (vendor-neutral). An adapter (e.g. a licensed economic-calendar API, a
 * newswire, a broker calendar exposed by the TLUXE bridge) converts its payload into these RAW
 * shapes; `engines/news/normalize.ts` turns them into point-in-time NewsUpdates.
 *   - Capabilities are declared by the adapter (latency / delay) and never upgraded by TLUXE.
 *   - Adapters must never invent values: missing Actual / Forecast / Previous = null.
 *   - API keys / credentials come from environment configuration, never from source code or logs.
 * ========================================================================== */

export interface NewsProviderInfo {
  id: string;
  name: string;
  kind: NewsProviderKind;
  latency: NewsLatency;
  /** Declared delay (s) for DELAYED sources. */
  delaySec: number | null;
  /** No message (items or heartbeat) for this long → STALE. */
  staleAfterMs: number;
  /** TEST DATA provider — refused by the registry unless explicitly allowed. */
  test?: boolean;
}

export type NewsFeedStatus = 'NOT_CONNECTED' | 'CONNECTING' | 'LIVE' | 'DELAYED' | 'STALE' | 'DISCONNECTED' | 'ERROR';

/** Raw calendar row as an adapter delivers it. Times: epoch ms or ISO-8601 with an explicit offset. */
export interface RawCalendarEvent {
  id: string;
  time: number | string;
  title: string;
  country?: string | null;
  currency?: string | null;
  impact?: NewsImpact | 'high' | 'medium' | 'low' | null;
  actual?: string | number | null;
  forecast?: string | number | null;
  previous?: string | number | null;
  /** Provider's own "last updated / actual published" time (ms or ISO). */
  updatedAt?: number | string | null;
  cancelled?: boolean;
  category?: string | null;
  url?: string | null;
  instruments?: string[];
}

/** Raw breaking / macro headline. */
export interface RawHeadline {
  id: string;
  publishedAt: number | string;
  headline: string;
  source?: string | null;
  url?: string | null;
  category?: string | null;
  impact?: NewsImpact | 'high' | 'medium' | 'low' | null;
  country?: string | null;
  currency?: string | null;
  instruments?: string[];
}

export interface NewsProviderSink<T> {
  items(items: T[]): void;
  heartbeat(): void;
  status(status: NewsFeedStatus, detail?: string | null): void;
}

interface Base<T> {
  readonly info: NewsProviderInfo;
  connect(sink: NewsProviderSink<T>): void;
  disconnect(): void;
}
export type EconomicCalendarProvider = Base<RawCalendarEvent>;
export type BreakingNewsProvider = Base<RawHeadline>;
export type MacroNewsProvider = Base<RawHeadline>;

export interface NewsProviders {
  calendar: EconomicCalendarProvider | null;
  breaking: BreakingNewsProvider | null;
  macro: MacroNewsProvider | null;
}
export const NO_NEWS_PROVIDERS: NewsProviders = Object.freeze({ calendar: null, breaking: null, macro: null });
