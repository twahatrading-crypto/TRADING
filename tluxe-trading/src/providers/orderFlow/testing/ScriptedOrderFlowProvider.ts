/**
 * TEST DATA ONLY — a scripted order-flow provider for unit tests and the dev harness. It replays a
 * fixed message script; it is never registered in production (`info.test = true`, and the registry
 * refuses test providers). Supports simulated drops (sequence gaps), duplicates, a resync snapshot
 * built from its own script state, and a real-time mode for the harness.
 */
import { OrderBook } from '../../../engines/orderFlow/book';
import type { FeedStatus, OrderFlowCapabilities, OrderFlowMsg } from '../../../engines/orderFlow/types';
import type { InstrumentDefinition, InstrumentId } from '../../../types/instruments';
import type { OrderFlowDepthProvider, OrderFlowSink, OrderFlowTradeProvider } from '../types';

type Timers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval; now: () => number };

export class ScriptedOrderFlowProvider implements OrderFlowDepthProvider, OrderFlowTradeProvider {
  readonly info = { id: 'test-script', name: 'TEST DATA — scripted order flow', test: true };
  readonly stream = 'both' as const;
  private sink: OrderFlowSink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private active: InstrumentId | null = null;
  private readonly ref: OrderBook;
  private lastDepthSeq: number | null = null;
  /** Subscriptions made (tests assert there is exactly one). */
  subscriptions = 0;
  connects = 0;
  snapshotRequests = 0;

  constructor(
    private readonly script: readonly OrderFlowMsg[],
    private readonly caps: OrderFlowCapabilities,
    private readonly opts: { mode?: 'manual' | 'realtime'; preload?: number; timers?: Timers; tickSize?: number; drop?: Set<number>; contract?: string; initialStatus?: { depth: FeedStatus; trade: FeedStatus } } = {},
  ) {
    this.ref = new OrderBook(opts.tickSize ?? 0.1);
  }

  connect(sink: OrderFlowSink): void {
    this.sink = sink;
    this.connects += 1;
  }
  disconnect(): void {
    if (this.timer) (this.opts.timers?.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
    this.sink = null;
  }
  subscribe(instrument: InstrumentDefinition): void {
    this.subscriptions += 1;
    this.active = instrument.id;
    this.cursor = 0;
    this.sink?.capabilities(instrument.id, this.caps);
    this.sink?.contract(instrument.id, this.opts.contract ?? 'TEST');
    this.sink?.status(instrument.id, 'depth', this.opts.initialStatus?.depth ?? 'LIVE');
    this.sink?.status(instrument.id, 'trade', this.opts.initialStatus?.trade ?? 'LIVE');
    if (this.opts.mode === 'realtime') {
      const t = this.opts.timers ?? { setInterval: (...a: Parameters<typeof setInterval>) => setInterval(...a), clearInterval: (x: ReturnType<typeof setInterval>) => clearInterval(x), now: () => Date.now() };
      const start = t.now();
      // Preload: the first `preload` messages are emitted at once, shifted so they end "now".
      const pre = Math.min(this.opts.preload ?? 0, this.script.length);
      const t0 = pre > 0 ? this.script[pre - 1]!.exchTime : (this.script[0]?.exchTime ?? 0);
      for (let i = 0; i < pre; i++) this.emitAt(i, start - t0);
      this.timer = t.setInterval(() => {
        const elapsed = t.now() - start;
        while (this.cursor < this.script.length && this.script[this.cursor]!.exchTime - t0 <= elapsed) this.emitAt(this.cursor, start - t0);
      }, 50);
    }
  }
  unsubscribe(): void {
    if (this.timer) (this.opts.timers?.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
    this.active = null;
  }

  private emitAt(i: number, shift = 0): void {
    const m = this.script[i]!;
    this.cursor = i + 1;
    const out = shift ? { ...m, exchTime: m.exchTime + shift, recvTime: m.recvTime + shift } : m;
    if (m.type === 'snapshot') this.ref.load(m.bids, m.asks);
    if (m.type === 'depth') this.ref.set(m.side, this.ref.tick(m.price), m.action === 'delete' ? 0 : m.size);
    if (m.type === 'snapshot' || m.type === 'depth') this.lastDepthSeq = m.seq;
    if (this.opts.drop?.has(i)) return; // simulated loss: the provider state moved, the client never saw it
    this.sink?.message(out);
  }

  /** Manual mode: emit the next n messages. */
  emit(n = 1): void {
    for (let k = 0; k < n && this.cursor < this.script.length; k++) this.emitAt(this.cursor);
  }
  emitAll(): void {
    this.emit(this.script.length);
  }
  /** Re-send a message already emitted (duplicate delivery). */
  duplicate(i: number): void {
    this.sink?.message(this.script[i]!);
  }
  setStatus(stream: 'depth' | 'trade', status: FeedStatus, detail?: string): void {
    if (this.active) this.sink?.status(this.active, stream, status, detail ?? null);
  }

  requestSnapshot(instrumentId: InstrumentId): void {
    this.snapshotRequests += 1;
    if (!this.caps.snapshotOnDemand) return;
    const last = this.script[Math.max(0, this.cursor - 1)];
    const v = this.ref.view(true);
    const t = last?.exchTime ?? 0;
    this.sink?.message({ type: 'snapshot', instrumentId, seq: this.lastDepthSeq, exchTime: t, recvTime: t + 1, bids: v.bids, asks: v.asks });
  }
}
