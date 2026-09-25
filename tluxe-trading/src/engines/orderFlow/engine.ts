import type { InstrumentId } from '../../types/instruments';
import { OrderBook } from './book';
import { DEFAULT_ORDER_FLOW_SETTINGS, type OrderFlowEngineSettings } from './config';
import { EventDetectors } from './events';
import type {
  Aggressor,
  CvdAvailability,
  DepthSnapshotMsg,
  DepthUpdateMsg,
  OrderBookView,
  OrderFlowCapabilities,
  OrderFlowEvent,
  OrderFlowMsg,
  StreamIntegrity,
  TradeMsg,
  VolumeAtPrice,
} from './types';

/* ============================================================================
 * ORDER-FLOW ENGINE — deterministic: the same message stream + settings always gives the same
 * book, heatmap, volume, CVD and events (live, incremental or replay). No wall clock inside.
 *
 * Integrity (per stream, sequenced providers):
 *   depth  a snapshot makes the book valid; seq = last + 1 is applied; seq ≤ last is a duplicate /
 *          out-of-order message and is dropped (counted); seq > last + 1 is a GAP → the book is
 *          marked unreliable (SEQUENCE_GAP), updates are buffered, a resync snapshot is required;
 *          when it arrives the buffered updates newer than it are applied in order and the book is
 *          valid again. Without a valid book nothing depth-based is drawn or detected.
 *   trade  duplicates / out-of-order prints are dropped; a gap is counted and makes CVD / volume
 *          PARTIAL (missing prints are never invented).
 *
 * Heatmap: fixed time columns (timeAggregationMs). A column stores the displayed book at its close.
 * Across a silence longer than maxCarryMs (no message on any stream, heartbeats included) the book
 * is NOT carried forward: those columns are NO DATA. Columns while the book is invalid are NO DATA.
 * Rolling history: at most maxColumns columns.
 * ========================================================================== */

export interface TradeCell {
  tick: number;
  buy: number;
  sell: number;
  unknown: number;
}
export interface HeatmapColumn {
  t: number;
  valid: boolean;
  bidTicks: Int32Array;
  bidSizes: Float64Array;
  askTicks: Int32Array;
  askSizes: Float64Array;
  bestBid: number | null;
  bestAsk: number | null;
  /** Last trade tick in or before this column (price line). */
  lastTick: number | null;
  trades: TradeCell[];
  buy: number;
  sell: number;
  unknown: number;
  /** Session CVD at the column close (classified volume only). */
  cvd: number;
}

export interface OrderFlowTotals {
  sessionStart: number | null;
  buy: number;
  sell: number;
  unknown: number;
  total: number;
  cvd: number;
  trades: number;
}

export interface OrderFlowEngineOptions {
  instrumentId: InstrumentId;
  tickSize: number;
  capabilities: OrderFlowCapabilities;
  settings?: OrderFlowEngineSettings;
}

const EMPTY_I = new Int32Array(0);
const EMPTY_F = new Float64Array(0);

const newIntegrity = (): StreamIntegrity => ({ state: 'NO_DATA', lastSeq: null, lastExchTime: null, lastRecvTime: null, duplicates: 0, outOfOrder: 0, gaps: 0, buffered: 0, snapshots: 0, lastSnapshotExchTime: null, lastGapAt: null, latencyMs: null });

/** CME Globex session start (17:00 America/Chicago) for the session containing t (ms). */
export function cmeSessionStart(t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(t);
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  const sinceMidnight = (g('hour') * 3600 + g('minute') * 60 + g('second')) * 1000 + (t % 1000);
  const since17 = sinceMidnight - 17 * 3600 * 1000;
  return t - (since17 >= 0 ? since17 : since17 + 24 * 3600 * 1000);
}

export class OrderFlowEngine {
  readonly instrumentId: InstrumentId;
  readonly settings: OrderFlowEngineSettings;
  readonly capabilities: OrderFlowCapabilities;
  readonly book: OrderBook;
  readonly depth: StreamIntegrity = newIntegrity();
  readonly trade: StreamIntegrity = newIntegrity();
  readonly columns: HeatmapColumn[] = [];
  private detectors: EventDetectors;
  private buffer: DepthUpdateMsg[] = [];
  private cur: HeatmapColumn | null = null;
  private curInvalid = false;
  private lastMsgTime: number | null = null;
  private profile = new Map<number, TradeCell>();
  private totals: OrderFlowTotals = { sessionStart: null, buy: 0, sell: 0, unknown: 0, total: 0, cvd: 0, trades: 0 };
  private lastTradeTick: number | null = null;
  private lastTrade: { price: number; size: number; aggressor: Aggressor; time: number } | null = null;
  /** Increments on every accepted message (cheap "dirty" check for batched rendering). */
  version = 0;

  constructor(o: OrderFlowEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.settings = o.settings ?? { ...DEFAULT_ORDER_FLOW_SETTINGS };
    this.capabilities = o.capabilities;
    this.book = new OrderBook(o.tickSize);
    const book = this.book;
    this.detectors = new EventDetectors(this.settings, this.capabilities, {
      price: (t) => String(book.price(t)),
      priceNum: (t) => book.price(t),
      size: (s, t) => book.size(s, t),
      bestBid: () => book.bestBidTick(),
      bestAsk: () => book.bestAskTick(),
    });
  }

  /** The book is trustworthy (valid snapshot, no open gap). */
  get bookValid(): boolean {
    return this.depth.state === 'READY';
  }
  /** A resync snapshot is required (gap or no snapshot yet while updates arrive). */
  get needsSnapshot(): boolean {
    return this.depth.state === 'SEQUENCE_GAP' || this.depth.state === 'AWAITING_SNAPSHOT';
  }

  processAll(msgs: readonly OrderFlowMsg[]): void {
    for (const m of msgs) this.process(m);
  }

  process(m: OrderFlowMsg): void {
    if (m.instrumentId !== this.instrumentId) return;
    const stream = m.type === 'trade' ? this.trade : m.type === 'heartbeat' ? (m.stream === 'trade' ? this.trade : this.depth) : this.depth;
    // Duplicate / out-of-order (per stream). Snapshots are checked in applySnapshot.
    if (m.type !== 'snapshot' && m.type !== 'heartbeat' && m.seq !== null && stream.lastSeq !== null && m.seq <= stream.lastSeq && !(m.type === 'depth' && this.needsSnapshot)) {
      if (m.seq === stream.lastSeq) stream.duplicates += 1;
      else stream.outOfOrder += 1;
      return;
    }
    this.clock(m.exchTime);
    stream.lastRecvTime = m.recvTime;
    stream.latencyMs = m.recvTime - m.exchTime;
    this.version += 1;
    if (m.type === 'heartbeat') {
      stream.lastExchTime = m.exchTime;
      return;
    }
    if (m.type === 'snapshot') this.applySnapshot(m);
    else if (m.type === 'depth') this.applyDepth(m);
    else this.applyTrade(m);
  }

  /* ------------------------------- depth ------------------------------- */

  private applySnapshot(m: DepthSnapshotMsg): void {
    const d = this.depth;
    if (m.seq !== null && d.lastSeq !== null && d.state === 'READY' && m.seq < d.lastSeq) {
      d.outOfOrder += 1; // a stale snapshot never replaces a newer consistent book
      return;
    }
    this.book.load(m.bids, m.asks);
    d.state = 'READY';
    d.lastSeq = m.seq;
    d.lastExchTime = m.exchTime;
    d.snapshots += 1;
    d.lastSnapshotExchTime = m.exchTime;
    // Replay the updates held during the resync that are newer than the snapshot, in sequence order.
    const held = this.buffer.filter((u) => u.seq === null || m.seq === null || u.seq > m.seq).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    this.buffer = [];
    d.buffered = 0;
    for (const u of held) this.applyDepth(u);
  }

  private applyDepth(m: DepthUpdateMsg): void {
    const d = this.depth;
    if (d.state !== 'READY') {
      if (d.state === 'NO_DATA') d.state = 'AWAITING_SNAPSHOT';
      this.hold(m);
      return;
    }
    if (m.seq !== null && d.lastSeq !== null && this.capabilities.sequenced) {
      if (m.seq <= d.lastSeq) {
        if (m.seq === d.lastSeq) d.duplicates += 1;
        else d.outOfOrder += 1;
        return;
      }
      if (m.seq > d.lastSeq + 1) {
        d.state = 'SEQUENCE_GAP';
        d.gaps += 1;
        d.lastGapAt = m.exchTime;
        this.curInvalid = true;
        this.hold(m);
        return;
      }
    }
    d.lastSeq = m.seq ?? d.lastSeq;
    d.lastExchTime = m.exchTime;
    const tick = this.book.tick(m.price);
    const size = m.action === 'delete' ? 0 : Math.max(0, m.size);
    const prev = this.book.set(m.side, tick, size);
    this.detectors.onDepth(m.exchTime, m.side, tick, prev, size, m.action, m.seq);
  }

  private hold(m: DepthUpdateMsg): void {
    this.curInvalid = true;
    if (this.buffer.length >= this.settings.maxResyncBuffer) this.buffer.shift();
    this.buffer.push(m);
    this.depth.buffered = this.buffer.length;
  }

  /* ------------------------------- trades ------------------------------ */

  private applyTrade(m: TradeMsg): void {
    const tr = this.trade;
    if (m.seq !== null && tr.lastSeq !== null && m.seq > tr.lastSeq + 1) {
      tr.gaps += 1;
      tr.lastGapAt = m.exchTime;
    }
    tr.state = 'READY';
    tr.lastSeq = m.seq ?? tr.lastSeq;
    tr.lastExchTime = m.exchTime;
    const ss = cmeSessionStart(m.exchTime);
    if (this.totals.sessionStart !== ss) {
      this.totals = { sessionStart: ss, buy: 0, sell: 0, unknown: 0, total: 0, cvd: 0, trades: 0 };
      this.profile = new Map();
    }
    const tick = this.book.tick(m.price);
    const size = Math.max(0, m.size);
    // Aggressor exactly as supplied; a provider without aggressor side yields UNKNOWN only.
    const agg: Aggressor = this.capabilities.aggressorSide ? m.aggressor : 'UNKNOWN';
    const add = (c: { buy: number; sell: number; unknown: number }) => {
      if (agg === 'BUY') c.buy += size;
      else if (agg === 'SELL') c.sell += size;
      else c.unknown += size;
    };
    add(this.totals);
    this.totals.total += size;
    this.totals.trades += 1;
    this.totals.cvd = this.totals.buy - this.totals.sell; // CVD += buy − sell; UNKNOWN never enters
    let cell = this.profile.get(tick);
    if (!cell) this.profile.set(tick, (cell = { tick, buy: 0, sell: 0, unknown: 0 }));
    add(cell);
    if (this.cur) {
      let tc = this.cur.trades.find((x) => x.tick === tick);
      if (!tc) this.cur.trades.push((tc = { tick, buy: 0, sell: 0, unknown: 0 }));
      add(tc);
      add(this.cur);
    }
    this.lastTradeTick = tick;
    this.lastTrade = { price: this.book.price(tick), size, aggressor: agg, time: m.exchTime };
    this.detectors.onTrade(m.exchTime, tick, size, agg, m.seq);
  }

  /* ------------------------------ columns ------------------------------ */

  private blank(t: number): HeatmapColumn {
    return { t, valid: false, bidTicks: EMPTY_I, bidSizes: EMPTY_F, askTicks: EMPTY_I, askSizes: EMPTY_F, bestBid: null, bestAsk: null, lastTick: this.lastTradeTick, trades: [], buy: 0, sell: 0, unknown: 0, cvd: this.totals.cvd };
  }

  private close(c: HeatmapColumn, valid: boolean): void {
    c.valid = valid;
    if (valid) {
      const b = this.book.compact('bid');
      const a = this.book.compact('ask');
      c.bidTicks = b.ticks;
      c.bidSizes = b.sizes;
      c.askTicks = a.ticks;
      c.askSizes = a.sizes;
      c.bestBid = this.book.bestBidTick();
      c.bestAsk = this.book.bestAskTick();
    }
    c.lastTick = this.lastTradeTick;
    c.cvd = this.totals.cvd;
    this.columns.push(c);
    if (this.columns.length > this.settings.maxColumns) this.columns.splice(0, this.columns.length - this.settings.maxColumns);
  }

  /** Advance the column clock to exchange time t (deterministic; never the wall clock). */
  private clock(t: number): void {
    const agg = this.settings.timeAggregationMs;
    const b = Math.floor(t / agg) * agg;
    const silentTooLong = this.lastMsgTime !== null && t - this.lastMsgTime > this.settings.maxCarryMs;
    if (!this.cur) {
      this.cur = this.blank(b);
      this.curInvalid = !this.bookValid;
    } else if (b > this.cur.t) {
      this.close(this.cur, this.bookValid && !this.curInvalid);
      // Empty buckets: carry the book only across a short, observed silence; otherwise NO DATA.
      for (let x = this.cur.t + agg; x < b; x += agg) this.close(this.blank(x), this.bookValid && !silentTooLong);
      this.cur = this.blank(b);
      this.curInvalid = !this.bookValid || silentTooLong;
    }
    if (this.lastMsgTime === null || t > this.lastMsgTime) this.lastMsgTime = t;
    this.detectors.advance(t);
  }

  /* ------------------------------- views ------------------------------- */

  bookView(levels?: number): OrderBookView {
    return this.book.view(this.bookValid, levels);
  }
  /** Closed columns plus the open one (drawn as the current edge). */
  allColumns(): readonly HeatmapColumn[] {
    if (!this.cur) return this.columns;
    const open: HeatmapColumn = { ...this.cur, valid: this.bookValid && !this.curInvalid, lastTick: this.lastTradeTick, cvd: this.totals.cvd };
    if (open.valid) {
      const b = this.book.compact('bid');
      const a = this.book.compact('ask');
      Object.assign(open, { bidTicks: b.ticks, bidSizes: b.sizes, askTicks: a.ticks, askSizes: a.sizes, bestBid: this.book.bestBidTick(), bestAsk: this.book.bestAskTick() });
    }
    return [...this.columns, open];
  }
  events(): readonly OrderFlowEvent[] {
    return this.detectors.events;
  }
  limitations(): readonly string[] {
    return this.detectors.limitations;
  }
  sessionTotals(): OrderFlowTotals {
    return { ...this.totals };
  }
  lastTradeInfo() {
    return this.lastTrade;
  }
  /** Session volume profile (executed volume at each price; UNKNOWN kept apart). */
  sessionProfile(): VolumeAtPrice[] {
    return [...this.profile.values()].sort((a, b) => b.tick - a.tick).map((c) => ({ price: this.book.price(c.tick), buy: c.buy, sell: c.sell, unknown: c.unknown }));
  }
  /** CVD availability: needs exchange aggressor side; unknown volume or trade gaps make it PARTIAL. */
  cvdAvailability(): CvdAvailability {
    if (!this.capabilities.trades || !this.capabilities.aggressorSide) return 'UNAVAILABLE';
    return this.totals.unknown > 0 || this.trade.gaps > 0 ? 'PARTIAL' : 'FULL';
  }

  /** Plain, serialisable digest of everything the engine decided (parity / tests). */
  digest(): string {
    const cols = this.allColumns().map((c) => [c.t, c.valid, [...c.bidTicks], [...c.bidSizes], [...c.askTicks], [...c.askSizes], c.bestBid, c.bestAsk, c.lastTick, c.trades, c.buy, c.sell, c.unknown, c.cvd]);
    return JSON.stringify({ book: this.bookView(), depth: this.depth, trade: this.trade, cols, events: this.events(), totals: this.totals, profile: this.sessionProfile() });
  }
}

/** Visible-range profile from heatmap columns (UI-time; pure). */
export function rangeProfile(cols: readonly HeatmapColumn[], from: number, to: number, price: (tick: number) => number): VolumeAtPrice[] {
  const m = new Map<number, TradeCell>();
  for (const c of cols) {
    if (c.t < from || c.t > to) continue;
    for (const t of c.trades) {
      let x = m.get(t.tick);
      if (!x) m.set(t.tick, (x = { tick: t.tick, buy: 0, sell: 0, unknown: 0 }));
      x.buy += t.buy;
      x.sell += t.sell;
      x.unknown += t.unknown;
    }
  }
  return [...m.values()].sort((a, b) => b.tick - a.tick).map((c) => ({ price: price(c.tick), buy: c.buy, sell: c.sell, unknown: c.unknown }));
}
