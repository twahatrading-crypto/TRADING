import { HLE_TIMEFRAMES } from '../../engines/highLowEngine/config';
import { HighLowEngine } from '../../engines/highLowEngine/engine';
import { analyzeHLEAt, hleBarClose, hleKnownBy, hleKnownInput, type HLEDataset } from '../../engines/highLowEngine/knowledge';
import type { HLESnapshot, HLETimeframe } from '../../engines/highLowEngine/types';
import { createStore, type Store } from '../../store/createStore';
import type { Candle } from '../../types/market';

export const HLE_REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type HLEReplaySpeed = (typeof HLE_REPLAY_SPEEDS)[number];

export interface HLEReplayState {
  timeframe: HLETimeframe;
  cursor: number;
  total: number;
  /** Replay clock K: nothing that closes after K is visible to the engine. */
  knowledgeTime: number | null;
  price: number | null;
  visible: readonly Candle[];
  snapshot: HLESnapshot | null;
  /** Incremental state at K vs a clean recomputation from the bars known at K. */
  parity: { ok: boolean; mismatches: string[] } | null;
  playing: boolean;
  speed: HLEReplaySpeed;
}

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
const norm = (s: HLESnapshot) => JSON.stringify({ ...s, price: null, levels: s.levels.map((l) => ({ ...l, distance: null })), setups: s.setups.map((x) => ({ ...x, distance: null })) });

/**
 * High / Low Engine replay (separate from every other replay, incl. High / Low Reversal). Frozen closed candles
 * and its own incremental engine, fed only the bars known at K. Going backwards starts
 * a new engine (identical result by construction). With `verify`, every step is compared
 * with a clean recomputation.
 */
export class HighLowReplaySession {
  readonly store: Store<HLEReplayState>;
  private engine: HighLowEngine;
  private engineK = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;
  private readonly verify: boolean;

  constructor(
    readonly dataset: HLEDataset,
    timeframe: HLETimeframe,
    o: { startIndex?: number; timers?: Timers; verify?: boolean } = {},
  ) {
    this.timers = o.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    this.verify = o.verify ?? false;
    this.engine = this.newEngine();
    const total = this.bars(timeframe).length;
    const i = clamp(o.startIndex ?? Math.floor(total * 0.7), total);
    this.store = createStore(this.compute(timeframe, i < 0 ? null : hleBarClose(this.bars(timeframe)[i]!, timeframe), false, 1));
  }

  private newEngine() {
    return new HighLowEngine({ instrumentId: this.dataset.instrumentId, tickSize: this.dataset.tickSize, settings: this.dataset.settings });
  }
  private bars(tf: HLETimeframe): readonly Candle[] {
    return this.dataset.candles[tf] ?? [];
  }

  private compute(timeframe: HLETimeframe, k: number | null, playing: boolean, speed: HLEReplaySpeed): HLEReplayState {
    const visible = k === null ? [] : hleKnownBy(this.bars(timeframe), timeframe, k);
    let snapshot: HLESnapshot | null = null;
    let parity: HLEReplayState['parity'] = null;
    let price: number | null = null;
    if (k !== null) {
      if (k < this.engineK) this.engine = this.newEngine();
      this.engineK = k;
      const input = hleKnownInput(this.dataset, k);
      let latest = -Infinity;
      for (const tf of HLE_TIMEFRAMES) {
        const last = input[tf]?.[input[tf]!.length - 1];
        if (last && hleBarClose(last, tf) > latest) {
          latest = hleBarClose(last, tf);
          price = last.close;
        }
      }
      this.engine.update(input, { currentPrice: price });
      snapshot = this.engine.snapshot();
      if (this.verify) {
        const ok = norm(analyzeHLEAt(this.dataset, k, price)) === norm(snapshot);
        parity = { ok, mismatches: ok ? [] : [firstMismatch(snapshot, analyzeHLEAt(this.dataset, k, price))] };
      }
    }
    const cursor = visible.length - 1;
    return { timeframe, cursor, total: this.bars(timeframe).length, knowledgeTime: k, price, visible, snapshot, parity, playing, speed };
  }

  private set(index: number): void {
    const s = this.store.getState();
    const b = this.bars(s.timeframe);
    const i = clamp(index, b.length);
    this.store.setState(this.compute(s.timeframe, i < 0 ? null : hleBarClose(b[i]!, s.timeframe), s.playing, s.speed));
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
  toEnd(): void {
    this.set(this.store.getState().total - 1);
  }
  setTimeframe(tf: HLETimeframe): void {
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
  setSpeed(speed: HLEReplaySpeed): void {
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

/** First differing top-level field / setup between two snapshots (for the FAIL message). */
export function firstMismatch(a: HLESnapshot, b: HLESnapshot): string {
  for (const key of Object.keys(a) as (keyof HLESnapshot)[]) {
    if (key === 'price' || key === 'setups' || key === 'levels') continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return `${String(key)} differs from the clean recomputation`;
  }
  for (let k = 0; k < Math.max(a.setups.length, b.setups.length); k++) {
    const x = a.setups[k];
    const y = b.setups[k];
    if (JSON.stringify({ ...x, distance: null }) !== JSON.stringify({ ...y, distance: null })) return `setup ${x?.id ?? y?.id} differs from the clean recomputation`;
  }
  return 'levels differ from the clean recomputation';
}

function clamp(i: number, total: number): number {
  if (total === 0) return -1;
  return Math.min(total - 1, Math.max(0, Math.round(i)));
}
