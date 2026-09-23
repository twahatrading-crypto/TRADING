import type { Timeframe } from '../../types/market';
import type { BridgeHealth, BridgeQuote, BridgeRates, BridgeSymbol } from './protocol';

/** Network failure / timeout: the bridge process is not reachable. */
export class BridgeOfflineError extends Error {
  constructor(message = 'MT5 bridge is not reachable') {
    super(message);
    this.name = 'BridgeOfflineError';
  }
}

/** The bridge answered with an error (e.g. SYMBOL_NOT_FOUND, MT5_NOT_RUNNING, UNAUTHORIZED). */
export class BridgeResponseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BridgeResponseError';
  }
}

type FetchLike = typeof fetch;

/** Thin authenticated client. The token is sent only in the Authorization header. */
export class Mt5BridgeClient {
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
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch {
      throw new BridgeOfflineError();
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
      throw new BridgeResponseError(err?.code ?? `HTTP_${res.status}`, err?.message ?? `Bridge responded ${res.status}`, res.status);
    }
    return body as T;
  }

  health = () => this.get<BridgeHealth>('/v1/health');
  symbols = () => this.get<{ count: number; symbols: BridgeSymbol[] }>('/v1/symbols');
  symbol = (name: string) => this.get<BridgeSymbol>(`/v1/symbol/${encodeURIComponent(name)}`);
  quote = (name: string) => this.get<BridgeQuote>(`/v1/quote/${encodeURIComponent(name)}`);
  rates = (name: string, tf: Timeframe, count: number) =>
    this.get<BridgeRates>(`/v1/rates/${encodeURIComponent(name)}?timeframe=${tf}&count=${count}`);
}
