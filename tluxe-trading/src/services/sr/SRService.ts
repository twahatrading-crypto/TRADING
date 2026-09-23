import { TIMEFRAMES } from '../../config/instrument';
import { tickSizeOf } from '../../config/instruments';
import { buildMultiSnapshot } from '../../engines/sr/confluence';
import { SRTimeframeEngine } from '../../engines/sr/engine';
import { sanitizeSettings, settingsKey, type SRSettings } from '../../engines/sr/settings';
import type { SRMultiSnapshot, SRSnapshot } from '../../engines/sr/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';

export const SR_SETTINGS_KEY = 'tluxe.sr.settings.v1';

export interface SRInstrumentState {
  instrumentId: InstrumentId;
  byTimeframe: Partial<Record<Timeframe, SRSnapshot>>;
  multi: SRMultiSnapshot | null;
  /** Local time of the last recomputation. */
  computedAt: number | null;
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Runs the S&R engine outside React.
 *
 * - Subscribes to REAL candles (MarketDataService) for every timeframe of the
 *   active instrument; nothing here fabricates or loads fixture data.
 * - One incremental engine per (instrument, timeframe); new bars are processed
 *   incrementally, never re-rendering-driven.
 * - One store per instrument, so switching instruments can never show another
 *   instrument's zones.
 * - Settings changes rebuild every engine deterministically.
 */
export class SRService {
  readonly settingsStore: Store<{ settings: SRSettings }>;
  private readonly stores = new Map<InstrumentId, Store<SRInstrumentState>>();
  private readonly engines = new Map<string, SRTimeframeEngine>();
  private unsubs: (() => void)[] = [];
  private attached: InstrumentId | null = null;

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
    private readonly storage: KeyValueStorage | null = null,
  ) {
    let stored: Partial<SRSettings> | null = null;
    try {
      const raw = storage?.getItem(SR_SETTINGS_KEY);
      stored = raw ? (JSON.parse(raw) as Partial<SRSettings>) : null;
    } catch {
      stored = null;
    }
    this.settingsStore = createStore({ settings: sanitizeSettings(stored) });
  }

  get settings(): SRSettings {
    return this.settingsStore.getState().settings;
  }

  store(id: InstrumentId): Store<SRInstrumentState> {
    let s = this.stores.get(id);
    if (!s) {
      s = createStore<SRInstrumentState>({ instrumentId: id, byTimeframe: {}, multi: null, computedAt: null });
      this.stores.set(id, s);
    }
    return s;
  }

  /** Follow the selected instrument. Returns a stop function. */
  start(): () => void {
    this.attach(this.instruments.store.getState().activeId);
    const stop = this.instruments.store.subscribe(() => this.attach(this.instruments.store.getState().activeId));
    return () => {
      stop();
      this.detach();
    };
  }

  setSettings(patch: Partial<SRSettings>): void {
    const next = sanitizeSettings({ ...this.settings, ...patch });
    if (settingsKey(next) === settingsKey(this.settings)) return;
    this.settingsStore.setState({ settings: next });
    try {
      this.storage?.setItem(SR_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked */
    }
    this.engines.clear();
    const id = this.attached;
    if (id) {
      this.detach();
      this.attach(id);
    }
  }

  resetSettings(): void {
    this.setSettings(sanitizeSettings(null));
  }

  private engineFor(def: InstrumentDefinition, tf: Timeframe): SRTimeframeEngine {
    const key = `${def.id}|${tf}`;
    let e = this.engines.get(key);
    if (!e) {
      e = new SRTimeframeEngine({ instrumentId: def.id, timeframe: tf, tickSize: tickSizeOf(def), settings: this.settings });
      this.engines.set(key, e);
    }
    return e;
  }

  private attach(id: InstrumentId): void {
    if (this.attached === id) return;
    this.detach();
    this.attached = id;
    const def = this.instruments.get(id);
    if (!def) return;
    for (const tf of TIMEFRAMES) {
      const engine = this.engineFor(def, tf);
      const run = (candles: readonly Candle[]) => {
        engine.update(candles);
        this.publish(id, tf, engine.snapshot());
      };
      this.unsubs.push(this.market.subscribeCandles(id, tf, (candles) => run(candles)));
      const existing = this.market.getCandles(id, tf);
      if (existing.length) run(existing);
    }
  }

  private detach(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.attached = null;
  }

  private publish(id: InstrumentId, tf: Timeframe, snap: SRSnapshot): void {
    const store = this.store(id);
    const byTimeframe = { ...store.getState().byTimeframe, [tf]: snap };
    store.setState({
      instrumentId: id,
      byTimeframe,
      multi: buildMultiSnapshot(id, byTimeframe, this.settings),
      computedAt: Date.now(),
    });
  }
}
