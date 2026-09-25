import { createStore, type Store } from '../../store/createStore';
import { OrderFlowEngine, type OrderFlowEngineOptions } from './engine';
import type { OrderFlowMsg } from './types';

/**
 * Recording of the normalized stream exactly as it was processed (original order and timestamps).
 * Bounded: when full, the oldest half is dropped and the retained part restarts from the next depth
 * snapshot so a rebuild / replay never starts from an unknown book.
 */
export class OrderFlowRecorder {
  private msgs: OrderFlowMsg[] = [];
  constructor(readonly maxMessages = 500_000) {}

  record(m: OrderFlowMsg): void {
    this.msgs.push(m);
    if (this.msgs.length > this.maxMessages) {
      const half = this.msgs.length >> 1;
      const snap = this.msgs.findIndex((x, i) => i >= half && x.type === 'snapshot');
      this.msgs = this.msgs.slice(snap >= 0 ? snap : half);
    }
  }
  messages(): readonly OrderFlowMsg[] {
    return this.msgs;
  }
  clear(): void {
    this.msgs = [];
  }
}

export const REPLAY_SPEEDS = [0.5, 1, 2, 5, 10, 50] as const;
export interface ReplayState {
  cursor: number;
  total: number;
  /** Exchange time of the last processed message. */
  time: number | null;
  playing: boolean;
  speed: number;
}
type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval; now: () => number };

/**
 * Deterministic replay of a recording: a fresh engine fed the SAME messages in the SAME order —
 * so its book, heatmap and events equal the original run's (parity-tested). Going backwards
 * rebuilds from the start (identical by construction).
 */
export class OrderFlowReplay {
  readonly store: Store<ReplayState>;
  engine: OrderFlowEngine;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;
  private clock: { wall: number; exch: number } | null = null;

  constructor(
    private readonly msgs: readonly OrderFlowMsg[],
    private readonly opts: OrderFlowEngineOptions,
    timers?: Timers,
  ) {
    this.timers = timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t), now: () => Date.now() };
    this.engine = new OrderFlowEngine(opts);
    this.store = createStore<ReplayState>({ cursor: 0, total: msgs.length, time: null, playing: false, speed: 1 });
  }

  private publish(): void {
    const c = this.store.getState().cursor;
    this.store.setState({ time: c > 0 ? this.msgs[c - 1]!.exchTime : null });
  }
  private to(target: number): void {
    const n = Math.max(0, Math.min(this.msgs.length, target));
    let c = this.store.getState().cursor;
    if (n < c) {
      this.engine = new OrderFlowEngine(this.opts);
      c = 0;
    }
    for (; c < n; c++) this.engine.process(this.msgs[c]!);
    this.store.setState({ cursor: c });
    this.publish();
  }
  step(n = 1): void {
    this.to(this.store.getState().cursor + n);
  }
  reset(): void {
    this.pause();
    this.to(0);
  }
  /** Process every message with exchange time ≤ t. */
  jumpTo(t: number): void {
    let i = 0;
    while (i < this.msgs.length && this.msgs[i]!.exchTime <= t) i += 1;
    this.to(i);
  }
  setSpeed(speed: number): void {
    this.store.setState({ speed });
    this.clock = null;
  }
  play(): void {
    if (this.timer) return;
    this.store.setState({ playing: true });
    this.clock = null;
    this.timer = this.timers.setInterval(() => this.tick(), 50);
  }
  pause(): void {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.store.setState({ playing: false });
  }
  /** Advance in exchange time at `speed` × wall time, preserving the recorded spacing. */
  tick(): void {
    const st = this.store.getState();
    if (st.cursor >= this.msgs.length) return this.pause();
    const now = this.timers.now();
    if (!this.clock) this.clock = { wall: now, exch: st.cursor > 0 ? this.msgs[st.cursor - 1]!.exchTime : this.msgs[0]!.exchTime };
    const target = this.clock.exch + (now - this.clock.wall) * st.speed;
    let i = st.cursor;
    while (i < this.msgs.length && this.msgs[i]!.exchTime <= target) i += 1;
    if (i === st.cursor) i += 0;
    this.to(i);
  }
  dispose(): void {
    this.pause();
  }
}
