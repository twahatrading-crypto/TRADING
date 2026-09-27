/**
 * TLUXE AI BACKEND connection settings (the local TLUXE AI backend in bridge/ai, NOT OpenAI). Stored in THIS browser
 * only. The OpenAI API key is NEVER configured, stored or sent here: it lives only in the backend's server-side
 * environment (OPENAI_API_KEY). The browser knows the backend URL and the backend token (TLUXE_AI_TOKEN).
 */
export interface TluxeAiConfig {
  enabled: boolean;
  /** Backend base URL, private (the backend binds to 127.0.0.1). */
  url: string;
  /** TLUXE_AI_TOKEN (not the OpenAI key). */
  token: string;
  /** Provider health re-check interval while connected (the backend caches OpenAI verification). */
  healthMs: number;
  /** Client-side request timeout for one chat answer. */
  requestTimeoutMs: number;
}

export const TLUXE_AI_CONFIG_KEY = 'tluxe.ai.config.v1';
export const TLUXE_AI_DEFAULT_URL = 'http://127.0.0.1:8767';

export const DEFAULT_TLUXE_AI_CONFIG: Readonly<TluxeAiConfig> = Object.freeze({
  enabled: false,
  url: TLUXE_AI_DEFAULT_URL,
  token: '',
  healthMs: 30_000,
  requestTimeoutMs: 90_000,
});

/** Anything shaped like an OpenAI key must never be stored in the browser. */
export const looksLikeOpenAiKey = (s: string) => /^sk-/i.test(s.trim());

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

export function sanitizeTluxeAiConfig(input: unknown): TluxeAiConfig {
  const d = DEFAULT_TLUXE_AI_CONFIG;
  const o = (input && typeof input === 'object' ? input : {}) as Partial<TluxeAiConfig>;
  const url = typeof o.url === 'string' && /^https?:\/\/[^\s?#]+$/.test(o.url.trim()) ? o.url.trim().replace(/\/+$/, '') : d.url;
  const token = typeof o.token === 'string' ? o.token.trim() : '';
  return {
    enabled: o.enabled === true,
    url,
    token: looksLikeOpenAiKey(token) ? '' : token,
    healthMs: num(o.healthMs, 5_000, 600_000, d.healthMs),
    requestTimeoutMs: num(o.requestTimeoutMs, 5_000, 300_000, d.requestTimeoutMs),
  };
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export function loadTluxeAiConfig(storage: KV | null): TluxeAiConfig {
  try {
    const raw = storage?.getItem(TLUXE_AI_CONFIG_KEY);
    return sanitizeTluxeAiConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeTluxeAiConfig(null);
  }
}

export function saveTluxeAiConfig(storage: KV | null, cfg: TluxeAiConfig): void {
  try {
    storage?.setItem(TLUXE_AI_CONFIG_KEY, JSON.stringify(sanitizeTluxeAiConfig(cfg)));
  } catch {
    /* storage blocked */
  }
}
