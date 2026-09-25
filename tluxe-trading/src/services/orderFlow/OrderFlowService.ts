import { tickSizeOf } from '../../config/instruments';
import { DEFAULT_ORDER_FLOW_SETTINGS, type OrderFlowEngineSettings } from '../../engines/orderFlow/config';
import { OrderFlowEngine, type OrderFlowTotals } from '../../engines/orderFlow/engine';
import { OrderFlowRecorder, OrderFlowReplay } from '../../engines/orderFlow/replay';
import {
  NO_CAPABILITIES,
  type CvdAvailability,
  type FeedStatus,
  type OrderBookView,
  type OrderFlowCapabilities,
  type OrderFlowEvent,
  type OrderFlowMsg,
  type OrderFlowStream,
  type StreamIntegrity,
  type VolumeAtPrice,
} from '../../engines/orderFlow/types';
import type { OrderFlowProviders, OrderFlowSink } from '../../providers/orderFlow/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now: () => number };

/** Depth / trade stream silent for longer than this (no update, no heartbeat) → STALE. */
export const ORDER_FLOW_STALE_MS = 5000;
/** A trade sequence gap keeps the trade stream flagged for this long. */
export const TRADE_GAP_FLAG_MS = 30_000;
/** Store updates are batched: at most one React-visible update per interval, never one per message. */
export const PUBLISH_MS = 150;

export interface StreamView {
  status: FeedStatus;
  detail: string | null;
  provider: string | null;
  integrity: StreamIntegrity | null;
  /** Wall-clock age of the last message on this stream (ms). */
  ageMs: number | null;
}

export interface OrderFlowState {
  instrumentId: InstrumentId;
  /** False when the instrument has no exchange Level-2 (spot / CFD / crypto proxies). */
  supported: boolean;
  reason: string | null;
  contract: string | null;
  capabilities: OrderFlowCapabilities;
  depth: StreamView;
  trade: StreamView;
  snapshotAgeMs: number | null;
  latencyMs: number | null;
  exchTime: number | null;
  book: OrderBookView | null;
  totals: OrderFlowTotals | null;
  cvd: CvdAvailability;
  profile: VolumeAtPrice[];
  events: OrderFlowEvent[];
  limitations: string[];
  lastTrade: { price: number; size: number; aggressor: string; time: number } | null;
  version: number;
  settings: OrderFlowEngineSettings;
}

const supportedReason = (def: InstrumentDefinition | undefined): string | null => {
  if (!def) return 'Unknown instrument.';
  if (def.kind !== 'future') return `${def.shortName} is not an exchange-traded future. A true liquidity heatmap needs exchange Level-2 depth (e.g. GC — COMEX Gold Futures). ${def.shortName} spot / CFD prices are a different instrument and feed.`;
  if (!def.providerMappings.some((m) => m.role === 'depth')) return `${def.shortName} has no Level-2 depth mapping.`;
  return null;
};

/**
 * Order Flow runtime (outside React): providers → normalized messages → integrity → order book →
 * rolling heatmap → events. One engine for the active instrument; providers are connected ONCE
 * (connectServices / main.tsx), so page switches and HMR never add subscriptions or timers.
 */
export class OrderFlowService {
  readonly store: Store<OrderFlowState>;
  private engine_: OrderFlowEngine | null = null;
  private recorder = new OrderFlowRecorder();
  private active: InstrumentDefinition | null = null;
  private caps: OrderFlowCapabilities = NO_CAPABILITIES;
  private provStatus: Record<OrderFlowStream, { status: FeedStatus; detail: string | null }> = { depth: { status: 'CONNECTING', detail: null }, trade: { status: 'CONNECTING', detail: null } };
  private lastRecv: Record<OrderFlowStream, number | null> = { depth: null, trade: null };
  private tradeGapSeenAt: number | null = null;
  private tradeGaps = 0;
  private snapshotAt: number | null = null;
  private resyncPending = false;
  private contract: string | null = null;
  private settings: OrderFlowEngineSettings = { ...DEFAULT_ORDER_FLOW_SETTINGS };
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** The active instrument was subscribed (unsupported instruments never are). */
  private subscribed = false;
  private readonly timers: Timers;
  /** Messages accepted from providers (tests / diagnostics). */
  received = 0;

  constructor(
    private readonly instruments: InstrumentSelection,
    private readonly providers: OrderFlowProviders,
    opts: { timers?: Timers } = {},
  ) {
    this.timers = opts.timers ?? { setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t), setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
    this.store = createStore<OrderFlowState>(this.compute(this.instruments.store.getState().activeId));
  }

  /** The live engine (read by the canvas renderer directly — no React render per update). */
  engine(): OrderFlowEngine | null {
    return this.engine_;
  }
  recording(): readonly OrderFlowMsg[] {
    return this.recorder.messages();
  }

  private sink: OrderFlowSink = {
    message: (m) => {
      if (!this.active || m.instrumentId !== this.active.id || !this.engine_) return;
      const stream: OrderFlowStream = m.type === 'trade' || (m.type === 'heartbeat' && m.stream === 'trade') ? 'trade' : 'depth';
      // A stream is accepted only from a connected provider that declares it (never a book from a trades-only feed).
      if (stream === 'depth' && (!this.providers.depth || this.caps.depth === 'NONE')) return;
      if (stream === 'trade' && (!this.providers.trade || !this.caps.trades)) return;
      this.received += 1;
      this.lastRecv[stream] = this.timers.now();
      if (m.type === 'snapshot') this.snapshotAt = this.timers.now();
      const gapsBefore = this.engine_.trade.gaps;
      this.recorder.record(m);
      this.engine_.process(m);
      if (this.engine_.trade.gaps > gapsBefore) this.tradeGapSeenAt = this.timers.now();
      this.tradeGaps = this.engine_.trade.gaps;
      this.maybeResync();
      this.schedule();
    },
    status: (id, stream, status, detail) => {
      if (id !== this.active?.id) return;
      this.provStatus[stream] = { status, detail: detail ?? null };
      // A disconnect invalidates the book: after reconnect a fresh snapshot is required.
      if (stream === 'depth' && (status === 'DISCONNECTED' || status === 'CONNECTING') && this.engine_?.bookValid) this.resetBook();
      this.schedule();
    },
    capabilities: (id, caps) => {
      if (id !== this.active?.id) return;
      this.caps = caps;
      this.newEngine();
      this.schedule();
    },
    contract: (id, c) => {
      if (id !== this.active?.id) return;
      this.contract = c;
      this.schedule();
    },
  };

  /** Book cannot be trusted any more (disconnect): start a new engine; history is kept in the recording. */
  private resetBook(): void {
    this.newEngine();
  }

  private newEngine(): void {
    if (!this.active) return;
    this.engine_ = new OrderFlowEngine({ instrumentId: this.active.id, tickSize: tickSizeOf(this.active), capabilities: this.caps, settings: this.settings });
    this.recorder.clear();
    this.resyncPending = false;
  }

  private maybeResync(): void {
    const e = this.engine_;
    if (!e || !this.active) return;
    if (e.bookValid) {
      this.resyncPending = false;
      return;
    }
    if (e.needsSnapshot && !this.resyncPending && this.providers.depth && this.caps.snapshotOnDemand) {
      this.resyncPending = true;
      this.providers.depth.requestSnapshot(this.active.id);
    }
  }

  start(): () => void {
    if (this.started) return () => this.stop();
    this.started = true;
    const set = new Set([this.providers.depth, this.providers.trade].filter((p): p is NonNullable<typeof p> => !!p));
    for (const p of set) p.connect(this.sink);
    this.attach(this.instruments.store.getState().activeId);
    const unsub = this.instruments.store.subscribe(() => this.attach(this.instruments.store.getState().activeId));
    this.statusTimer = this.timers.setInterval(() => this.publish(), 1000);
    this.stopFns = [unsub];
    return () => this.stop();
  }
  private stopFns: (() => void)[] = [];

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopFns.forEach((f) => f());
    this.stopFns = [];
    this.detach();
    const set = new Set([this.providers.depth, this.providers.trade].filter((p): p is NonNullable<typeof p> => !!p));
    for (const p of set) p.disconnect();
    if (this.statusTimer) this.timers.clearInterval(this.statusTimer);
    if (this.publishTimer) this.timers.clearTimeout(this.publishTimer);
    this.statusTimer = null;
    this.publishTimer = null;
  }

  private attach(id: InstrumentId): void {
    if (this.active?.id === id) return;
    this.detach();
    const def = this.instruments.get(id);
    this.active = def ?? null;
    this.caps = NO_CAPABILITIES;
    this.provStatus = { depth: { status: 'CONNECTING', detail: null }, trade: { status: 'CONNECTING', detail: null } };
    this.lastRecv = { depth: null, trade: null };
    this.tradeGapSeenAt = null;
    this.snapshotAt = null;
    this.contract = null;
    this.engine_ = null;
    this.recorder.clear();
    if (def && !supportedReason(def)) {
      this.newEngine();
      const set = new Set([this.providers.depth, this.providers.trade].filter((p): p is NonNullable<typeof p> => !!p));
      for (const p of set) p.subscribe(def);
      this.subscribed = true;
    }
    this.publish();
  }

  private detach(): void {
    if (!this.active) return;
    if (this.subscribed) {
      const set = new Set([this.providers.depth, this.providers.trade].filter((p): p is NonNullable<typeof p> => !!p));
      for (const p of set) p.unsubscribe(this.active.id);
    }
    this.subscribed = false;
    this.active = null;
  }

  /** Engine settings change → deterministic rebuild from the recording (same data + settings = same result). */
  setEngineSettings(patch: Partial<OrderFlowEngineSettings>): void {
    this.settings = { ...this.settings, ...patch };
    if (!this.active || !this.engine_) return this.publish();
    const msgs = [...this.recorder.messages()];
    this.engine_ = new OrderFlowEngine({ instrumentId: this.active.id, tickSize: tickSizeOf(this.active), capabilities: this.caps, settings: this.settings });
    this.engine_.processAll(msgs);
    this.publish();
  }
  engineSettings(): OrderFlowEngineSettings {
    return this.settings;
  }

  /** Replay of what was recorded (fresh engine, same messages, same order). */
  createReplay(): OrderFlowReplay | null {
    if (!this.active || !this.recorder.messages().length) return null;
    return new OrderFlowReplay([...this.recorder.messages()], { instrumentId: this.active.id, tickSize: tickSizeOf(this.active), capabilities: this.caps, settings: this.settings });
  }

  private schedule(): void {
    if (this.publishTimer) return;
    this.publishTimer = this.timers.setTimeout(() => {
      this.publishTimer = null;
      this.publish();
    }, PUBLISH_MS);
  }

  /** Force a store update now (tests / status timer). */
  publish(): void {
    this.store.setState(this.compute(this.active?.id ?? this.instruments.store.getState().activeId));
  }

  private streamStatus(stream: OrderFlowStream): { status: FeedStatus; detail: string | null } {
    const now = this.timers.now();
    const def = this.active;
    const reason = supportedReason(def ?? undefined);
    if (reason) return { status: 'DATA_UNAVAILABLE', detail: reason };
    const provider = stream === 'depth' ? this.providers.depth : this.providers.trade;
    if (!provider) return { status: 'DATA_UNAVAILABLE', detail: stream === 'depth' ? 'LEVEL-2 PROVIDER NOT CONNECTED' : 'TRADE (TIME & SALES) PROVIDER NOT CONNECTED' };
    const p = this.provStatus[stream];
    if (stream === 'depth' && this.caps !== NO_CAPABILITIES && this.caps.depth === 'NONE') return { status: 'DATA_UNAVAILABLE', detail: 'The connected provider has no Level-2 depth.' };
    if (stream === 'trade' && this.caps !== NO_CAPABILITIES && !this.caps.trades) return { status: 'DATA_UNAVAILABLE', detail: 'The connected provider has no trade prints.' };
    if (p.status !== 'LIVE') return p;
    const e = this.engine_;
    if (stream === 'depth') {
      if (!e || e.depth.state === 'NO_DATA') return { status: 'CONNECTING', detail: 'Waiting for the first depth snapshot.' };
      if (e.depth.state === 'SEQUENCE_GAP' || e.depth.state === 'AWAITING_SNAPSHOT')
        return this.resyncPending ? { status: 'RESYNCING', detail: 'Sequence gap — rebuilding the book from a fresh snapshot.' } : { status: 'SEQUENCE_GAP', detail: this.caps.snapshotOnDemand ? 'Sequence gap — requesting a snapshot.' : 'Sequence gap — waiting for the provider to resend a snapshot.' };
    } else {
      if (!e || e.trade.state === 'NO_DATA') return { status: 'CONNECTING', detail: 'Waiting for the first print.' };
      if (this.tradeGapSeenAt !== null && now - this.tradeGapSeenAt < TRADE_GAP_FLAG_MS) return { status: 'SEQUENCE_GAP', detail: `Trade sequence gap — ${this.tradeGaps} gap(s); missing prints are never invented (CVD / volume PARTIAL).` };
    }
    const last = this.lastRecv[stream];
    if (last === null || now - last > ORDER_FLOW_STALE_MS) return { status: 'STALE', detail: `No ${stream} message for ${last === null ? '—' : Math.round((now - last) / 1000)} s.` };
    return { status: 'LIVE', detail: null };
  }

  private compute(id: InstrumentId): OrderFlowState {
    const def = this.instruments.get(id);
    const now = this.timers.now();
    const e = this.engine_;
    const reason = supportedReason(def);
    const d = this.streamStatus('depth');
    const t = this.streamStatus('trade');
    return {
      instrumentId: id,
      supported: !reason,
      reason,
      contract: this.contract,
      capabilities: this.caps,
      depth: { ...d, provider: this.providers.depth?.info.name ?? null, integrity: e ? { ...e.depth } : null, ageMs: this.lastRecv.depth === null ? null : now - this.lastRecv.depth },
      trade: { ...t, provider: this.providers.trade?.info.name ?? null, integrity: e ? { ...e.trade } : null, ageMs: this.lastRecv.trade === null ? null : now - this.lastRecv.trade },
      snapshotAgeMs: this.snapshotAt === null ? null : now - this.snapshotAt,
      latencyMs: e ? (e.depth.latencyMs ?? e.trade.latencyMs) : null,
      exchTime: e ? Math.max(e.depth.lastExchTime ?? 0, e.trade.lastExchTime ?? 0) || null : null,
      // Depth-derived views exist only for a valid book (never invented while unavailable / resyncing).
      book: e && e.bookValid ? e.bookView(20) : null,
      totals: e && e.trade.state !== 'NO_DATA' ? e.sessionTotals() : null,
      cvd: e ? e.cvdAvailability() : 'UNAVAILABLE',
      profile: e ? e.sessionProfile() : [],
      events: e ? [...e.events()].slice(-200).reverse() : [],
      limitations: e ? [...e.limitations()] : [],
      lastTrade: e ? e.lastTradeInfo() : null,
      version: e?.version ?? 0,
      settings: this.settings,
    };
  }
}
