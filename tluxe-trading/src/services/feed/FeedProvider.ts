import type { ProviderStatus } from '../../types/providers';

/** Callbacks a feed adapter (news, calendar) uses to deliver data. */
export interface FeedSink<T> {
  status(status: ProviderStatus, error?: string | null): void;
  items(items: T[], mode: 'replace' | 'append'): void;
}

/** Generic contract for list-style feeds. Adapters normalize upstream payloads to T. */
export interface FeedProvider<T> {
  /** Display name, or null when no provider is configured. */
  readonly name: string | null;
  connect(sink: FeedSink<T>): void;
  disconnect(): void;
}

/** Stand-in used when no adapter is configured. Reports NOT_CONNECTED and never emits items. */
export class NullFeedProvider<T> implements FeedProvider<T> {
  readonly name = null;
  connect(sink: FeedSink<T>): void {
    sink.status('NOT_CONNECTED', null);
  }
  disconnect(): void {}
}
