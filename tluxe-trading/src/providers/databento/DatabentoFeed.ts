import { createStore, type Store } from '../../store/createStore';
import { DatabentoBridgeClient, DatabentoBridgeError } from './client';
import type { DatabentoConfig } from './config';
import type { DbFrameInstrument, DbHealth, DbRoot } from './protocol';

export type DbFeedEvent =
  | { kind: 'frame'; root: DbRoot; cursor: number; timeMs: number; data: DbFrameInstrument }
  /** The browser fell behind the bridge's bounded frame ring, or the bridge restarted: every consumer resyncs. */
  | { kind: 'reset'; reason: string }
  | { kind: 'offline'; reason: string }
  | { kind: 'health'; health: DbHealth };
export type DbListener = (e: DbFeedEvent) => void;

export interface DatabentoFeedState {
  bridge: 'IDLE' | 'CONNECTING' | 'ONLINE' | 'OFFLINE' | 'UNAUTHORIZED';
  error: string | null;
  health: DbHealth | null;
  lastOkAt: number | null;
  cursor: number;
  resets: number;
  framesReceived: number;
  /** Frames delivered to the app per second (the UI update budget - never one render per market event). */
  framesPerSec: number;
  polls: number;
  roots: DbRoot[];
}

type Api = Pick<DatabentoBridgeClient, 'health' | 'feed' | 'book' | 'trades' | 'candles'>;
type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now: () => number };

/**
 * The ONE browser-side connection to the local Databento bridge. Consumers (market / order-flow / footprint
 * adapters) register per root; polling runs only while at least one consumer is registered, from a single
 * timer chain (never overlapping requests). React components never talk to it directly, so page changes,
 * StrictMode and HMR cannot open additional connections.
 */
export class DatabentoFeed {
  readonly state: Store<DatabentoFeedState>;
  readonly api: Api;
  private listeners = new Map<DbRoot, Set<DbListener>>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private bridgeStartedAt: number | null = null;
  /** The start cursor was taken from the bridge (consumers load current state via REST, then follow frames). */
  private cursorInit = false;
  private frameTimes: number[] = [];
  private readonly timers: Timers;
  /** Poll requests actually sent (tests: no duplicate loops). */
  requests = 0;

  constructor(
    readonly cfg: DatabentoConfig,
    opts: { api?: Api; timers?: Timers } = {},
  ) {
    this.api = opts.api ?? new DatabentoBridgeClient(cfg.bridgeUrl, cfg.token, cfg.requestTimeoutMs);
    this.timers = opts.timers ?? { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
    this.state = createStore<DatabentoFeedState>({ bridge: 'IDLE', error: null, health: null, lastOkAt: null, cursor: 0, resets: 0, framesReceived: 0, framesPerSec: 0, polls: 0, roots: [] });
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  subscribe(root: DbRoot, l: DbListener): () => void {
    let set = this.listeners.get(root);
    if (!set) this.listeners.set(root, (set = new Set()));
    set.add(l);
    this.state.setState({ roots: [...this.listeners.entries()].filter(([, s]) => s.size).map(([r]) => r) });
    if (!this.running) this.start();
    return () => {
      set!.delete(l);
      this.state.setState({ roots: [...this.listeners.entries()].filter(([, s]) => s.size).map(([r]) => r) });
      if (this.listenerCount() === 0) this.stop();
    };
  }

  private emit(root: DbRoot | null, e: DbFeedEvent): void {
    const targets = root ? [this.listeners.get(root) ?? new Set<DbListener>()] : [...this.listeners.values()];
    for (const set of targets) for (const l of [...set]) l(e);
  }

  private start(): void {
    this.running = true;
    this.state.setState({ bridge: 'CONNECTING', error: null });
    void this.healthOnce().then(() => this.schedulePoll(0));
    this.scheduleHealth();
  }

  stop(): void {
    this.running = false;
    this.cursorInit = false;
    if (this.pollTimer !== null) this.timers.clearTimeout(this.pollTimer);
    if (this.healthTimer !== null) this.timers.clearTimeout(this.healthTimer);
    this.pollTimer = null;
    this.healthTimer = null;
    this.state.setState({ bridge: 'IDLE' });
  }

  /** Offline / unauthorized: probe every 2 s instead of every poll interval (never hammer a dead bridge). */
  private nextPollMs(): number {
    const b = this.state.getState().bridge;
    return b === 'OFFLINE' || b === 'UNAUTHORIZED' ? Math.max(this.cfg.pollMs, 2000) : this.cfg.pollMs;
  }

  private schedulePoll(ms = this.nextPollMs()): void {
    if (!this.running || this.pollTimer !== null) return;
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce().finally(() => this.schedulePoll());
    }, ms);
  }
  private scheduleHealth(): void {
    if (!this.running || this.healthTimer !== null) return;
    this.healthTimer = this.timers.setTimeout(() => {
      this.healthTimer = null;
      void this.healthOnce().finally(() => this.scheduleHealth());
    }, this.cfg.healthMs);
  }

  private fail(e: unknown): void {
    const now = this.timers.now();
    const s = this.state.getState();
    if (e instanceof DatabentoBridgeError && e.status === 401) {
      this.state.setState({ bridge: 'UNAUTHORIZED', error: 'The bridge rejected the TLUXE bridge token (Settings → Databento).' });
      this.emit(null, { kind: 'offline', reason: 'UNAUTHORIZED' });
      return;
    }
    if (s.lastOkAt === null || now - s.lastOkAt > this.cfg.offlineMs) {
      if (s.bridge !== 'OFFLINE') this.emit(null, { kind: 'offline', reason: 'Databento bridge not reachable' });
      this.state.setState({ bridge: 'OFFLINE', error: 'Databento bridge not reachable (bridge/databento, port 8766).' });
    }
  }

  private ok(): void {
    const s = this.state.getState();
    if (s.bridge === 'OFFLINE' || s.bridge === 'UNAUTHORIZED') {
      this.state.setState({ resets: s.resets + 1 });
      this.emit(null, { kind: 'reset', reason: 'bridge back online' });
    }
    this.state.setState({ bridge: 'ONLINE', error: null, lastOkAt: this.timers.now() });
  }

  async healthOnce(): Promise<void> {
    try {
      const h = await this.api.health();
      const restarted = this.bridgeStartedAt !== null && h.bridge?.startedAtMs !== this.bridgeStartedAt;
      this.bridgeStartedAt = h.bridge?.startedAtMs ?? null;
      this.ok();
      if (restarted || !this.cursorInit) {
        this.cursorInit = true;
        this.state.setState({ cursor: Number(h.metrics.cursor ?? 0) });
        if (restarted) {
          this.state.setState({ resets: this.state.getState().resets + 1 });
          this.emit(null, { kind: 'reset', reason: 'bridge restarted' });
        }
      }
      this.state.setState({ health: h });
      this.emit(null, { kind: 'health', health: h });
    } catch (e) {
      this.fail(e);
    }
  }

  async pollOnce(): Promise<void> {
    const roots = [...this.listeners.entries()].filter(([, s]) => s.size).map(([r]) => r);
    if (!roots.length) return;
    this.requests += 1;
    const s = this.state.getState();
    try {
      const res = await this.api.feed(s.cursor, roots);
      this.ok();
      if (res.reset) {
        this.state.setState({ cursor: res.cursor, resets: this.state.getState().resets + 1 });
        this.emit(null, { kind: 'reset', reason: 'browser fell behind the bridge frame buffer' });
        return;
      }
      const now = this.timers.now();
      for (const f of res.frames) {
        for (const root of roots) {
          const data = f.instruments[root];
          if (data) this.emit(root, { kind: 'frame', root, cursor: f.cursor, timeMs: f.timeMs, data });
        }
        this.frameTimes.push(now);
      }
      this.frameTimes = this.frameTimes.filter((t) => now - t <= 10_000);
      this.state.setState({ cursor: res.cursor, polls: s.polls + 1, framesReceived: s.framesReceived + res.frames.length, framesPerSec: Math.round((this.frameTimes.length / 10) * 10) / 10 });
    } catch (e) {
      this.fail(e);
    }
  }
}
