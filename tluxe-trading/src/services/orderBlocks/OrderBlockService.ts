import { TIMEFRAMES } from '../../config/instrument';
import { tickSizeOf } from '../../config/instruments';
import { DEFAULT_OB_SETTINGS, type OBSettings } from '../../engines/orderBlocks/config';
import { OrderBlockTimeframeEngine } from '../../engines/orderBlocks/engine';
import { obClosedOnly, type OBDataset } from '../../engines/orderBlocks/knowledge';
import { buildOBMulti } from '../../engines/orderBlocks/mtf';
import type { OBMultiSnapshot, OBSnapshot } from '../../engines/orderBlocks/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';
import { OrderBlockReplaySession } from './OrderBlockReplay';

export interface OBInstrumentState {
  instrumentId: InstrumentId;
  byTimeframe: Partial<Record<Timeframe, OBSnapshot>>;
  multi: OBMultiSnapshot | null;
  computedAt: number | null;
}

/** Provider-flagged streams: closed bars build structure; the forming bar only sets the price. */
export function feedOrderBlocks(engine: OrderBlockTimeframeEngine, candles: readonly Candle[]): void {
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
 * Order Block Engine v1 runtime (outside React). Independent of S&R and Liquidity:
 * own engines, own stores, own settings. Subscribes to REAL candles of the active
 * instrument only (history is requested once per instrument/timeframe by the market
 * service, so this adds no provider requests or polling).
 */
export class OrderBlockService {
  private readonly stores = new Map<InstrumentId, Store<OBInstrumentState>>();
  private readonly engines = new Map<string, OrderBlockTimeframeEngine>();
  private unsubs: (() => void)[] = [];
  private attached: InstrumentId | null = null;
  private current: OBSettings = { ...DEFAULT_OB_SETTINGS };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
  ) {}

  get settings(): OBSettings {
    return this.current;
  }

  /**
   * Change engine settings (e.g. boundary mode wickBody ↔ fullRange). Every engine is
   * rebuilt from the same real candles — a deterministic recomputation, never an edit
   * of existing blocks.
   */
  configure(patch: Partial<OBSettings>): void {
    const next = { ...this.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.engines.clear();
    for (const s of this.stores.values()) s.setState({ byTimeframe: {}, multi: null, computedAt: null });
    const id = this.attached;
    this.detach();
    if (id) this.attach(id);
    this.listeners.forEach((l) => l());
  }

  /** Notified after `configure` (settings snapshot changed). */
  onSettings(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  store(id: InstrumentId): Store<OBInstrumentState> {
    let s = this.stores.get(id);
    if (!s) {
      s = createStore<OBInstrumentState>({ instrumentId: id, byTimeframe: {}, multi: null, computedAt: null });
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

  createReplay(timeframe: Timeframe, startIndex?: number, verify = true): OrderBlockReplaySession | null {
    const def = this.instruments.get(this.instruments.store.getState().activeId);
    if (!def) return null;
    const candles: OBDataset['candles'] = {};
    for (const tf of TIMEFRAMES) candles[tf] = Object.freeze(obClosedOnly(this.market.getCandles(def.id, tf)).map((c) => Object.freeze({ ...c })));
    return new OrderBlockReplaySession({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: this.settings, candles }, timeframe, { startIndex, verify });
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
        engine = new OrderBlockTimeframeEngine({ instrumentId: id, timeframe: tf, tickSize: tickSizeOf(def), settings: this.settings });
        this.engines.set(key, engine);
      }
      const e = engine;
      const run = (c: readonly Candle[]) => {
        feedOrderBlocks(e, c);
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

  private publish(id: InstrumentId, tf: Timeframe, snap: OBSnapshot): void {
    const store = this.store(id);
    const byTimeframe = { ...store.getState().byTimeframe, [tf]: snap };
    store.setState({ instrumentId: id, byTimeframe, multi: buildOBMulti(id, byTimeframe, this.settings), computedAt: Date.now() });
  }
}
