/**
 * Order Flow Pro BACKEND link settings (the local TLUXE Order Flow Pro service on this PC, NOT IB Gateway).
 * Stored in THIS browser only. IBKR credentials are never configured, stored or sent here - they are typed into
 * IB Gateway itself. The browser knows only the backend URL (loopback only) and the backend token.
 */
import { IS_CLOUD } from '../../config/deployment';

/**
 * The Order Flow Pro backend is a LOCAL research service (owner's PC, 127.0.0.1). The website build (cloud) has no
 * Order Flow Pro backend: its CSP allows only the same origin, so the link is never enabled there and no loopback URL
 * is compiled into the cloud bundle. The page then states BACKEND OFFLINE - nothing is simulated.
 */
export const OFP_BACKEND_AVAILABLE = !IS_CLOUD;

export interface OfpLinkConfig {
  /** Off by default: nothing polls until the user enables the link (no background requests, no console noise). */
  enabled: boolean;
  backendUrl: string;
  token: string;
  pollMs: number;
  requestTimeoutMs: number;
  /** First retry delay while the backend is unreachable (doubles per failure up to offlineRetryMaxMs). */
  offlineRetryMs: number;
  offlineRetryMaxMs: number;
}

export const OFP_LINK_KEY = 'tluxe.ofp.link.v1';
export const OFP_DEFAULT_PORT = 8770;

export const DEFAULT_OFP_LINK: Readonly<OfpLinkConfig> = Object.freeze({
  enabled: false,
  backendUrl: IS_CLOUD ? '' : `http://127.0.0.1:${OFP_DEFAULT_PORT}`,
  token: '',
  pollMs: 250,
  requestTimeoutMs: 5000,
  offlineRetryMs: 1000,
  offlineRetryMaxMs: 30000,
});

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** Only loopback backends are accepted: the Order Flow Pro service is never reached over a network. */
export function isLoopbackUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function sanitizeOfpLink(input: unknown): OfpLinkConfig {
  const d = DEFAULT_OFP_LINK;
  const o = (input && typeof input === 'object' ? input : {}) as Partial<OfpLinkConfig>;
  const raw = typeof o.backendUrl === 'string' ? o.backendUrl.trim().replace(/\/+$/, '') : '';
  return {
    enabled: o.enabled === true,
    backendUrl: raw && isLoopbackUrl(raw) ? raw : d.backendUrl,
    token: typeof o.token === 'string' ? o.token.trim().slice(0, 256) : '',
    pollMs: num(o.pollMs, 100, 5000, d.pollMs),
    requestTimeoutMs: num(o.requestTimeoutMs, 1000, 60000, d.requestTimeoutMs),
    offlineRetryMs: num(o.offlineRetryMs, 250, 120000, d.offlineRetryMs),
    offlineRetryMaxMs: num(o.offlineRetryMaxMs, 1000, 300000, d.offlineRetryMaxMs),
  };
}

export function loadOfpLink(): OfpLinkConfig {
  if (!OFP_BACKEND_AVAILABLE) return { ...DEFAULT_OFP_LINK };
  try {
    const raw = localStorage.getItem(OFP_LINK_KEY);
    return sanitizeOfpLink(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_OFP_LINK };
  }
}

export function saveOfpLink(c: OfpLinkConfig) {
  try {
    localStorage.setItem(OFP_LINK_KEY, JSON.stringify(sanitizeOfpLink(c)));
  } catch {
    /* storage blocked */
  }
}
