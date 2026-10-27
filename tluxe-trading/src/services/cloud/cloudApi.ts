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

export interface RuntimeConfig {
  authRequired: boolean;
  /** Owner login not configured yet: only read-only Databento market data is served without a session. */
  publicMarketData: boolean;
  /** The gateway has an IBKR COMEX Level-2 depth link configured (cloud VPS bridge). A flag only - never a key. */
  ibkrDepth: boolean;
}

/** Gateway runtime flags (public, no secrets). Unknown / unreachable -> login required (fail closed). */
export async function fetchRuntimeConfig(fetchImpl: FetchLike = f): Promise<RuntimeConfig> {
  try {
    const res = await fetchImpl('/api/config', { credentials: 'same-origin', cache: 'no-store' });
    const body = res.ok ? await json<{ authRequired?: unknown; publicMarketData?: unknown; ibkrDepth?: unknown }>(res) : null;
    const publicMarketData = body?.publicMarketData === true && body?.authRequired === false;
    return { authRequired: !publicMarketData, publicMarketData, ibkrDepth: body?.ibkrDepth === true };
  } catch {
    return { authRequired: true, publicMarketData: false, ibkrDepth: false };
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

export async function login(password: string, fetchImpl: FetchLike = f, email?: string): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(email === undefined ? { password } : { email, password }),
    });
  } catch {
    throw new CloudAuthError('UNREACHABLE', 'The TLUXE gateway is not reachable.', 0);
  }
  if (res.ok) return;
  const err = (await json<{ error?: { code?: string; message?: string } }>(res))?.error;
  throw new CloudAuthError(err?.code ?? 'ERROR', err?.message ?? `Sign-in failed (HTTP ${res.status}).`, res.status);
}

/** The owner's REAL activity (input / focus) - the only thing besides signing in that moves the 2 h inactivity clock. */
export async function reportActivity(fetchImpl: FetchLike = f): Promise<void> {
  try {
    await fetchImpl('/api/auth/activity', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } catch {
    /* the next interaction reports again */
  }
}

export interface OwnerAccount {
  email: string | null;
  signedInAtMs: number | null;
  maxAgeS: number | null;
  idleTimeoutS: number | null;
}

export async function fetchAccount(fetchImpl: FetchLike = f): Promise<OwnerAccount | null> {
  try {
    const res = await fetchImpl('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const b = await json<Partial<OwnerAccount>>(res);
    return { email: typeof b?.email === 'string' ? b.email : null, signedInAtMs: b?.signedInAtMs ?? null, maxAgeS: b?.maxAgeS ?? null, idleTimeoutS: b?.idleTimeoutS ?? null };
  } catch {
    return null;
  }
}

/** Change the owner password (current + new). The gateway stores only a hash and ends every other session. */
export async function changePassword(currentPassword: string, newPassword: string, fetchImpl: FetchLike = f): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl('/api/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  } catch {
    throw new CloudAuthError('UNREACHABLE', 'The TLUXE gateway is not reachable.', 0);
  }
  if (res.ok) return;
  const err = (await json<{ error?: { code?: string; message?: string } }>(res))?.error;
  throw new CloudAuthError(err?.code ?? 'ERROR', err?.message ?? `Password change failed (HTTP ${res.status}).`, res.status);
}

/** Where a signed-out browser goes: the server-rendered sign-in page, back to the same view afterwards. */
export function signInUrl(loc: Pick<Location, 'pathname' | 'search' | 'hash'>, expired = false): string {
  const next = `${loc.pathname}${loc.search}${loc.hash}`;
  const q = new URLSearchParams();
  if (expired) q.set('expired', '1');
  if (next && next !== '/') q.set('next', next);
  const qs = q.toString();
  return `/login${qs ? `?${qs}` : ''}`;
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
