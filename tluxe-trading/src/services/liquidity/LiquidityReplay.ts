import { LIQUIDITY_TIMEFRAMES } from '../../engines/liquidity/config';
import { LiquidityTimeframeEngine } from '../../engines/liquidity/engine';
import { knownBy, liquidityBarClose, type LiquidityDataset } from '../../engines/liquidity/knowledge';
import { buildLiquidityMulti } from '../../engines/liquidity/mtf';
import type { LiquidityMultiSnapshot, LiquiditySnapshot } from '../../engines/liquidity/types';
import { createStore, type Store } from '../../store/createStore';
import type { Candle, Timeframe } from '../../types/market';

export const LIQUIDITY_REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type LiquidityReplaySpeed = (typeof LIQUIDITY_REPLAY_SPEEDS)[number];

export interface LiquidityReplayState {
  timeframe: Timeframe;
  cursor: number;
  total: number;
  barTime: number | null;
  /** Replay clock K: nothing that closes after K is visible to any engine. */
  knowledgeTime: number | null;
  /** Close of the latest bar closed by K on any timeframe (distances only). */
  price: number | null;
  visible: readonly Candle[];
  byTimeframe: Partial<Record<Timeframe, LiquiditySnapshot>>;
  multi: LiquidityMultiSnapshot;
  playing: boolean;
  speed: LiquidityReplaySpeed;
}

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

/**
 * Liquidity replay (separate from S&R replay): frozen closed candles, own engines,
 * every timeframe fed only the bars known at K. Pools, tests and sweep markers can
 * therefore never appear before they were knowable.
 */
export class LiquidityReplaySession {
  readonly store: Store<LiquidityReplayState>;
  private readonly engines = new Map<Timeframe, LiquidityTimeframeEngine>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;

  constructor(
    readonly dataset: LiquidityDataset,
    timeframe: Timeframe,
    o: { startIndex?: number; timers?: Timers } = {},
  ) {
    this.timers = o.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    for (const tf of LIQUIDITY_TIMEFRAMES) {
      if (dataset.candles[tf]) this.engines.set(tf, new LiquidityTimeframeEngine({ instrumentId: dataset.instrumentId, timeframe: tf, tickSize: dataset.tickSize, settings: dataset.settings }));
    }
    const total = this.bars(timeframe).length;
    const start = o.startIndex ?? Math.max(Math.min(total - 1, dataset.settings.minHistoryBars + 20), Math.floor(total * 0.7));
    const i = clamp(start, total);
    this.store = createStore(this.compute(timeframe, i < 0 ? null : liquidityBarClose(this.bars(timeframe)[i]!, timeframe), false, 1));
  }

  private bars(tf: Timeframe): readonly Candle[] {
    return this.dataset.candles[tf] ?? [];
  }

  private compute(timeframe: Timeframe, k: number | null, playing: boolean, speed: LiquidityReplaySpeed): LiquidityReplayState {
    const visible = k === null ? [] : knownBy(this.bars(timeframe), timeframe, k);
    const known = new Map<Timeframe, readonly Candle[]>();
    for (const tf of this.engines.keys()) known.set(tf, k === null ? [] : knownBy(this.bars(tf), tf, k));
    let price: number | null = null;
    let latest = -Infinity;
    for (const [tf, b] of known) {
      const last = b[b.length - 1];
      if (last && liquidityBarClose(last, tf) > latest) {
        latest = liquidityBarClose(last, tf);
        price = last.close;
      }
    }
    const byTimeframe: Partial<Record<Timeframe, LiquiditySnapshot>> = {};
    for (const [tf, e] of this.engines) {
      e.update(known.get(tf)!, { lastBarClosed: true, currentPrice: price });
      byTimeframe[tf] = e.snapshot();
    }
    const cursor = visible.length - 1;
    return {
      timeframe,
      cursor,
      total: this.bars(timeframe).length,
      barTime: cursor >= 0 ? visible[cursor]!.time : null,
      knowledgeTime: k,
      price,
      visible,
      byTimeframe,
      multi: buildLiquidityMulti(this.dataset.instrumentId, byTimeframe, this.dataset.settings),
      playing,
      speed,
    };
  }

  private set(index: number): void {
    const s = this.store.getState();
    const b = this.bars(s.timeframe);
    const i = clamp(index, b.length);
    this.store.setState(this.compute(s.timeframe, i < 0 ? null : liquidityBarClose(b[i]!, s.timeframe), s.playing, s.speed));
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
  /** Reset to the first candle. */
  toStart(): void {
    this.set(0);
  }
  toEnd(): void {
    this.set(this.store.getState().total - 1);
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
  setSpeed(speed: LiquidityReplaySpeed): void {
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
