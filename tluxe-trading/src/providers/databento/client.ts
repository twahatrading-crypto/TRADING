import type { DbBookResponse, DbCandlesResponse, DbFeedResponse, DbHealth, DbRoot, DbTradesResponse } from './protocol';

export class DatabentoBridgeOffline extends Error {
  constructor() {
    super('Databento bridge is not reachable');
    this.name = 'DatabentoBridgeOffline';
  }
}
export class DatabentoBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DatabentoBridgeError';
  }
}

type FetchLike = typeof fetch;

/** Thin authenticated client for the LOCAL bridge. Only the bridge token is sent (Authorization header, never a URL). */
export class DatabentoBridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = (...a) => fetch(...a),
  ) {}

  private async get<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: ctrl.signal, cache: 'no-store' });
    } catch {
      throw new DatabentoBridgeOffline();
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
      throw new DatabentoBridgeError(err?.code ?? `HTTP_${res.status}`, err?.message ?? `Bridge responded ${res.status}`, res.status);
    }
    return body as T;
  }

  health = () => this.get<DbHealth>('/v1/health');
  feed = (cursor: number, roots: DbRoot[]) => this.get<DbFeedResponse>(`/v1/feed?cursor=${cursor}&roots=${roots.join(',')}`);
  book = (root: DbRoot) => this.get<DbBookResponse>(`/v1/book/${root}`);
  trades = (root: DbRoot, after: number, limit = 20000) => this.get<DbTradesResponse>(`/v1/trades/${root}?after=${after}&limit=${limit}`);
  candles = (root: DbRoot, tf: string, limit = 5000) => this.get<DbCandlesResponse>(`/v1/candles/${root}?timeframe=${tf}&limit=${limit}`);
}
