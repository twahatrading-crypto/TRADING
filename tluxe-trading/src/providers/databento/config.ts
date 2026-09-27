/**
 * Databento BRIDGE connection settings (the local TLUXE bridge, NOT Databento itself). Stored in THIS browser only.
 * The Databento API key is NEVER configured, stored or sent here: it lives only in the bridge's server-side
 * environment (DATABENTO_API_KEY). The browser only knows the bridge URL and the bridge token.
 */
export interface DatabentoConfig {
  enabled: boolean;
  /** Bridge base URL, private by default (the bridge binds to 127.0.0.1). */
  bridgeUrl: string;
  /** TLUXE_DB_BRIDGE_TOKEN (not the Databento key). */
  token: string;
  /** Frame poll interval (the bridge batches ~250 ms frames; the UI never renders per market event). */
  pollMs: number;
  healthMs: number;
  requestTimeoutMs: number;
  /** No successful bridge response for this long -> OFFLINE. */
  offlineMs: number;
}

export const DATABENTO_CONFIG_KEY = 'tluxe.databento.config.v1';

export const DEFAULT_DATABENTO_CONFIG: Readonly<DatabentoConfig> = Object.freeze({
  enabled: false,
  bridgeUrl: 'http://127.0.0.1:8766',
  token: '',
  pollMs: 250,
  healthMs: 2000,
  requestTimeoutMs: 8000,
  offlineMs: 10_000,
});

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

export function sanitizeDatabentoConfig(input: unknown): DatabentoConfig {
  const d = DEFAULT_DATABENTO_CONFIG;
  const o = (input && typeof input === 'object' ? input : {}) as Partial<DatabentoConfig>;
  const url = typeof o.bridgeUrl === 'string' && /^https?:\/\/[^\s?#]+$/.test(o.bridgeUrl.trim()) ? o.bridgeUrl.trim().replace(/\/+$/, '') : d.bridgeUrl;
  const token = typeof o.token === 'string' ? o.token.trim() : '';
  return {
    enabled: o.enabled === true,
    bridgeUrl: url,
    // A Databento API key (db-...) must never be stored in the browser: refuse it outright.
    token: /^db-/i.test(token) ? '' : token,
    pollMs: num(o.pollMs, 100, 5000, d.pollMs),
    healthMs: num(o.healthMs, 500, 60000, d.healthMs),
    requestTimeoutMs: num(o.requestTimeoutMs, 1000, 60000, d.requestTimeoutMs),
    offlineMs: num(o.offlineMs, 2000, 120000, d.offlineMs),
  };
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export function loadDatabentoConfig(storage: KV | null): DatabentoConfig {
  try {
    const raw = storage?.getItem(DATABENTO_CONFIG_KEY);
    return sanitizeDatabentoConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeDatabentoConfig(null);
  }
}

export function saveDatabentoConfig(storage: KV | null, cfg: DatabentoConfig): void {
  try {
    storage?.setItem(DATABENTO_CONFIG_KEY, JSON.stringify(sanitizeDatabentoConfig(cfg)));
  } catch {
    /* storage blocked */
  }
}
