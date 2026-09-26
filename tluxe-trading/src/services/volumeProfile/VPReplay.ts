import { VolumeProfileEngine } from '../../engines/volumeProfile/engine';
import { analyzeVPAt, vpBarClose, vpKnownBy, vpKnownInput, type VPDataset } from '../../engines/volumeProfile/knowledge';
import type { VPSnapshot } from '../../engines/volumeProfile/types';
import { createStore, type Store } from '../../store/createStore';
import type { Candle, Timeframe } from '../../types/market';

export const VP_REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type VPReplaySpeed = (typeof VP_REPLAY_SPEEDS)[number];
export interface VPReplayState {
  timeframe: Timeframe;
  cursor: number;
  total: number;
  knowledgeTime: number | null;
  visible: readonly Candle[];
  snapshot: VPSnapshot | null;
  parity: { ok: boolean } | null;
  playing: boolean;
  speed: VPReplaySpeed;
}
type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

/** Candle-by-candle Volume Profile replay: incremental engine fed only candles closed by K; parity vs clean recomputation. */
export class VPReplaySession {
  readonly store: Store<VPReplayState>;
  private engine: VolumeProfileEngine;
  private engineK = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;
  private readonly verify: boolean;

  constructor(
    readonly dataset: VPDataset,
    timeframe: Timeframe,
    o: { startIndex?: number; timers?: Timers; verify?: boolean } = {},
  ) {
    this.timers = o.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    this.verify = o.verify ?? false;
    this.engine = this.fresh();
    const total = this.bars(timeframe).length;
    const i = clamp(o.startIndex ?? Math.floor(total * 0.7), total);
    this.store = createStore(this.compute(timeframe, i < 0 ? null : vpBarClose(this.bars(timeframe)[i]!, timeframe), false, 1));
  }
  private fresh() {
    return new VolumeProfileEngine({ instrumentId: this.dataset.instrumentId, tickSize: this.dataset.tickSize, instrument: this.dataset.instrument, settings: this.dataset.settings });
  }
  private bars(tf: Timeframe): readonly Candle[] {
    return this.dataset.candles[tf] ?? [];
  }
  private compute(timeframe: Timeframe, k: number | null, playing: boolean, speed: VPReplaySpeed): VPReplayState {
    const visible = k === null ? [] : vpKnownBy(this.bars(timeframe), timeframe, k);
    let snapshot: VPSnapshot | null = null;
    let parity: VPReplayState['parity'] = null;
    if (k !== null) {
      if (k < this.engineK) this.engine = this.fresh();
      this.engineK = k;
      this.engine.update(vpKnownInput(this.dataset, k), { currentPrice: null });
      snapshot = this.engine.snapshot();
      if (this.verify) parity = { ok: JSON.stringify(snapshot) === JSON.stringify(analyzeVPAt(this.dataset, k, null)) };
    }
    return { timeframe, cursor: visible.length - 1, total: this.bars(timeframe).length, knowledgeTime: k, visible, snapshot, parity, playing, speed };
  }
  private set(index: number): void {
    const s = this.store.getState();
    const b = this.bars(s.timeframe);
    const i = clamp(index, b.length);
    this.store.setState(this.compute(s.timeframe, i < 0 ? null : vpBarClose(b[i]!, s.timeframe), s.playing, s.speed));
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
  setTimeframe(tf: Timeframe): void {
    const s = this.store.getState();
    if (tf !== s.timeframe) this.store.setState(this.compute(tf, s.knowledgeTime, s.playing, s.speed));
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
  setSpeed(speed: VPReplaySpeed): void {
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
