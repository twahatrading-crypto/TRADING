import { tickSizeOf } from '../../config/instruments';
import { DEFAULT_HLE_SETTINGS, HLE_TIMEFRAMES, type HLESettings } from '../../engines/highLowEngine/config';
import { HighLowEngine, type HLEInput } from '../../engines/highLowEngine/engine';
import { hleClosedOnly, type HLEDataset } from '../../engines/highLowEngine/knowledge';
import type { HLEEvent, HLESnapshot, HLETimeframe } from '../../engines/highLowEngine/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';
import { HighLowAlerts, type AlertChannels } from './alerts';
import { HighLowReplaySession } from './HighLowReplay';
import { SignalLog } from './signalLog';

type KV = Pick<Storage, 'getItem' | 'setItem'> | null;

export interface HLEInstrumentState {
  instrumentId: InstrumentId;
  snapshot: HLESnapshot | null;
  /** Persistent, de-duplicated signal log (engine events merged across sessions). */
  log: HLEEvent[];
  /** Wall-clock time of the last analysis (ms). */
  computedAt: number | null;
}

/**
 * High / Low Engine runtime (outside React): MT5 → TLUXE bridge → MarketDataService → here.
 * Own engine per instrument, own store, own log and alerts — separate from High / Low Reversal.
 * Subscribes to H4 / H1 / M15 / M5 / M1 of the ACTIVE instrument (history is requested once per
 * instrument/timeframe by the market service: no extra polling). Closed candles only; the forming
 * M1 bar only sets the current price.
 */
export class HighLowEngineService {
  private readonly stores = new Map<InstrumentId, Store<HLEInstrumentState>>();
  private readonly engines = new Map<InstrumentId, HighLowEngine>();
  private unsubs: (() => void)[] = [];
  private attached: InstrumentId | null = null;
  readonly settings: HLESettings = { ...DEFAULT_HLE_SETTINGS };
  readonly log: SignalLog;
  readonly alerts: HighLowAlerts;

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
    storage: KV = null,
    channels?: Partial<AlertChannels>,
  ) {
    this.log = new SignalLog(storage);
    this.alerts = new HighLowAlerts(storage, channels);
  }

  store(id: InstrumentId): Store<HLEInstrumentState> {
    let s = this.stores.get(id);
    if (!s) {
      s = createStore<HLEInstrumentState>({ instrumentId: id, snapshot: null, log: this.log.get(id), computedAt: null });
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

  private input(id: InstrumentId): HLEInput {
    const out: HLEInput = {};
    for (const tf of HLE_TIMEFRAMES) out[tf] = hleClosedOnly(this.market.getCandles(id, tf));
    return out;
  }

  createReplay(timeframe: HLETimeframe, startIndex?: number, verify = true): HighLowReplaySession | null {
    const def = this.instruments.get(this.instruments.store.getState().activeId);
    if (!def) return null;
    const candles: HLEDataset['candles'] = {};
    const input = this.input(def.id);
    for (const tf of HLE_TIMEFRAMES) candles[tf] = Object.freeze((input[tf] ?? []).map((c) => Object.freeze({ ...c })));
    return new HighLowReplaySession({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: this.settings, candles }, timeframe, { startIndex, verify });
  }

  private attach(id: InstrumentId): void {
    if (this.attached === id) return;
    this.detach();
    this.attached = id;
    const def = this.instruments.get(id);
    if (!def) return;
    let engine = this.engines.get(id);
    if (!engine) {
      engine = new HighLowEngine({ instrumentId: id, tickSize: tickSizeOf(def), settings: this.settings });
      this.engines.set(id, engine);
    }
    const e = engine;
    const run = () => {
      const m1 = this.market.getCandles(id, 'M1');
      e.update(this.input(id), { currentPrice: m1.length ? m1[m1.length - 1]!.close : null });
      const snapshot = e.snapshot();
      const log = this.log.merge(id, snapshot.events);
      this.store(id).setState({ instrumentId: id, snapshot, log, computedAt: Date.now() });
      this.alerts.observe(id, snapshot);
    };
    for (const tf of HLE_TIMEFRAMES) this.unsubs.push(this.market.subscribeCandles(id, tf, () => run()));
    run();
  }

  private detach(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.attached = null;
  }
}
