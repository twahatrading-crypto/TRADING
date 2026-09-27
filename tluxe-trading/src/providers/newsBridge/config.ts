/**
 * TLUXE NEWS BACKEND connection settings (bridge/news - NOT the provider itself). Stored in THIS browser only.
 * Provider credentials (Trading Economics key, any newswire key) are NEVER configured, stored or sent here: they live
 * only in bridge/news/.env on the backend. The browser knows the backend URL and the backend token.
 */
import { defaultBackendUrl } from '../../config/deployment';

export interface NewsBridgeConfig {
  enabled: boolean;
  url: string;
  /** TLUXE_NEWS_TOKEN (not a provider key). */
  token: string;
  /** Poll interval for new / revised items and status (the backend does the provider refresh). */
  pollMs: number;
  requestTimeoutMs: number;
}

export const NEWS_BRIDGE_CONFIG_KEY = 'tluxe.newsbridge.config.v1';
export const NEWS_BRIDGE_DEFAULT_URL = defaultBackendUrl('news');

export const DEFAULT_NEWS_BRIDGE_CONFIG: Readonly<NewsBridgeConfig> = Object.freeze({
  enabled: false,
  url: NEWS_BRIDGE_DEFAULT_URL,
  token: '',
  pollMs: 15_000,
  requestTimeoutMs: 10_000,
});

/** Provider credentials must never be stored in the browser (Trading Economics keys are "client:secret"). */
export const looksLikeProviderKey = (s: string) => /:/.test(s) || /^(sk-|db-)/i.test(s.trim()) || /^guest$/i.test(s.trim());

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

export function sanitizeNewsBridgeConfig(input: unknown): NewsBridgeConfig {
  const d = DEFAULT_NEWS_BRIDGE_CONFIG;
  const o = (input && typeof input === 'object' ? input : {}) as Partial<NewsBridgeConfig>;
  const url = typeof o.url === 'string' && /^https?:\/\/[^\s?#]+$/.test(o.url.trim()) ? o.url.trim().replace(/\/+$/, '') : d.url;
  const token = typeof o.token === 'string' ? o.token.trim() : '';
  return {
    enabled: o.enabled === true,
    url,
    token: looksLikeProviderKey(token) ? '' : token,
    pollMs: num(o.pollMs, 5_000, 300_000, d.pollMs),
    requestTimeoutMs: num(o.requestTimeoutMs, 2_000, 60_000, d.requestTimeoutMs),
  };
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export function loadNewsBridgeConfig(storage: KV | null): NewsBridgeConfig {
  try {
    const raw = storage?.getItem(NEWS_BRIDGE_CONFIG_KEY);
    return sanitizeNewsBridgeConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeNewsBridgeConfig(null);
  }
}

export function saveNewsBridgeConfig(storage: KV | null, cfg: NewsBridgeConfig): void {
  try {
    storage?.setItem(NEWS_BRIDGE_CONFIG_KEY, JSON.stringify(sanitizeNewsBridgeConfig(cfg)));
  } catch {
    /* storage blocked */
  }
}
