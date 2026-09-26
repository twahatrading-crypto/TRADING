import { FP_TF_SECONDS } from '../../engines/volumeFootprint/config';
import { FootprintEngine } from '../../engines/volumeFootprint/engine';
import { analyzeFootprintAt, type FPDataset } from '../../engines/volumeFootprint/replay';
import type { FPCandle, FPEvent, FPImbalance, FPStack, FPTimeframe, FootprintSnapshot } from '../../engines/volumeFootprint/types';
import { createStore, type Store } from '../../store/createStore';

export const FP_REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type FPReplaySpeed = (typeof FP_REPLAY_SPEEDS)[number];
export interface FPReplayState {
  timeframe: FPTimeframe;
  cursor: number;
  total: number;
  knowledgeTime: number | null;
  candles: FPCandle[];
  events: FPEvent[];
  imbalances: FPImbalance[];
  stacks: FPStack[];
  snapshot: FootprintSnapshot | null;
  parity: { ok: boolean } | null;
  playing: boolean;
  speed: FPReplaySpeed;
}
type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

/**
 * Deterministic footprint replay of the RECORDED message stream. Step = one chart-timeframe boundary of the
 * receive clock; the engine is fed only messages received by then. Parity: incremental == clean recomputation.
 */
export class FPReplaySession {
  readonly store: Store<FPReplayState>;
  private engine: FootprintEngine;
  private fed = 0;
  private points: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;
  private readonly verify: boolean;

  constructor(
    readonly dataset: FPDataset,
    timeframe: FPTimeframe,
    o: { startIndex?: number; timers?: Timers; verify?: boolean } = {},
  ) {
    this.timers = o.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    this.verify = o.verify ?? false;
    this.engine = this.fresh();
    this.points = this.pointsOf(timeframe);
    const i = clamp(o.startIndex ?? Math.floor(this.points.length * 0.6), this.points.length);
    this.store = createStore(this.compute(timeframe, i, false, 1));
  }
  private fresh() {
    return new FootprintEngine({ instrumentId: this.dataset.instrumentId, tickSize: this.dataset.tickSize, settings: this.dataset.settings });
  }
  private pointsOf(tf: FPTimeframe): number[] {
    const ms = FP_TF_SECONDS[tf] * 1000;
    const set = new Set<number>();
    for (const m of this.dataset.messages) set.add(Math.ceil(m.recvTime / ms) * ms);
    return [...set].sort((a, b) => a - b);
  }
  private compute(timeframe: FPTimeframe, i: number, playing: boolean, speed: FPReplaySpeed): FPReplayState {
    const K = i < 0 ? null : this.points[i]!;
    let parity: FPReplayState['parity'] = null;
    if (K !== null) {
      const msgs = this.dataset.messages;
      if (this.fed > 0 && msgs[this.fed - 1]!.recvTime > K) {
        this.engine = this.fresh();
        this.fed = 0;
      }
      while (this.fed < msgs.length && msgs[this.fed]!.recvTime <= K) this.engine.process(msgs[this.fed++]!);
      if (this.verify) parity = { ok: JSON.stringify(this.engine.fullState()) === JSON.stringify(analyzeFootprintAt(this.dataset, K).fullState()) };
    }
    return { timeframe, cursor: i, total: this.points.length, knowledgeTime: K, candles: K === null ? [] : this.engine.candles(timeframe), events: K === null ? [] : this.engine.events(timeframe), imbalances: K === null ? [] : this.engine.imbalances(timeframe).map((x) => ({ ...x })), stacks: K === null ? [] : this.engine.stacks(timeframe).map((x) => ({ ...x })), snapshot: K === null ? null : this.engine.snapshot(), parity, playing, speed };
  }
  private set(i: number): void {
    const s = this.store.getState();
    this.store.setState(this.compute(s.timeframe, clamp(i, this.points.length), s.playing, s.speed));
  }
  seek(i: number): void {
    this.set(i);
  }
  step(d: number): void {
    const s = this.store.getState();
    const n = clamp(s.cursor + d, s.total);
    if (n === s.cursor) {
      if (d > 0) this.pause();
      return;
    }
    this.set(n);
  }
  reset(): void {
    this.set(0);
  }
  setTimeframe(tf: FPTimeframe): void {
    const s = this.store.getState();
    if (tf === s.timeframe) return;
    const K = s.knowledgeTime;
    this.points = this.pointsOf(tf);
    let i = this.points.findIndex((p) => K !== null && p >= K);
    if (i < 0) i = this.points.length - 1;
    this.store.setState(this.compute(tf, i, s.playing, s.speed));
  }
  play(): void {
    const s = this.store.getState();
    if (s.playing || s.cursor >= s.total - 1) return;
    this.store.setState({ playing: true });
    this.startTimer();
  }
  pause(): void {
    this.stopTimer();
    if (this.store.getState().playing) this.store.setState({ playing: false });
  }
  toggle(): void {
    if (this.store.getState().playing) this.pause();
    else this.play();
  }
  setSpeed(speed: FPReplaySpeed): void {
    this.store.setState({ speed });
    if (this.store.getState().playing) this.startTimer();
  }
  dispose(): void {
    this.stopTimer();
  }
  private startTimer(): void {
    this.stopTimer();
    this.timer = this.timers.setInterval(() => this.step(1), 1000 / this.store.getState().speed);
  }
  private stopTimer(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
function clamp(i: number, total: number): number {
  if (total === 0) return -1;
  return Math.min(total - 1, Math.max(0, Math.round(i)));
}
