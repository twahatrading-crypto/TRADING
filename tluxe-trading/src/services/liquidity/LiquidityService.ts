import { TIMEFRAMES } from '../../config/instrument';
import { tickSizeOf } from '../../config/instruments';
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from '../../engines/liquidity/config';
import { LiquidityTimeframeEngine } from '../../engines/liquidity/engine';
import { closedOnly, type LiquidityDataset } from '../../engines/liquidity/knowledge';
import { buildLiquidityMulti } from '../../engines/liquidity/mtf';
import type { LiquidityMultiSnapshot, LiquiditySnapshot } from '../../engines/liquidity/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';
import { LiquidityReplaySession } from './LiquidityReplay';

export interface LiquidityInstrumentState {
  instrumentId: InstrumentId;
  byTimeframe: Partial<Record<Timeframe, LiquiditySnapshot>>;
  multi: LiquidityMultiSnapshot | null;
  computedAt: number | null;
}

/**
 * Closed-bar contract. Provider-flagged streams: only closed bars build structure;
 * the forming bar (if any) is passed as the newest candle so the engine uses it
 * for current price / live probe ONLY. Unflagged streams: newest bar = forming.
 */
export function feedLiquidity(engine: LiquidityTimeframeEngine, candles: readonly Candle[]): void {
  if (!candles.some((c) => c.isClosed !== undefined)) {
    engine.update(candles);
    return;
  }
  const closed = candles.filter((c) => c.isClosed === true);
  const newest = candles[candles.length - 1];
  const forming = newest && newest.isClosed === false ? newest : null;
  engine.update(forming ? [...closed, forming] : closed, { lastBarClosed: !forming });
}

/**
 * Liquidity Engine v1 runtime (outside React). Independent of the S&R service:
 * its own engines, its own stores, its own settings. Subscribes to REAL candles
 * of the active instrument only (MarketDataService requests history once per
 * instrument/timeframe, so this adds no provider requests or polling).
 */
export class LiquidityService {
  private readonly stores = new Map<InstrumentId, Store<LiquidityInstrumentState>>();
  private readonly engines = new Map<string, LiquidityTimeframeEngine>();
  private unsubs: (() => void)[] = [];
  private attached: InstrumentId | null = null;
  readonly settings: LiquiditySettings = { ...DEFAULT_LIQUIDITY_SETTINGS };

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
  ) {}

  store(id: InstrumentId): Store<LiquidityInstrumentState> {
    let s = this.stores.get(id);
    if (!s) {
      s = createStore<LiquidityInstrumentState>({ instrumentId: id, byTimeframe: {}, multi: null, computedAt: null });
      this.stores.set(id, s);
    }
    return s;
  }

  start(): () => void {
    this.attach(this.instruments.store.getState().activeId);
    const stop = this.instruments.store.subscribe(() => this.attach(this.instruments.store.getState().activeId));
    return () => {
      stop();
      this.detach();
    };
  }

  /** Replay the active instrument from a frozen copy of the loaded REAL candles (closed bars only). */
  createReplay(timeframe: Timeframe, startIndex?: number): LiquidityReplaySession | null {
    const def = this.instruments.get(this.instruments.store.getState().activeId);
    if (!def) return null;
    const candles: LiquidityDataset['candles'] = {};
    for (const tf of TIMEFRAMES) candles[tf] = Object.freeze(closedOnly(this.market.getCandles(def.id, tf)).map((c) => Object.freeze({ ...c })));
    return new LiquidityReplaySession({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: this.settings, candles }, timeframe, { startIndex });
  }

  private attach(id: InstrumentId): void {
    if (this.attached === id) return;
    this.detach();
    this.attached = id;
    const def = this.instruments.get(id);
    if (!def) return;
    for (const tf of TIMEFRAMES) {
      const key = `${id}|${tf}`;
      let engine = this.engines.get(key);
      if (!engine) {
        engine = new LiquidityTimeframeEngine({ instrumentId: id, timeframe: tf, tickSize: tickSizeOf(def), settings: this.settings });
        this.engines.set(key, engine);
      }
      const e = engine;
      const run = (candles: readonly Candle[]) => {
        feedLiquidity(e, candles);
        this.publish(id, tf, e.snapshot());
      };
      this.unsubs.push(this.market.subscribeCandles(id, tf, (c) => run(c)));
      const existing = this.market.getCandles(id, tf);
      if (existing.length) run(existing);
    }
  }

  private detach(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.attached = null;
  }

  private publish(id: InstrumentId, tf: Timeframe, snap: LiquiditySnapshot): void {
    const store = this.store(id);
    const byTimeframe = { ...store.getState().byTimeframe, [tf]: snap };
    store.setState({ instrumentId: id, byTimeframe, multi: buildLiquidityMulti(id, byTimeframe, this.settings), computedAt: Date.now() });
  }
}
