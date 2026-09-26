import { SmcEngine } from '../../engines/smc/engine';
import { analyzeSmcAt, smcBarClose, smcKnownBy, smcKnownInput, type SmcDataset } from '../../engines/smc/knowledge';
import { SMC_TIMEFRAMES } from '../../engines/smc/config';
import type { SmcSnapshot } from '../../engines/smc/types';
import { createStore, type Store } from '../../store/createStore';
import type { Candle, Timeframe } from '../../types/market';

export const SMC_REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type SmcReplaySpeed = (typeof SMC_REPLAY_SPEEDS)[number];

export interface SmcReplayState {
  timeframe: Timeframe;
  cursor: number;
  total: number;
  /** Replay clock K: nothing that closes after K is visible to the engine. */
  knowledgeTime: number | null;
  price: number | null;
  visible: readonly Candle[];
  snapshot: SmcSnapshot | null;
  /** Incremental state at K vs a clean recomputation from the candles closed by K. */
  parity: { ok: boolean; mismatch: string | null } | null;
  playing: boolean;
  speed: SmcReplaySpeed;
}

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

/**
 * SMC candle-by-candle replay (separate from every other engine's replay). Frozen closed candles and
 * its own INCREMENTAL engine fed only the candles closed by K. Going backwards starts a new engine
 * (identical by construction). With `verify`, every step is compared with a clean recomputation.
 */
export class SmcReplaySession {
  readonly store: Store<SmcReplayState>;
  private engine: SmcEngine;
  private engineK = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;
  private readonly verify: boolean;

  constructor(
    readonly dataset: SmcDataset,
    timeframe: Timeframe,
    o: { startIndex?: number; timers?: Timers; verify?: boolean } = {},
  ) {
    this.timers = o.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    this.verify = o.verify ?? false;
    this.engine = this.newEngine();
    const total = this.bars(timeframe).length;
    const i = clamp(o.startIndex ?? Math.floor(total * 0.7), total);
    this.store = createStore(this.compute(timeframe, i < 0 ? null : smcBarClose(this.bars(timeframe)[i]!, timeframe), false, 1));
  }

  private newEngine() {
    return new SmcEngine({ instrumentId: this.dataset.instrumentId, tickSize: this.dataset.tickSize, settings: this.dataset.settings });
  }
  private bars(tf: Timeframe): readonly Candle[] {
    return this.dataset.candles[tf] ?? [];
  }

  private compute(timeframe: Timeframe, k: number | null, playing: boolean, speed: SmcReplaySpeed): SmcReplayState {
    const visible = k === null ? [] : smcKnownBy(this.bars(timeframe), timeframe, k);
    let snapshot: SmcSnapshot | null = null;
    let parity: SmcReplayState['parity'] = null;
    let price: number | null = null;
    if (k !== null) {
      if (k < this.engineK) this.engine = this.newEngine();
      this.engineK = k;
      const input = smcKnownInput(this.dataset, k);
      let latest = -Infinity;
      for (const tf of SMC_TIMEFRAMES) {
        const last = input[tf]?.[input[tf]!.length - 1];
        if (last && smcBarClose(last, tf) > latest) {
          latest = smcBarClose(last, tf);
          price = last.close;
        }
      }
      this.engine.update(input, { currentPrice: price });
      snapshot = this.engine.snapshot('REPLAY');
      if (this.verify) {
        const clean = analyzeSmcAt(this.dataset, k, price, 'REPLAY');
        const tf = SMC_TIMEFRAMES.find((t) => JSON.stringify(clean.byTimeframe[t]) !== JSON.stringify(snapshot!.byTimeframe[t]));
        const ok = !tf && JSON.stringify(clean) === JSON.stringify(snapshot);
        parity = { ok, mismatch: ok ? null : tf ? `${tf} differs from the clean recomputation` : 'MTF summary differs from the clean recomputation' };
      }
    }
    return { timeframe, cursor: visible.length - 1, total: this.bars(timeframe).length, knowledgeTime: k, price, visible, snapshot, parity, playing, speed };
  }

  private set(index: number): void {
    const s = this.store.getState();
    const b = this.bars(s.timeframe);
    const i = clamp(index, b.length);
    this.store.setState(this.compute(s.timeframe, i < 0 ? null : smcBarClose(b[i]!, s.timeframe), s.playing, s.speed));
  }
  seek(index: number): void {
    this.set(index);
  }
  step(delta: number): void {
    const s = this.store.getState();
    const next = clamp(s.cursor + delta, s.total);
    if (next === s.cursor) {
      if (delta > 0) this.pause();
      return;
    }
    this.set(next);
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
  setSpeed(speed: SmcReplaySpeed): void {
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
