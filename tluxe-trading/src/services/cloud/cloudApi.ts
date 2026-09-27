/**
 * Cloud gateway session + status API (same origin, HttpOnly session cookie). The browser never sees or stores a
 * credential: the password is sent once to /api/auth/login over HTTPS and the gateway answers with a cookie that
 * JavaScript cannot read.
 */
export const HEALTH_STATES = ['LIVE', 'DELAYED', 'STALE', 'NOT CONNECTED', 'UNAVAILABLE', 'ERROR'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface HealthComponent {
  state: HealthState;
  detail: string | null;
  /** Market-data components: false while the market is legitimately closed. */
  marketOpen?: boolean;
  /** STALE that is expected (market closed), not a fault. */
  expected?: boolean;
  lastEventMs?: number | null;
}

export interface CloudStatus {
  timeMs: number;
  components: Record<string, HealthComponent>;
  previous?: { timeMs: number; components: Record<string, HealthComponent> } | null;
}

export const COMPONENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  frontend: 'Frontend',
  api: 'API gateway',
  postgres: 'PostgreSQL',
  ai: 'TLUXE AI',
  openai: 'OpenAI',
  databento: 'Databento',
  news: 'News',
  mt5Bridge: 'MT5 bridge',
  mt5Feed: 'MT5 feed',
  websocket: 'WebSocket',
});

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const f: FetchLike = (i, init) => fetch(i, init);

async function json<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function sessionStatus(fetchImpl: FetchLike = f): Promise<'authenticated' | 'anonymous' | 'unreachable'> {
  try {
    const res = await fetchImpl('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) return 'authenticated';
    return res.status === 401 ? 'anonymous' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export async function login(password: string, fetchImpl: FetchLike = f): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new CloudAuthError('UNREACHABLE', 'The TLUXE gateway is not reachable.', 0);
  }
  if (res.ok) return;
  const err = (await json<{ error?: { code?: string; message?: string } }>(res))?.error;
  throw new CloudAuthError(err?.code ?? 'ERROR', err?.message ?? `Sign-in failed (HTTP ${res.status}).`, res.status);
}

export async function logout(fetchImpl: FetchLike = f): Promise<void> {
  try {
    await fetchImpl('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } catch {
    /* the cookie expires on its own */
  }
}

export async function fetchStatus(fetchImpl: FetchLike = f): Promise<CloudStatus | null> {
  try {
    const res = await fetchImpl('/api/status', { credentials: 'same-origin', cache: 'no-store' });
    return res.ok ? await json<CloudStatus>(res) : null;
  } catch {
    return null;
  }
}

/** Alerts are persisted server-side (deduplicated by key). Best effort: the UI never depends on the round trip. */
export interface CloudAlert {
  /** Stable dedupe key (the gateway ignores a key it already stored). */
  alertKey: string;
  source: string;
  type: string;
  title: string;
  message?: string;
  eventKey?: string;
  instrumentId?: string;
  occurredAt: number;
}

export async function persistAlert(alert: CloudAlert, fetchImpl: FetchLike = f): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/alerts', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
    });
    return res.ok;
  } catch {
    return false;
  }
}
