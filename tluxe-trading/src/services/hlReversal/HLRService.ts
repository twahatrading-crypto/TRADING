import { tickSizeOf } from '../../config/instruments';
import { DEFAULT_HLR_SETTINGS, HLR_TIMEFRAMES, type HLRSettings } from '../../engines/hlReversal/config';
import { HighLowReversalEngine, type HLRInput } from '../../engines/hlReversal/engine';
import { hlrClosedOnly, type HLRDataset } from '../../engines/hlReversal/knowledge';
import type { HLRSnapshot, HLRTimeframe } from '../../engines/hlReversal/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';
import type { Candle } from '../../types/market';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';
import { HLRReplaySession } from './HLRReplay';

export interface HLRInstrumentState {
  instrumentId: InstrumentId;
  snapshot: HLRSnapshot | null;
  computedAt: number | null;
}

/**
 * High / Low Reversal Engine v1 runtime (outside React). Its own engine per instrument
 * and its own store; independent of S&R, Liquidity and Order Blocks (it only reads the
 * Order Blocks engine's public output inside its own engine). Subscribes to REAL candles
 * of the active instrument on H4 / H1 / M15 / M5 / M1 — the market service requests
 * history once per instrument/timeframe, so this adds no provider requests or polling.
 * Closed candles only; the forming M1 bar is used for the current price (distance) only.
 */
export class HLRService {
  private readonly stores = new Map<InstrumentId, Store<HLRInstrumentState>>();
  private readonly engines = new Map<InstrumentId, HighLowReversalEngine>();
  private unsubs: (() => void)[] = [];
  private attached: InstrumentId | null = null;
  readonly settings: HLRSettings = { ...DEFAULT_HLR_SETTINGS };

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
  ) {}

  store(id: InstrumentId): Store<HLRInstrumentState> {
    let s = this.stores.get(id);
    if (!s) {
      s = createStore<HLRInstrumentState>({ instrumentId: id, snapshot: null, computedAt: null });
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

  /** Closed candles of THIS instrument only, per timeframe (never another symbol's data). */
  private input(id: InstrumentId): HLRInput {
    const out: HLRInput = {};
    for (const tf of HLR_TIMEFRAMES) out[tf] = hlrClosedOnly(this.market.getCandles(id, tf));
    return out;
  }

  createReplay(timeframe: HLRTimeframe, startIndex?: number, verify = true): HLRReplaySession | null {
    const def = this.instruments.get(this.instruments.store.getState().activeId);
    if (!def) return null;
    const candles: HLRDataset['candles'] = {};
    const input = this.input(def.id);
    for (const tf of HLR_TIMEFRAMES) candles[tf] = Object.freeze((input[tf] ?? []).map((c) => Object.freeze({ ...c })));
    return new HLRReplaySession({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: this.settings, candles }, timeframe, { startIndex, verify });
  }

  private attach(id: InstrumentId): void {
    if (this.attached === id) return;
    this.detach();
    this.attached = id;
    const def = this.instruments.get(id);
    if (!def) return;
    let engine = this.engines.get(id);
    if (!engine) {
      engine = new HighLowReversalEngine({ instrumentId: id, tickSize: tickSizeOf(def), settings: this.settings });
      this.engines.set(id, engine);
    }
    const e = engine;
    const run = () => {
      const m1 = this.market.getCandles(id, 'M1');
      const newest: Candle | undefined = m1[m1.length - 1];
      e.update(this.input(id), { currentPrice: newest ? newest.close : null });
      this.store(id).setState({ instrumentId: id, snapshot: e.snapshot(), computedAt: Date.now() });
    };
    for (const tf of HLR_TIMEFRAMES) this.unsubs.push(this.market.subscribeCandles(id, tf, () => run()));
    run();
  }

  private detach(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.attached = null;
  }
}
