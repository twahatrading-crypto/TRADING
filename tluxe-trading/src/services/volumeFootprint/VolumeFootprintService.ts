import { tickSizeOf } from '../../config/instruments';
import { DEFAULT_FP_SETTINGS, settingsKey, type FootprintSettings } from '../../engines/volumeFootprint/config';
import { FootprintEngine } from '../../engines/volumeFootprint/engine';
import type { FPTimeframe, FootprintMsg, FootprintSnapshot } from '../../engines/volumeFootprint/types';
import type { FootprintSink, FootprintTradeProvider } from '../../providers/footprint/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import { FPReplaySession } from './FPReplay';

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now: () => number };

/** At most one React-visible store update per interval — never one per trade. */
export const FP_PUBLISH_MS = 150;
/** No trade / heartbeat for this long → trade feed STALE. */
export const FP_STALE_MS = 5000;
/** Recorded evidence (bounded): the exact messages received, used for replay and settings rebuilds. */
export const FP_MAX_RECORDED = 400_000;

export interface FPState {
  instrumentId: InstrumentId;
  /** False when the instrument is not an exchange-traded future (spot / CFD / MT5 symbols). */
  supported: boolean;
  /** Why the footprint cannot be built (missing provider / capability), null when it can. */
  reason: string | null;
  provider: string | null;
  testProvider: boolean;
  stale: boolean;
  snapshot: FootprintSnapshot | null;
  version: number;
  settings: FootprintSettings;
  recorded: number;
}

const unsupported = (def: InstrumentDefinition | undefined): string | null => {
  if (!def) return 'Unknown instrument.';
  if (def.kind !== 'future')
    return `${def.shortName} is not an exchange-traded future. A footprint needs exchange time & sales with an aggressor side (e.g. GC — COMEX Gold Futures). MT5 OHLC / tick volume is never converted into Bid × Ask.`;
  return null;
};

/**
 * Volume Footprint runtime (outside React): provider → recorded messages → FootprintEngine (incremental).
 * ONE engine for the active instrument; the provider is connected ONCE (connectServices), so page switches
 * and HMR never add subscriptions. The canvas reads the engine directly; the store is updated at most every
 * FP_PUBLISH_MS.
 */
export class VolumeFootprintService {
  readonly store: Store<FPState>;
  private engine_: FootprintEngine | null = null;
  private log: FootprintMsg[] = [];
  private active: InstrumentDefinition | null = null;
  private subscribed = false;
  private started = false;
  private lastMsgAt: number | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private settings: FootprintSettings = { ...DEFAULT_FP_SETTINGS };
  private readonly timers: Timers;
  /** Messages accepted from the provider (tests / diagnostics). */
  received = 0;
  publishes = 0;

  constructor(
    private readonly instruments: InstrumentSelection,
    private readonly provider: FootprintTradeProvider | null,
    opts: { timers?: Timers } = {},
  ) {
    this.timers = opts.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t), setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
    const def = this.instruments.get(this.instruments.store.getState().activeId);
    this.store = createStore<FPState>(this.initial(def));
  }

  private initial(def: InstrumentDefinition | undefined): FPState {
    const why = unsupported(def);
    return {
      instrumentId: def?.id ?? this.instruments.store.getState().activeId,
      supported: !why,
      reason: why ?? (this.provider ? null : 'No exchange trade provider connected. A Rithmic / T4 / CQG time & sales adapter with aggressor side is required.'),
      provider: this.provider?.info.name ?? null,
      testProvider: !!this.provider?.info.test,
      stale: false,
      snapshot: null,
      version: 0,
      settings: { ...this.settings },
      recorded: 0,
    };
  }

  engine(): FootprintEngine | null {
    return this.engine_;
  }
  recording(): readonly FootprintMsg[] {
    return this.log;
  }

  private sink: FootprintSink = {
    message: (m) => this.accept(m),
    status: (id, status, detail) => this.accept({ type: 'status', instrumentId: id, recvTime: this.localStamp(), status, detail: detail ?? null }),
    capabilities: (id, caps) => this.accept({ type: 'caps', instrumentId: id, recvTime: this.localStamp(), caps }),
  };

  /** Receive time for locally generated messages: never earlier than the last recorded one (receive order). */
  private localStamp(): number {
    const last = this.log[this.log.length - 1]?.recvTime ?? -Infinity;
    return Math.max(this.timers.now(), last);
  }

  private accept(m: FootprintMsg): void {
    if (!this.active || m.instrumentId !== this.active.id || !this.engine_) return;
    this.received += 1;
    this.lastMsgAt = this.timers.now();
    this.log.push(m);
    if (this.log.length > FP_MAX_RECORDED) this.log.splice(0, this.log.length - FP_MAX_RECORDED);
    this.engine_.process(m);
    this.schedule();
  }

  start(): () => void {
    if (!this.started) {
      this.started = true;
      this.provider?.connect(this.sink);
      if (this.provider) this.staleTimer = this.timers.setInterval(() => this.checkStale(), 1000);
    }
    this.attach(this.instruments.store.getState().activeId);
    const stop = this.instruments.store.subscribe(() => this.attach(this.instruments.store.getState().activeId));
    return () => {
      stop();
      this.detach();
      if (this.staleTimer !== null) this.timers.clearInterval(this.staleTimer);
      this.staleTimer = null;
      if (this.publishTimer !== null) this.timers.clearTimeout(this.publishTimer);
      this.publishTimer = null;
      this.provider?.disconnect();
      this.started = false;
    };
  }

  private attach(id: InstrumentId): void {
    if (this.active?.id === id) return;
    this.detach();
    const def = this.instruments.get(id);
    this.active = def ?? null;
    this.log = [];
    this.lastMsgAt = null;
    const state = this.initial(def);
    this.store.setState({ ...state, version: this.store.getState().version + 1 });
    if (!def || !state.supported) return;
    this.engine_ = new FootprintEngine({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: this.settings });
    this.publish();
    if (this.provider) {
      this.provider.subscribe(def);
      this.subscribed = true;
    }
  }

  private detach(): void {
    if (this.subscribed && this.active) this.provider?.unsubscribe(this.active.id);
    this.subscribed = false;
    this.active = null;
    this.engine_ = null;
  }

  private checkStale(): void {
    const stale = this.lastMsgAt !== null && this.timers.now() - this.lastMsgAt > FP_STALE_MS;
    if (stale !== this.store.getState().stale) this.store.setState({ stale });
  }

  private schedule(): void {
    if (this.publishTimer !== null) return;
    this.publishTimer = this.timers.setTimeout(() => {
      this.publishTimer = null;
      this.publish();
    }, FP_PUBLISH_MS);
  }

  /** Flush pending updates now (tests). */
  flush(): void {
    if (this.publishTimer !== null) this.timers.clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.publish();
  }

  private publish(): void {
    const e = this.engine_;
    if (!e) return;
    this.publishes += 1;
    const st = this.store.getState();
    this.store.setState({ snapshot: e.snapshot(), version: st.version + 1, recorded: this.log.length, stale: this.lastMsgAt !== null && this.timers.now() - this.lastMsgAt > FP_STALE_MS });
  }

  /**
   * Analysis settings changed: rebuild deterministically from the RECORDED messages. The recorded
   * evidence itself is never modified — only how it is aggregated.
   */
  setSettings(next: FootprintSettings): void {
    if (settingsKey(next) === settingsKey(this.settings)) return;
    this.settings = { ...next };
    this.store.setState({ settings: { ...next } });
    this.rebuild();
  }
  /** Re-run the engine over the recorded messages (no provider request). */
  refresh(): void {
    this.rebuild();
  }
  private rebuild(): void {
    const def = this.active;
    if (!def || !this.engine_) return;
    this.engine_ = new FootprintEngine({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: this.settings });
    this.engine_.processAll(this.log);
    this.publish();
  }

  createReplay(tf: FPTimeframe): FPReplaySession | null {
    const def = this.active;
    if (!def || !this.log.length) return null;
    return new FPReplaySession({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: { ...this.settings }, messages: Object.freeze(this.log.map((m) => Object.freeze({ ...m }))) }, tf, { verify: true });
  }
}
