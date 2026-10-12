import { offlineStatus } from '../../engines/orderFlowPro/engine';
import type { OfpFrame, OfpRoot, SourceStatus } from '../../engines/orderFlowPro/types';
import { isLoopbackUrl, loadOfpLink, OFP_BACKEND_AVAILABLE, type OfpLinkConfig } from './config';
import type { OfpSource, SourceSink } from './source';

/* ============================================================================
 * Client of the LOCAL Order Flow Pro backend (bridge/orderflowpro, 127.0.0.1 only). GET requests only, plus one
 * POST to choose which verified contract the backend subscribes. The backend itself never sends orders.
 * One poll chain per subscribed root; a failed request -> BACKEND_OFFLINE and a slow retry (no request storm).
 * Status values come from the backend verbatim: the browser never upgrades a state (DELAYED stays DELAYED).
 * ========================================================================== */

interface FramesResponse {
  frames: OfpFrame[];
  nextSeq: number;
  serverTime: number;
  /** Backend process session (changes on restart). */
  sessionId?: string;
  /** The backend restarted the stream from a fresh snapshot: the browser engine must be reset first. */
  resync?: boolean;
}

const FEEDS = new Set(['DISABLED', 'GATEWAY_OFFLINE', 'AUTH_REQUIRED', 'CONNECTING', 'LIVE', 'FROZEN', 'DELAYED', 'DELAYED_FROZEN', 'STALE', 'NOT_ENTITLED', 'COMPETING_SESSION', 'MODE_MISMATCH', 'IDENTITY_UNCONFIRMED', 'ACCOUNT_UNVERIFIED']);

/** Exponential back-off while the backend is unreachable: base, 2x, 4x ... capped. */
export function retryDelay(baseMs: number, maxMs: number, failures: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

/** Receive (backend) -> applied (browser) latency of the newest event. Same PC, same clock. */
function newestEventMs(frames: OfpFrame[]): number | null {
  let t: number | null = null;
  for (const f of frames) for (const e of f.events) if ('t' in e && (t === null || e.t > t)) t = e.t;
  return t;
}

/** Reject anything that is not a well-formed backend status (DEMO is never accepted from the backend). */
export function parseStatus(root: OfpRoot, v: unknown): SourceStatus | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as SourceStatus;
  if (s.root !== root || !FEEDS.has(s.feed) || !s.capabilities || !Array.isArray(s.diagnostics)) return null;
  if (Object.values(s.capabilities).some((c) => c === 'DEMO')) return null;
  return s;
}

export class BackendSource implements OfpSource {
  readonly info = { id: 'ofp-backend', name: 'IBKR via local Order Flow Pro backend', demo: false };

  constructor(private readonly cfg: () => OfpLinkConfig = loadOfpLink) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const c = this.cfg();
    if (!isLoopbackUrl(c.backendUrl)) throw new Error('backend URL must be loopback');
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), c.requestTimeoutMs);
    try {
      const r = await fetch(`${c.backendUrl}${path}`, { ...init, signal: ctl.signal, headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as T;
    } finally {
      clearTimeout(to);
    }
  }

  subscribe(root: OfpRoot, sink: SourceSink): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let after = 0;
    let session: string | null = null;
    let failures = 0;
    const schedule = (ms: number) => {
      if (!stopped) timer = setTimeout(loop, ms);
    };
    const loop = async () => {
      if (!OFP_BACKEND_AVAILABLE) {
        // Website build: no Order Flow Pro backend exists - report it once and never poll.
        sink.status(offlineStatus(root, 'BACKEND_OFFLINE', ['No Order Flow Pro backend is deployed for this website (it runs only as a local research service).', 'No order-flow data is shown or simulated here.']));
        return;
      }
      const c = this.cfg();
      if (!c.enabled) {
        sink.status(offlineStatus(root, 'BACKEND_OFFLINE', ['Backend link is OFF in this browser (Diagnostics → Backend link).', 'No requests are sent while it is off.']));
        return schedule(c.offlineRetryMs);
      }
      if (!c.token) {
        sink.status(offlineStatus(root, 'BACKEND_OFFLINE', ['Backend token not set (Diagnostics → Backend link).']));
        return schedule(c.offlineRetryMs);
      }
      try {
        const st = parseStatus(root, await this.req<unknown>(`/api/ofp/status?root=${root}`));
        if (!st) throw new Error('malformed status');
        if (stopped) return;
        const f = await this.req<FramesResponse>(`/api/ofp/frames?root=${root}&after=${after}`);
        if (stopped) return;
        failures = 0;
        // Backend restarted (new session): drop this response, reset the engine, re-request from a fresh snapshot.
        if (f.sessionId && session !== null && f.sessionId !== session) {
          session = f.sessionId;
          after = 0;
          sink.reset?.('Order Flow Pro backend restarted - stream restored from a fresh snapshot');
          return schedule(0);
        }
        if (f.sessionId) session = f.sessionId;
        if (f.resync && after > 0) sink.reset?.('Stream fell behind the backend buffer - restored from a fresh snapshot');
        const newest = newestEventMs(f.frames);
        sink.status(newest !== null ? { ...st, latencyMs: Math.max(0, Date.now() - newest) } : st);
        if (f.frames.length) sink.frames(f.frames);
        after = f.nextSeq;
        sink.time(f.serverTime);
        schedule(c.pollMs);
      } catch (e) {
        if (stopped) return;
        failures++;
        const wait = retryDelay(c.offlineRetryMs, c.offlineRetryMaxMs, failures);
        sink.status(
          offlineStatus(root, 'BACKEND_OFFLINE', [
            `Order Flow Pro backend not reachable at ${c.backendUrl} (${e instanceof Error ? e.message : 'error'}).`,
            `Reconnecting automatically in ${Math.round(wait / 1000)} s (attempt ${failures}).`,
            'Start it with bridge\\orderflowpro\\start_ofp.cmd.',
          ]),
        );
        schedule(wait);
      }
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  async history(root: OfpRoot, from: number, to: number): Promise<OfpFrame[]> {
    const r = await this.req<{ frames: OfpFrame[] }>(`/api/ofp/history?root=${root}&from=${Math.floor(from)}&to=${Math.floor(to)}`);
    return r.frames;
  }

  async selectContract(root: OfpRoot, localSymbol: string): Promise<void> {
    if (!OFP_BACKEND_AVAILABLE) throw new Error('No Order Flow Pro backend on this website');
    await this.req('/api/ofp/select', { method: 'POST', body: JSON.stringify({ root, localSymbol }) });
  }
}
