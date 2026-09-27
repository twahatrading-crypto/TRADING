import { createStore, type Store } from '../../store/createStore';

/**
 * Browser side of the gateway's real-time transport (/api/stream, WSS in production). One socket per tab.
 *
 *  - reconnect with exponential back-off + jitter (1 s .. 30 s), reset after a healthy connection
 *  - heartbeat / stale detection: the gateway sends something at least every `heartbeatS` seconds; silence for
 *    2.5 x that marks the transport STALE and forces a reconnect
 *  - sequence numbers: every message carries a per-connection seq starting at 1. A gap (or a new connection) calls
 *    `onResync` so the caller refetches authoritative state instead of trusting a partial stream
 *  - the transport state is never reported as data freshness: a LIVE socket only means the gateway is reachable
 */
export type StreamState = 'IDLE' | 'CONNECTING' | 'LIVE' | 'STALE' | 'RECONNECTING' | 'STOPPED';

export interface StreamMessage {
  type: string;
  seq: number;
  ts: number;
  data: unknown;
}

export interface CloudStreamState {
  state: StreamState;
  connects: number;
  gaps: number;
  lastMessageMs: number | null;
  lastSeq: number | null;
  nextRetryMs: number | null;
}

interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface CloudStreamOptions {
  url: string;
  onMessage?: (m: StreamMessage) => void;
  /** New connection or sequence gap: refetch authoritative state. */
  onResync?: (why: 'connected' | 'gap') => void;
  /** Called when the socket closes before it ever opened (possibly an expired session). */
  onRejected?: () => void;
  channels?: string[];
  socket?: (url: string) => SocketLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  random?: () => number;
  heartbeatS?: number;
}

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const STALE_FACTOR = 2.5;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + random() * 0.5));
}

/** ws(s)://<this origin>/api/stream - WSS whenever the page itself is HTTPS. */
export function streamUrl(loc: { protocol: string; host: string }, path = '/api/stream'): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${path}`;
}

export class CloudStream {
  readonly store: Store<CloudStreamState> = createStore<CloudStreamState>({ state: 'IDLE', connects: 0, gaps: 0, lastMessageMs: null, lastSeq: null, nextRetryMs: null });
  private ws: SocketLike | null = null;
  private attempt = 0;
  private retryTimer: unknown = null;
  private staleTimer: unknown = null;
  private opened = false;
  private stopped = true;
  private heartbeatS: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly opts: CloudStreamOptions) {
    this.heartbeatS = opts.heartbeatS ?? 15;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  start(): () => void {
    if (!this.stopped) return () => this.stop();
    this.stopped = false;
    this.connect();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.staleTimer);
    this.retryTimer = this.staleTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'stopped');
    } catch {
      /* already closed */
    }
    this.store.setState({ state: 'STOPPED', nextRetryMs: null });
  }

  subscribe(channels: string[]): void {
    this.send({ type: 'subscribe', channels });
  }

  unsubscribe(channels: string[]): void {
    this.send({ type: 'unsubscribe', channels });
  }

  private send(m: object): void {
    try {
      this.ws?.send(JSON.stringify(m));
    } catch {
      /* not open: channels are re-sent on the next connection */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.opened = false;
    this.store.setState({ state: this.store.getState().connects ? 'RECONNECTING' : 'CONNECTING', lastSeq: null, nextRetryMs: null });
    let ws: SocketLike;
    try {
      ws = (this.opts.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opened = true;
      this.store.setState((s) => ({ ...s, connects: s.connects + 1, lastMessageMs: this.now() }));
      if (this.opts.channels?.length) this.subscribe(this.opts.channels);
      this.armStale();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.onMessage(ev.data);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimer(this.staleTimer);
      if (!this.opened) this.opts.onRejected?.();
      this.scheduleReconnect();
    };
  }

  private onMessage(raw: unknown): void {
    let m: StreamMessage;
    try {
      m = JSON.parse(String(raw)) as StreamMessage;
    } catch {
      return;
    }
    if (!m || typeof m.seq !== 'number' || typeof m.type !== 'string') return;
    const prev = this.store.getState().lastSeq;
    const now = this.now();
    if (prev === null) {
      // First message on this connection: the gateway numbers from 1; state may have changed while disconnected.
      this.store.setState({ lastSeq: m.seq, lastMessageMs: now, state: 'LIVE' });
      this.attempt = 0;
      this.opts.onResync?.('connected');
    } else if (m.seq <= prev) {
      return; // duplicate / replay: ignore
    } else {
      const gap = m.seq !== prev + 1;
      this.store.setState((s) => ({ ...s, lastSeq: m.seq, lastMessageMs: now, state: 'LIVE', gaps: s.gaps + (gap ? 1 : 0) }));
      if (gap) this.opts.onResync?.('gap');
    }
    if (m.type === 'hello') {
      const hb = (m.data as { heartbeatS?: unknown } | null)?.heartbeatS;
      if (typeof hb === 'number' && hb >= 1 && hb <= 300) this.heartbeatS = hb;
    }
    this.armStale();
    if (m.type !== 'hello' && m.type !== 'heartbeat') this.opts.onMessage?.(m);
  }

  private armStale(): void {
    this.clearTimer(this.staleTimer);
    this.staleTimer = this.setTimer(() => this.onStale(), this.heartbeatS * STALE_FACTOR * 1000);
  }

  private onStale(): void {
    if (this.stopped || !this.ws) return;
    this.store.setState({ state: 'STALE' });
    const ws = this.ws;
    this.ws = null;
    try {
      ws.close(4000, 'stale');
    } catch {
      /* ignore */
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const wait = backoffMs(this.attempt++, this.opts.random);
    this.store.setState((s) => ({ ...s, state: s.state === 'STALE' ? 'STALE' : 'RECONNECTING', nextRetryMs: this.now() + wait }));
    this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => this.connect(), wait);
  }
}
