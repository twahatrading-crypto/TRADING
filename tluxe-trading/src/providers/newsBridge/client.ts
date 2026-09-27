import type { BridgeFeedKind, BridgeHealth, CalendarPage, HeadlinePage } from './protocol';

export class NewsBridgeError extends Error {
  constructor(
    readonly code: 'UNAUTHORIZED' | 'OFFLINE' | 'TIMEOUT' | 'BAD_RESPONSE' | 'HTTP',
    message: string,
  ) {
    super(message);
    this.name = 'NewsBridgeError';
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Read-only client of the local news backend. Sends ONLY the backend token (header), never provider keys. */
export class NewsBridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  private async get<T>(path: string): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${this.token}` }, signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
      if (res.status === 401) throw new NewsBridgeError('UNAUTHORIZED', 'The news backend rejected the backend token (Settings → News Providers).');
      if (!res.ok) throw new NewsBridgeError('HTTP', `News backend error (HTTP ${res.status}).`);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof NewsBridgeError) throw e;
      if (ctl.signal.aborted) throw new NewsBridgeError('TIMEOUT', 'The news backend did not answer in time.');
      throw new NewsBridgeError('OFFLINE', 'The news backend is not reachable (start bridge\\news\\start_news.cmd).');
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<BridgeHealth> {
    return this.get('/v1/health');
  }
  calendar(since: number): Promise<CalendarPage> {
    return this.get(`/v1/calendar?since=${since}&limit=2000`);
  }
  headlines(feed: Exclude<BridgeFeedKind, 'calendar'>, since: number): Promise<HeadlinePage> {
    return this.get(`/v1/headlines?feed=${feed}&since=${since}&limit=500`);
  }
}
