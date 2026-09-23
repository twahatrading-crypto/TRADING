import { buildMultiSnapshot } from '../../engines/sr/confluence';
import { SRTimeframeEngine } from '../../engines/sr/engine';
import { barCloseTime, knownAt, REPLAY_TIMEFRAMES, type ReplayDataset } from '../../engines/sr/knowledge';
import type { SRMultiSnapshot, SRSnapshot } from '../../engines/sr/types';
import { createStore, type Store } from '../../store/createStore';
import type { Candle, Timeframe } from '../../types/market';

export const REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface ReplayState {
  timeframe: Timeframe;
  /** Index of the newest revealed CLOSED bar on the chart timeframe (−1 = none known yet). */
  cursor: number;
  /** Closed bars available on the chart timeframe. */
  total: number;
  /** Open time of the cursor bar (UTC s). */
  barTime: number | null;
  /** Replay clock K: nothing that closes after K is visible to any engine. Stepping sets K to a chart bar's close. */
  knowledgeTime: number | null;
  /** Price at K: close of the most recent bar closed by K on any timeframe (used for distances only). */
  price: number | null;
  /** Chart-timeframe bars revealed so far (all closed, all ≤ K). */
  visible: readonly Candle[];
  byTimeframe: Partial<Record<Timeframe, SRSnapshot>>;
  multi: SRMultiSnapshot;
  playing: boolean;
  speed: ReplaySpeed;
}

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

/**
 * Historical S&R replay for one instrument.
 *
 * - Works on a frozen copy of closed candles taken when replay starts; live
 *   data keeps flowing into the market store but never reaches the replay.
 * - Has its OWN engines: the live S&R service and its stores are untouched.
 * - Every timeframe's engine receives only the bars known at K (see
 *   `knowledge.ts`), so no future bar and no still-forming higher-timeframe bar
 *   can influence any zone, touch, break, flip, score or confluence.
 * - Forward steps are incremental; backward steps make the engines rebuild
 *   deterministically from the shorter prefix.
 */
export class SRReplaySession {
  readonly store: Store<ReplayState>;
  private readonly engines = new Map<Timeframe, SRTimeframeEngine>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;

  constructor(
    readonly dataset: ReplayDataset,
    timeframe: Timeframe,
    opts: { startIndex?: number; timers?: Timers } = {},
  ) {
    this.timers = opts.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    for (const tf of REPLAY_TIMEFRAMES) {
      if (dataset.candles[tf]) {
        this.engines.set(tf, new SRTimeframeEngine({ instrumentId: dataset.instrumentId, timeframe: tf, tickSize: dataset.tickSize, settings: dataset.settings }));
      }
    }
    const total = this.bars(timeframe).length;
    const start = opts.startIndex ?? defaultStart(total, dataset.settings.minHistoryBars);
    const i = clamp(start, total);
    this.store = createStore<ReplayState>(this.compute(timeframe, i < 0 ? null : barCloseTime(this.bars(timeframe)[i]!, timeframe), false, 1));
  }

  private bars(tf: Timeframe): readonly Candle[] {
    return this.dataset.candles[tf] ?? [];
  }

  /** State at replay clock K (null = nothing known yet). The chart shows its timeframe's bars closed by K. */
  private compute(timeframe: Timeframe, k: number | null, playing: boolean, speed: ReplaySpeed): ReplayState {
    const bars = this.bars(timeframe);
    const visible = k === null ? [] : knownAt(bars, timeframe, k);
    const cursor = visible.length - 1;
    const byTimeframe: Partial<Record<Timeframe, SRSnapshot>> = {};
    const known = new Map<Timeframe, readonly Candle[]>();
    for (const tf of this.engines.keys()) known.set(tf, k === null ? [] : knownAt(this.bars(tf), tf, k));
    const price = priceAt(known);
    for (const [tf, engine] of this.engines) {
      engine.update(known.get(tf)!, { lastBarClosed: true, currentPrice: price });
      byTimeframe[tf] = engine.snapshot();
    }
    return {
      timeframe,
      cursor,
      total: bars.length,
      barTime: cursor >= 0 ? visible[cursor]!.time : null,
      knowledgeTime: k,
      price,
      visible,
      byTimeframe,
      multi: buildMultiSnapshot(this.dataset.instrumentId, byTimeframe, this.dataset.settings),
      playing,
      speed,
    };
  }

  /** Move the clock to the close of chart bar `index`. */
  private set(index: number): void {
    const s = this.store.getState();
    const bars = this.bars(s.timeframe);
    const i = clamp(index, bars.length);
    this.store.setState(this.compute(s.timeframe, i < 0 ? null : barCloseTime(bars[i]!, s.timeframe), s.playing, s.speed));
  }

  /* -------------------------------- controls ------------------------------- */

  seek(index: number): void {
    this.set(index);
  }

  /** ±1 reveals / hides exactly one closed bar of the chart timeframe. */
  step(delta: number): void {
    const s = this.store.getState();
    const next = clamp(s.cursor + delta, s.total);
    if (next === s.cursor) {
      if (delta > 0) this.pause();
      return;
    }
    this.set(next);
  }

  toStart(): void {
    this.set(0);
  }

  toEnd(): void {
    this.set(this.store.getState().total - 1);
  }

  /** Change timeframe WITHOUT moving the replay clock: the chart shows the new timeframe's bars closed by K. */
  setTimeframe(tf: Timeframe): void {
    const s = this.store.getState();
    if (tf === s.timeframe) return;
    this.store.setState(this.compute(tf, s.knowledgeTime, s.playing, s.speed));
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

  setSpeed(speed: ReplaySpeed): void {
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

/** Close of the latest bar closed by K across timeframes (ties → the smaller timeframe, listed first). */
function priceAt(known: Map<Timeframe, readonly Candle[]>): number | null {
  let best: { close: number; t: number } | null = null;
  for (const [tf, bars] of known) {
    const last = bars[bars.length - 1];
    if (!last) continue;
    const t = barCloseTime(last, tf);
    if (!best || t > best.t) best = { close: last.close, t };
  }
  return best ? best.close : null;
}

function clamp(i: number, total: number): number {
  if (total === 0) return -1;
  return Math.min(total - 1, Math.max(0, Math.round(i)));
}

/** Default start: 70 % into the history, but never before the engine has enough bars to report zones. */
function defaultStart(total: number, minBars: number): number {
  return Math.max(Math.min(total - 1, minBars + 20), Math.floor(total * 0.7));
}
