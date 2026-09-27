/**
 * Deployment mode, fixed at BUILD time by VITE_TLUXE_DEPLOYMENT.
 *
 *  local (default, `npm run dev` on 5182): the browser talks to the private bridges on 127.0.0.1 (MT5 8765,
 *        Databento 8766, TLUXE AI 8767, news 8768) with the tokens stored in this browser - unchanged.
 *  cloud (`npm run build:cloud`): the browser talks ONLY to the TLUXE gateway on its own origin (/api/...). The
 *        gateway holds every upstream credential server-side and authenticates the browser with an HttpOnly session
 *        cookie. No localhost URL, bridge token or provider key exists in the cloud bundle, and nothing sensitive is
 *        read from or written to localStorage.
 *
 * Vite replaces `import.meta.env.VITE_TLUXE_DEPLOYMENT` with a literal, so the local defaults below are removed from
 * the cloud bundle by constant folding (verified by scripts/scan-bundle.cjs).
 */
export type DeploymentMode = 'local' | 'cloud';

export const IS_CLOUD: boolean = import.meta.env.VITE_TLUXE_DEPLOYMENT === 'cloud';
export const DEPLOYMENT: DeploymentMode = IS_CLOUD ? 'cloud' : 'local';

export type BackendKey = 'mt5' | 'databento' | 'ai' | 'news';

/**
 * Placeholder the existing clients put in their Authorization header in cloud mode. It is NOT a credential: the
 * gateway ignores browser Authorization headers and authenticates the session cookie instead.
 */
export const CLOUD_SESSION_TOKEN = 'cloud-session';

/** Gateway prefixes (the AI client already uses /api/ai/... paths, so its base is the origin itself). */
export const CLOUD_PATHS: Readonly<Record<BackendKey, string>> = Object.freeze({ mt5: '/api/mt5', databento: '/api/databento', ai: '', news: '/api/news' });

/** Private local bridge URLs - development only (empty in the cloud bundle). */
export const LOCAL_BACKEND_URLS: Readonly<Record<BackendKey, string>> = Object.freeze(
  IS_CLOUD
    ? { mt5: '', databento: '', ai: '', news: '' }
    : { mt5: 'http://127.0.0.1:8765', databento: 'http://127.0.0.1:8766', ai: 'http://127.0.0.1:8767', news: 'http://127.0.0.1:8768' },
);

export function appOrigin(): string {
  try {
    return typeof window === 'undefined' ? '' : window.location.origin;
  } catch {
    return '';
  }
}

export const cloudBackendUrl = (key: BackendKey, origin = appOrigin()) => `${origin}${CLOUD_PATHS[key]}`;

/** Default backend URL for this build: the gateway on this origin (cloud) or the private local bridge (local). */
export const defaultBackendUrl = (key: BackendKey, cloud = IS_CLOUD) => (cloud ? cloudBackendUrl(key) : LOCAL_BACKEND_URLS[key]);

/** Cookies go to the gateway in cloud mode only; local bridges never receive browser cookies. */
export const backendCredentials = (cloud = IS_CLOUD): RequestCredentials => (cloud ? 'same-origin' : 'omit');

/**
 * Cloud: route a provider through the gateway regardless of what this browser stored (URL / token from an older
 * local setup are ignored). Always enabled - the gateway and the unified health report what is really connected;
 * a disconnected upstream stays DATA UNAVAILABLE / NOT CONNECTED, never simulated. Local: unchanged.
 */
export function resolveBackendConfig<T extends { enabled: boolean; token: string }>(cfg: T, key: BackendKey, urlField: keyof T, cloud = IS_CLOUD, origin = appOrigin()): T {
  if (!cloud) return cfg;
  return { ...cfg, [urlField]: cloudBackendUrl(key, origin), token: CLOUD_SESSION_TOKEN, enabled: true };
}
