import { createStore, type Store } from '../../store/createStore';
import { NewsBridgeClient, NewsBridgeError } from './client';
import type { NewsBridgeConfig } from './config';
import type { BridgeCalendarEvent, BridgeFeedKind, BridgeFeedView, BridgeHeadline, BridgeHealth } from './protocol';

export type NewsBridgeEvent =
  | { kind: 'health'; view: BridgeFeedView }
  | { kind: 'offline'; reason: 'OFFLINE' | 'UNAUTHORIZED' | 'TIMEOUT' | 'BAD_RESPONSE' | 'HTTP'; message: string }
  | { kind: 'calendar'; events: BridgeCalendarEvent[] }
  | { kind: 'headlines'; headlines: BridgeHeadline[] };

export interface NewsBridgeState {
  bridge: 'IDLE' | 'CONNECTING' | 'ONLINE' | 'OFFLINE' | 'UNAUTHORIZED';
  health: BridgeHealth | null;
  error: string | null;
  lastOkAt: number | null;
  polls: number;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  now(): number;
}

type Listener = (e: NewsBridgeEvent) => void;

/**
 * ONE poll loop for the local news backend, shared by the calendar / macro / breaking adapters. Ref-counted: it runs
 * only while an adapter is connected, so HMR / StrictMode re-mounts or page switches never duplicate polling.
 * Incremental: only items changed since the last sequence number are fetched (new events and revisions).
 */
export class NewsBridgeFeed {
  readonly state: Store<NewsBridgeState> = createStore<NewsBridgeState>({ bridge: 'IDLE', health: null, error: null, lastOkAt: null, polls: 0 });
  readonly api: NewsBridgeClient;
  private listeners = new Map<BridgeFeedKind, Set<Listener>>();
  private cursors: Record<BridgeFeedKind, number> = { calendar: 0, macro: 0, breaking: 0 };
  private startedAt: number | null = null;
  private timer: unknown = null;
  private running = false;
  private inflight = false;
  private readonly timers: Timers;

  constructor(
    private readonly cfg: NewsBridgeConfig,
    deps: { api?: NewsBridgeClient; timers?: Timers } = {},
  ) {
    this.api = deps.api ?? new NewsBridgeClient(cfg.url, cfg.token, cfg.requestTimeoutMs);
    this.timers = deps.timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), now: () => Date.now() };
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
  isRunning(): boolean {
    return this.running;
  }

  subscribe(kind: BridgeFeedKind, l: Listener): () => void {
    let set = this.listeners.get(kind);
    if (!set) this.listeners.set(kind, (set = new Set()));
    set.add(l);
    this.cursors[kind] = 0; // a new consumer replays the retained items once (the engine de-duplicates by key)
    this.ensure();
    return () => {
      set!.delete(l);
      if (this.listenerCount() === 0) this.halt();
    };
  }

  private emit(kind: BridgeFeedKind, e: NewsBridgeEvent): void {
    for (const l of [...(this.listeners.get(kind) ?? [])]) l(e);
  }
  private emitAll(e: NewsBridgeEvent): void {
    for (const k of this.listeners.keys()) this.emit(k, e);
  }

  private ensure(): void {
    if (this.running) return;
    this.running = true;
    this.state.setState({ bridge: 'CONNECTING' });
    const loop = async () => {
      if (!this.running) return;
      await this.pollOnce();
      if (this.running) this.timer = this.timers.setTimeout(() => void loop(), this.cfg.pollMs);
    };
    this.timer = this.timers.setTimeout(() => void loop(), 0);
  }

  private halt(): void {
    this.running = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.state.setState({ bridge: 'IDLE' });
  }

  /** One health + incremental fetch cycle (also used directly by tests). */
  async pollOnce(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const h = await this.api.health();
      if (h?.service !== 'tluxe-news' || !h.feeds) throw new NewsBridgeError('BAD_RESPONSE', 'Unexpected answer from the news backend.');
      if (this.startedAt !== null && h.startedAtMs !== this.startedAt) this.cursors = { calendar: 0, macro: 0, breaking: 0 }; // backend restarted
      this.startedAt = h.startedAtMs;
      this.state.setState((s) => ({ ...s, bridge: 'ONLINE', health: h, error: null, lastOkAt: this.timers.now(), polls: s.polls + 1 }));
      for (const kind of this.listeners.keys()) {
        const view = h.feeds[kind];
        if (!view) continue;
        this.emit(kind, { kind: 'health', view });
        if (!view.configured || !view.enabled) continue;
        if (kind === 'calendar') {
          let page = await this.api.calendar(this.cursors.calendar);
          if (page.reset) page = await this.api.calendar((this.cursors.calendar = 0));
          this.cursors.calendar = page.seq;
          if (page.events.length) this.emit('calendar', { kind: 'calendar', events: page.events });
        } else {
          let page = await this.api.headlines(kind, this.cursors[kind]);
          if (page.reset) page = await this.api.headlines(kind, (this.cursors[kind] = 0));
          this.cursors[kind] = page.seq;
          if (page.headlines.length) this.emit(kind, { kind: 'headlines', headlines: page.headlines });
        }
      }
    } catch (e) {
      const err = e instanceof NewsBridgeError ? e : new NewsBridgeError('OFFLINE', 'The news backend is not reachable.');
      this.state.setState((s) => ({ ...s, bridge: err.code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'OFFLINE', error: err.message, polls: s.polls + 1 }));
      this.emitAll({ kind: 'offline', reason: err.code, message: err.message });
    } finally {
      this.inflight = false;
    }
  }
}
