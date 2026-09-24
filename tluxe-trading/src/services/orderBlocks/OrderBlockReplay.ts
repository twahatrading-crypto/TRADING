import { OB_TIMEFRAMES } from '../../engines/orderBlocks/config';
import { OrderBlockTimeframeEngine } from '../../engines/orderBlocks/engine';
import { analyzeOBAt, obBarClose, obKnownBy, type OBDataset } from '../../engines/orderBlocks/knowledge';
import { buildOBMulti } from '../../engines/orderBlocks/mtf';
import type { OBMultiSnapshot, OBSnapshot } from '../../engines/orderBlocks/types';
import { createStore, type Store } from '../../store/createStore';
import type { Candle, Timeframe } from '../../types/market';

export const OB_REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type OBReplaySpeed = (typeof OB_REPLAY_SPEEDS)[number];

export interface OBReplayState {
  timeframe: Timeframe;
  cursor: number;
  total: number;
  barTime: number | null;
  /** Replay clock K: nothing that closes after K is visible to any engine. */
  knowledgeTime: number | null;
  price: number | null;
  visible: readonly Candle[];
  byTimeframe: Partial<Record<Timeframe, OBSnapshot>>;
  multi: OBMultiSnapshot;
  /** Parity check at this step: incremental state vs a clean recomputation from bars known at K. */
  parity: { ok: boolean; mismatches: string[] } | null;
  playing: boolean;
  speed: OBReplaySpeed;
}

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

/**
 * Order Block replay (separate from S&R and Liquidity replay). Frozen closed candles,
 * own incremental engines; every timeframe is fed only the bars known at K. With
 * `verify`, each step is compared against a clean recomputation and mismatches are reported.
 */
export class OrderBlockReplaySession {
  readonly store: Store<OBReplayState>;
  private readonly engines = new Map<Timeframe, OrderBlockTimeframeEngine>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers: Timers;
  private readonly verify: boolean;

  constructor(
    readonly dataset: OBDataset,
    timeframe: Timeframe,
    o: { startIndex?: number; timers?: Timers; verify?: boolean } = {},
  ) {
    this.timers = o.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t) };
    this.verify = o.verify ?? false;
    for (const tf of OB_TIMEFRAMES) {
      if (dataset.candles[tf]) this.engines.set(tf, new OrderBlockTimeframeEngine({ instrumentId: dataset.instrumentId, timeframe: tf, tickSize: dataset.tickSize, settings: dataset.settings }));
    }
    const total = this.bars(timeframe).length;
    const start = o.startIndex ?? Math.max(Math.min(total - 1, dataset.settings.minHistoryBars + 20), Math.floor(total * 0.7));
    const i = clamp(start, total);
    this.store = createStore(this.compute(timeframe, i < 0 ? null : obBarClose(this.bars(timeframe)[i]!, timeframe), false, 1));
  }

  private bars(tf: Timeframe): readonly Candle[] {
    return this.dataset.candles[tf] ?? [];
  }

  private compute(timeframe: Timeframe, k: number | null, playing: boolean, speed: OBReplaySpeed): OBReplayState {
    const visible = k === null ? [] : obKnownBy(this.bars(timeframe), timeframe, k);
    const known = new Map<Timeframe, readonly Candle[]>();
    for (const tf of this.engines.keys()) known.set(tf, k === null ? [] : obKnownBy(this.bars(tf), tf, k));
    let price: number | null = null;
    let latest = -Infinity;
    for (const [tf, b] of known) {
      const last = b[b.length - 1];
      if (last && obBarClose(last, tf) > latest) {
        latest = obBarClose(last, tf);
        price = last.close;
      }
    }
    const byTimeframe: Partial<Record<Timeframe, OBSnapshot>> = {};
    for (const [tf, e] of this.engines) {
      e.update(known.get(tf)!, { lastBarClosed: true, currentPrice: price });
      byTimeframe[tf] = e.snapshot();
    }
    const multi = buildOBMulti(this.dataset.instrumentId, byTimeframe, this.dataset.settings);
    let parity: OBReplayState['parity'] = null;
    if (this.verify && k !== null) {
      const clean = analyzeOBAt(this.dataset, k, price);
      const mismatches: string[] = [];
      for (const tf of Object.keys(clean.byTimeframe) as Timeframe[]) {
        if (JSON.stringify(clean.byTimeframe[tf]) !== JSON.stringify(byTimeframe[tf])) mismatches.push(`${tf}: incremental ≠ clean recomputation`);
      }
      if (JSON.stringify(clean.confluences) !== JSON.stringify(multi.confluences)) mismatches.push('MTF confluence mismatch');
      parity = { ok: mismatches.length === 0, mismatches };
    }
    const cursor = visible.length - 1;
    return { timeframe, cursor, total: this.bars(timeframe).length, barTime: cursor >= 0 ? visible[cursor]!.time : null, knowledgeTime: k, price, visible, byTimeframe, multi, parity, playing, speed };
  }

  private set(index: number): void {
    const s = this.store.getState();
    const b = this.bars(s.timeframe);
    const i = clamp(index, b.length);
    this.store.setState(this.compute(s.timeframe, i < 0 ? null : obBarClose(b[i]!, s.timeframe), s.playing, s.speed));
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
  setSpeed(speed: OBReplaySpeed): void {
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
