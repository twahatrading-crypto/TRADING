import type { FootprintCapabilities, FootprintMsg, FPFeedStatus } from '../../engines/volumeFootprint/types';
import type { FeedStatus, OrderFlowCapabilities } from '../../engines/orderFlow/types';
import type { MarketDataProvider, MarketDataSink } from '../../services/market/MarketDataProvider';
import type { DataCapability, InstrumentDefinition, InstrumentId, ProviderMapping } from '../../types/instruments';
import type { Candle, ConnectionState, FeedStatusCode, ProviderFeedDetail, Timeframe } from '../../types/market';
import type { FootprintSink, FootprintTradeProvider } from '../footprint/types';
import type { OrderFlowDepthProvider, OrderFlowSink, OrderFlowTradeProvider } from '../orderFlow/types';
import type { DatabentoFeed, DbFeedEvent } from './DatabentoFeed';
import { DB_ROOTS, nsToMs, type DbBar, type DbInstrumentStatus, type DbRoot, type DbTrade } from './protocol';

/*
 * Thin adapters: the SAME normalized Databento feed (one bridge connection) exposed through the existing TLUXE
 * provider interfaces - nothing about the engines changes:
 *   DatabentoMarketProvider     -> MarketDataService   (GC / SI quotes + real ohlcv-1m candles -> Volume Profile, charts)
 *   DatabentoOrderFlowProvider  -> OrderFlowService    (trades -> Liquidity Heatmap prints; MBO price levels ONLY in
 *                                                       'mbo' mode - CME Globex MDP 3.0 Standard has no MBO / MBP-10,
 *                                                       so by default this is a TRADE-ONLY provider and depth comes
 *                                                       from a separate Level-2 provider, see providers/level2)
 *   DatabentoFootprintProvider  -> VolumeFootprintService (exchange trades with source aggressor side -> Footprint)
 * Every record carries the ACTUAL contract; a contract change resets the consumer's contract state.
 */

const isRoot = (id: string): id is DbRoot => (DB_ROOTS as readonly string[]).includes(id);
const DB_INFO = { id: 'databento', name: 'Databento · GLBX.MDP3', declaredDelaySec: null, test: false } as const;

/* ------------------------------------------------------------------ market ------------------------------------------------------------------ */

const toCandle = (b: DbBar, id: InstrumentId, tf: Timeframe, contract: string | null): Candle => ({
  time: b.time,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume > 0 ? b.volume : null,
  tickVolume: null,
  realVolume: null,
  instrumentId: id,
  providerSymbol: contract ?? undefined,
  timeframe: tf,
  source: 'databento',
  isClosed: b.isClosed,
});

interface MarketSub {
  root: DbRoot;
  off: () => void;
  tfs: Set<Timeframe>;
  contract: string | null;
  lastRefresh: number;
  statusKey: string;
  lastQuoteAt: number | null;
  lastCandleAt: number | null;
}

export class DatabentoMarketProvider implements MarketDataProvider {
  readonly family = 'futures-feed' as const;
  readonly info = DB_INFO;
  private sink: MarketDataSink | null = null;
  private subs = new Map<InstrumentId, MarketSub>();

  constructor(
    private readonly feed: DatabentoFeed,
    private readonly now: () => number = () => Date.now(),
  ) {}

  connect(sink: MarketDataSink): void {
    this.sink = sink;
  }
  disconnect(): void {
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
    this.sink = null;
  }
  subscribe(def: InstrumentDefinition, _mapping: ProviderMapping): void {
    const sink = this.sink;
    if (!sink || this.subs.has(def.id)) return;
    if (!isRoot(def.id)) {
      sink.connection(def.id, 'UNAVAILABLE', 'Databento supplies GC and SI (COMEX futures) only.');
      return;
    }
    const root = def.id;
    sink.connection(def.id, 'CONNECTING');
    sink.capabilities(def.id, ['quote', 'ohlcv', 'trades', 'historicalCandles'] as DataCapability[]);
    const sub: MarketSub = { root, off: () => {}, tfs: new Set(), contract: null, lastRefresh: 0, statusKey: '', lastQuoteAt: null, lastCandleAt: null };
    this.subs.set(def.id, sub);
    sub.off = this.feed.subscribe(root, (e) => this.onEvent(def.id, sub, e));
  }
  unsubscribe(id: InstrumentId): void {
    const s = this.subs.get(id);
    if (!s) return;
    s.off();
    this.subs.delete(id);
  }
  requestCandles(id: InstrumentId, tf: Timeframe): void {
    const s = this.subs.get(id);
    if (!s) return;
    s.tfs.add(tf);
    void this.load(id, s, tf);
  }

  private async load(id: InstrumentId, s: MarketSub, tf: Timeframe): Promise<void> {
    try {
      const res = await this.feed.api.candles(s.root, tf);
      if (this.subs.get(id) !== s || !this.sink) return;
      s.contract = res.contract ?? s.contract;
      this.sink.candles(id, tf, res.bars.map((b) => toCandle(b, id, tf, res.contract)), 'replace');
      s.lastCandleAt = this.now();
    } catch {
      /* offline is reported through the feed status */
    }
  }

  private status(id: InstrumentId, s: MarketSub, st: DbInstrumentStatus | null, offline: string | null): void {
    const sink = this.sink;
    if (!sink) return;
    let code: FeedStatusCode = 'ERROR';
    let conn: ConnectionState = 'DISCONNECTED';
    let message: string | null = offline;
    if (!offline && st) {
      message = st.reasons.join(' ') || null;
      if (st.status === 'LIVE' || st.status === 'DEGRADED' || st.status === 'SYNCING') {
        // Price / candle data (trades + ohlcv-1m) is live even while the order book re-synchronises.
        code = st.freshness === 'DELAYED' ? 'STALE' : 'LIVE';
        conn = st.freshness === 'DELAYED' ? 'DELAYED' : 'LIVE';
      } else if (st.status === 'STALE') {
        code = 'STALE';
        conn = 'DELAYED';
      } else if (st.status === 'CONNECTING' || st.status === 'RECONNECTING') {
        conn = 'CONNECTING';
        message = message ?? `Databento ${st.status.toLowerCase()}`;
      } else {
        conn = 'UNAVAILABLE';
        message = message ?? (st.status === 'AUTH_ERROR' ? 'Databento authentication failed (check DATABENTO_API_KEY on the bridge).' : 'Databento data unavailable.');
      }
    }
    const contract = st?.contract ?? s.contract;
    const key = `${code}|${conn}|${message}|${contract}|${st?.counts.tapeGaps ?? 0}`;
    if (key === s.statusKey) return;
    s.statusKey = key;
    sink.connection(id, conn, conn === 'LIVE' || conn === 'DELAYED' ? null : message);
    const detail: ProviderFeedDetail = {
      code,
      message,
      providerSymbol: contract,
      candidates: [],
      inverted: false,
      lastQuoteAt: s.lastQuoteAt,
      lastCandleAt: s.lastCandleAt,
      lastClosedCandleAt: st?.candles.lastClosed ? st.candles.lastClosed * 1000 : null,
      bridgeHeartbeatAt: this.feed.state.getState().lastOkAt,
      historyBars: {},
      historyLimited: {},
      meta: null,
      realVolumeAvailable: true,
      quarantined: 0,
      gaps: st?.counts.tapeGaps ?? 0,
    };
    sink.feed(id, detail);
  }

  private onEvent(id: InstrumentId, s: MarketSub, e: DbFeedEvent): void {
    const sink = this.sink;
    if (!sink) return;
    if (e.kind === 'offline') return this.status(id, s, null, e.reason === 'UNAUTHORIZED' ? 'The Databento bridge rejected the TLUXE bridge token.' : 'Databento bridge offline - DATA UNAVAILABLE.');
    if (e.kind === 'reset') {
      for (const tf of s.tfs) void this.load(id, s, tf);
      return;
    }
    if (e.kind === 'health') return this.status(id, s, e.health.instruments[s.root] ?? null, null);
    const d = e.data;
    this.status(id, s, d.status, null);
    if (d.contract && s.contract && d.contract !== s.contract) {
      // Contract roll: the old contract's candles are replaced, never merged.
      s.contract = d.contract;
      for (const tf of s.tfs) void this.load(id, s, tf);
      return;
    }
    if (d.contract) s.contract = d.contract;
    const last = d.trades?.at(-1);
    const [bid, ask] = d.status.book.state === 'VALID' ? d.status.book.best : [null, null];
    if (last || bid !== null || ask !== null) {
      sink.quote(id, { ...(last ? { last: last.price, timestamp: nsToMs(last.tsEventNs) } : {}), bid, ask }, { contract: s.contract });
      s.lastQuoteAt = this.now();
    }
    const bars = [...(d.bars ?? []), ...(d.forming ? [d.forming] : [])];
    if (bars.length && s.tfs.has('M1')) sink.candles(id, 'M1', bars.map((b) => toCandle(b, id, 'M1', s.contract)), 'upsert');
    if (d.bars?.length && this.now() - s.lastRefresh > 5000) {
      s.lastRefresh = this.now();
      for (const tf of s.tfs) if (tf !== 'M1') void this.load(id, s, tf);
    }
  }
}

/* ---------------------------------------------------------------- order flow ---------------------------------------------------------------- */

/** Databento Standard (default): exchange trades with the source aggressor side, NO depth (never approximated). */
export const DATABENTO_TRADE_ONLY_CAPS: OrderFlowCapabilities = {
  depth: 'NONE',
  depthLevels: null,
  incrementalDepth: false,
  trades: true,
  aggressorSide: true,
  depthReasons: false,
  sequenced: false,
  snapshotOnDemand: false,
};

/** Text shown wherever depth is missing because of the Databento Standard plan. */
export const DATABENTO_STANDARD_DEPTH_REASON = 'Databento Standard does not include real-time MBO/MBP-10';
export const LEVEL2_REQUIRED = 'Level-2 provider required: IBKR / T4 / other supported depth provider';

/** Databento plan that includes real-time MBO ('mbo' mode). */
export const DATABENTO_ORDER_FLOW_CAPS: OrderFlowCapabilities = {
  depth: 'MBO',
  depthLevels: null,
  incrementalDepth: true,
  trades: true,
  aggressorSide: true,
  depthReasons: false,
  // Databento `sequence` is the venue CHANNEL sequence (not contiguous per instrument); integrity is enforced by the
  // bridge (snapshot validity, F_MAYBE_BAD_BOOK, resync) and reported through status, never by fake sequence numbers.
  sequenced: false,
  snapshotOnDemand: true,
};

interface FlowSub {
  root: DbRoot;
  off: () => void;
  epoch: number;
  bookCursor: number;
  lastI: number;
  contract: string | null;
  depthStatus: string;
  tradeStatus: string;
  fetching: boolean;
}

export type DatabentoFlowMode = 'trades' | 'mbo';

export class DatabentoOrderFlowProvider implements OrderFlowTradeProvider {
  readonly stream: 'trade' | 'both';
  readonly info = DB_INFO;
  readonly caps: OrderFlowCapabilities;
  private sink: OrderFlowSink | null = null;
  private subs = new Map<InstrumentId, FlowSub>();

  /**
   * mode 'trades' (default, Databento Standard): trades only - never a snapshot, depth update or depth status.
   * mode 'mbo': also the bridge's reconstructed MBO book (only for a plan that includes real-time MBO).
   */
  constructor(
    private readonly feed: DatabentoFeed,
    private readonly now: () => number = () => Date.now(),
    readonly mode: DatabentoFlowMode = 'trades',
  ) {
    this.stream = mode === 'mbo' ? 'both' : 'trade';
    this.caps = mode === 'mbo' ? DATABENTO_ORDER_FLOW_CAPS : DATABENTO_TRADE_ONLY_CAPS;
  }

  private get mbo(): boolean {
    return this.mode === 'mbo';
  }

  connect(sink: OrderFlowSink): void {
    this.sink = sink;
  }
  disconnect(): void {
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
    this.sink = null;
  }
  subscribe(def: InstrumentDefinition): void {
    const sink = this.sink;
    if (!sink || this.subs.has(def.id) || !isRoot(def.id)) return;
    const s: FlowSub = { root: def.id, off: () => {}, epoch: -1, bookCursor: -1, lastI: 0, contract: null, depthStatus: '', tradeStatus: '', fetching: false };
    this.subs.set(def.id, s);
    sink.capabilities(def.id, this.caps);
    if (this.mbo) this.setStatus(def.id, s, 'depth', 'CONNECTING', 'Connecting to the Databento bridge.');
    this.setStatus(def.id, s, 'trade', 'CONNECTING', 'Connecting to the Databento bridge.');
    s.off = this.feed.subscribe(def.id, (e) => this.onEvent(def.id, s, e));
    void this.loadTrades(def.id, s, true);
  }
  unsubscribe(id: InstrumentId): void {
    const s = this.subs.get(id);
    if (!s) return;
    s.off();
    this.subs.delete(id);
  }
  requestSnapshot(id: InstrumentId): void {
    const s = this.subs.get(id);
    if (s && this.mbo) void this.loadBook(id, s);
  }

  private setStatus(id: InstrumentId, s: FlowSub, stream: 'depth' | 'trade', st: FeedStatus, detail: string | null): void {
    const key = `${st}|${detail}`;
    if ((stream === 'depth' ? s.depthStatus : s.tradeStatus) === key) return;
    if (stream === 'depth') s.depthStatus = key;
    else s.tradeStatus = key;
    this.sink?.status(id, stream, st, detail);
  }

  private setContract(id: InstrumentId, s: FlowSub, contract: string | null): void {
    if (!contract || contract === s.contract) return;
    const rolled = s.contract !== null;
    s.contract = contract;
    this.sink?.contract(id, contract);
    if (rolled) {
      // Never merge two contracts' books / tapes: the consumer rebuilds from the new contract's snapshot.
      s.epoch = -1;
      s.lastI = 0;
      if (this.mbo) this.setStatus(id, s, 'depth', 'DISCONNECTED', `Contract roll -> ${contract}: rebuilding the book.`);
      this.setStatus(id, s, 'trade', 'DISCONNECTED', `Contract roll -> ${contract}.`);
      this.sink?.capabilities(id, this.caps);
    }
  }

  private async loadBook(id: InstrumentId, s: FlowSub): Promise<void> {
    if (!this.mbo) return;
    try {
      const r = await this.feed.api.book(s.root);
      if (this.subs.get(id) !== s || !this.sink || !r.book) return;
      this.setContract(id, s, r.contract);
      s.epoch = r.epoch;
      s.bookCursor = r.cursor;
      const exch = r.lastEventNs ? nsToMs(r.lastEventNs) : this.now();
      const recv = r.lastRecvNs ? nsToMs(r.lastRecvNs) : exch;
      this.sink.message({ type: 'snapshot', instrumentId: id, seq: null, exchTime: exch, recvTime: recv, bids: r.book.bids.map(([price, size, orders]) => ({ price, size, orders })), asks: r.book.asks.map(([price, size, orders]) => ({ price, size, orders })) });
    } catch {
      /* reported through status */
    }
  }

  private async loadTrades(id: InstrumentId, s: FlowSub, initial: boolean): Promise<void> {
    if (s.fetching) return;
    s.fetching = true;
    try {
      const r = await this.feed.api.trades(s.root, s.lastI, 20000);
      if (this.subs.get(id) !== s) return;
      this.setContract(id, s, r.contract);
      if (!r.complete && !initial) this.setStatus(id, s, 'trade', 'SEQUENCE_GAP', 'Trades missed while the browser was behind the bridge buffer - never invented.');
      this.emitTrades(id, s, r.trades);
    } catch {
      /* reported through status */
    } finally {
      s.fetching = false;
    }
  }

  private emitTrades(id: InstrumentId, s: FlowSub, trades: readonly DbTrade[]): void {
    for (const t of trades) {
      if (t.i <= s.lastI || (s.contract && t.contract !== s.contract)) continue;
      s.lastI = t.i;
      this.sink?.message({ type: 'trade', instrumentId: id, seq: null, exchTime: nsToMs(t.tsEventNs), recvTime: nsToMs(t.tsRecvNs), price: t.price, size: t.size, aggressor: t.aggressor, tradeId: t.key });
    }
  }

  private onEvent(id: InstrumentId, s: FlowSub, e: DbFeedEvent): void {
    const sink = this.sink;
    if (!sink) return;
    if (e.kind === 'offline') {
      // The book can no longer be trusted as current: the consumer clears it (never shown as live).
      if (this.mbo) this.setStatus(id, s, 'depth', 'DISCONNECTED', 'Databento bridge offline.');
      this.setStatus(id, s, 'trade', 'DISCONNECTED', 'Databento bridge offline.');
      s.epoch = -1;
      return;
    }
    if (e.kind === 'reset') {
      s.epoch = -1;
      if (this.mbo) void this.loadBook(id, s);
      void this.loadTrades(id, s, false);
      return;
    }
    if (e.kind === 'health') return;
    const d = e.data;
    this.setContract(id, s, d.contract);
    const st = d.status;
    const caps = st.capabilities;
    // depth stream status ('mbo' mode only - a trade-only provider never reports or sends depth)
    if (!this.mbo) {
      /* no depth stream */
    } else if (caps && (caps.depth === 'NOT_ENTITLED' || caps.depth === 'UNSUPPORTED'))
      this.setStatus(id, s, 'depth', 'DATA_UNAVAILABLE', `DEPTH DATA UNAVAILABLE - ${caps.depthReason ?? DATABENTO_STANDARD_DEPTH_REASON}. ${LEVEL2_REQUIRED}`);
    else if (st.status === 'AUTH_ERROR' || st.status === 'UNAVAILABLE') this.setStatus(id, s, 'depth', 'DATA_UNAVAILABLE', st.reasons.join(' ') || 'DATA UNAVAILABLE');
    else if (st.status === 'CONNECTING') this.setStatus(id, s, 'depth', 'CONNECTING', 'Connecting to Databento.');
    else if (st.status === 'RECONNECTING') this.setStatus(id, s, 'depth', 'DISCONNECTED', 'Databento reconnecting - book frozen.');
    else if (st.status === 'STALE') this.setStatus(id, s, 'depth', 'STALE', st.reasons.join(' '));
    else if (st.book.state !== 'VALID') this.setStatus(id, s, 'depth', 'RESYNCING', st.book.state === 'DEGRADED' ? `DEGRADED - ${st.book.reason ?? 'book integrity'}: resyncing from a fresh snapshot.` : 'SYNCING BOOK - waiting for the complete MBO snapshot.');
    else this.setStatus(id, s, 'depth', 'LIVE', st.status === 'DEGRADED' ? st.reasons.join(' ') : null);
    // trade stream status
    if (caps?.trades === 'NOT_ENTITLED') this.setStatus(id, s, 'trade', 'DATA_UNAVAILABLE', 'Databento trades schema not entitled for this subscription.');
    else if (st.status === 'AUTH_ERROR' || st.status === 'UNAVAILABLE') this.setStatus(id, s, 'trade', 'DATA_UNAVAILABLE', st.reasons.join(' ') || 'DATA UNAVAILABLE');
    else if (st.status === 'CONNECTING' || st.status === 'RECONNECTING') this.setStatus(id, s, 'trade', st.status === 'CONNECTING' ? 'CONNECTING' : 'DISCONNECTED', 'Databento trades session not connected.');
    else if (st.status === 'STALE') this.setStatus(id, s, 'trade', 'STALE', st.reasons.join(' '));
    else this.setStatus(id, s, 'trade', 'LIVE', null);

    const exch = st.lastEventNs ? nsToMs(st.lastEventNs) : e.timeMs;
    const recv = st.lastRecvNs ? nsToMs(st.lastRecvNs) : exch;
    if (!this.mbo) {
      /* trade-only: bridge depth fields are ignored even if present (never a book from a trades feed) */
    } else if (d.snapshot && d.snapshot.epoch !== s.epoch) {
      s.epoch = d.snapshot.epoch;
      s.bookCursor = e.cursor;
      sink.message({ type: 'snapshot', instrumentId: id, seq: null, exchTime: exch, recvTime: recv, bids: d.snapshot.bids.map(([price, size, orders]) => ({ price, size, orders })), asks: d.snapshot.asks.map(([price, size, orders]) => ({ price, size, orders })) });
    } else if (d.levels?.length) {
      if (s.epoch < 0) void this.loadBook(id, s);
      else if (e.cursor > s.bookCursor)
        for (const [side, price, size] of d.levels) sink.message({ type: 'depth', instrumentId: id, seq: null, exchTime: exch, recvTime: recv, side: side === 'B' ? 'bid' : 'ask', price, size, action: size > 0 ? 'set' : 'delete' });
    }
    if (d.trades?.length) {
      if (d.trades[0]!.i > s.lastI + 1 && s.lastI > 0) void this.loadTrades(id, s, false);
      else this.emitTrades(id, s, d.trades);
    }
    if (st.freshness === 'LIVE' || st.freshness === 'DELAYED') {
      if (this.mbo) sink.message({ type: 'heartbeat', instrumentId: id, seq: null, exchTime: exch, recvTime: recv, stream: 'depth' });
      sink.message({ type: 'heartbeat', instrumentId: id, seq: null, exchTime: exch, recvTime: recv, stream: 'trade' });
    }
  }
}

/** Databento as the Level-2 depth source - ONLY for a Databento plan that includes real-time MBO (bridge TLUXE_DB_PLAN=mbo). */
export class DatabentoMboOrderFlowProvider extends DatabentoOrderFlowProvider implements OrderFlowDepthProvider {
  declare readonly stream: 'both';
  constructor(feed: DatabentoFeed, now?: () => number) {
    super(feed, now, 'mbo');
  }
}

/* ----------------------------------------------------------------- footprint ----------------------------------------------------------------- */

/*
 * Footprint side mapping (Databento `trades` schema, CME MDP 3.0 aggressor as supplied - available on Standard):
 *   side 'B' -> BUY aggressor  -> ASK volume
 *   side 'A' -> SELL aggressor -> BID volume
 *   side 'N' -> UNKNOWN (kept separate: never guessed, never split; delta / CVD become PARTIAL)
 * No tick rule / quote rule is applied (classificationMethod null): there is no quote stream on Standard.
 */
export const DATABENTO_FOOTPRINT_CAPS: FootprintCapabilities = {
  trades: true,
  // CME MDP 3.0 aggressor side as supplied by Databento (`side`: B = buyer-initiated, A = seller-initiated, N = none).
  aggressor: 'EXCHANGE',
  classificationMethod: null,
  sequenced: false,
  tradeIds: true,
  exchangeTimestamps: true,
  providerGapReporting: true,
};

interface FpSub {
  root: DbRoot;
  off: () => void;
  lastI: number;
  gaps: number;
  clock: number;
  status: FPFeedStatus | null;
  fetching: boolean;
  lastExch: number;
}

export class DatabentoFootprintProvider implements FootprintTradeProvider {
  readonly info = DB_INFO;
  private sink: FootprintSink | null = null;
  private subs = new Map<InstrumentId, FpSub>();

  constructor(private readonly feed: DatabentoFeed) {}

  connect(sink: FootprintSink): void {
    this.sink = sink;
  }
  disconnect(): void {
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
    this.sink = null;
  }
  subscribe(def: InstrumentDefinition): void {
    if (!this.sink || this.subs.has(def.id) || !isRoot(def.id)) return;
    const s: FpSub = { root: def.id, off: () => {}, lastI: 0, gaps: -1, clock: 0, status: null, fetching: false, lastExch: 0 };
    this.subs.set(def.id, s);
    this.msg(def.id, s, { type: 'caps', instrumentId: def.id, recvTime: 0, caps: DATABENTO_FOOTPRINT_CAPS });
    s.off = this.feed.subscribe(def.id, (e) => this.onEvent(def.id, s, e));
    void this.loadTrades(def.id, s, true);
  }
  unsubscribe(id: InstrumentId): void {
    const s = this.subs.get(id);
    if (!s) return;
    s.off();
    this.subs.delete(id);
  }

  /** Receive order is the knowledge clock: every emitted message has a non-decreasing receive time (source ts_recv). */
  private msg(_id: InstrumentId, s: FpSub, m: FootprintMsg): void {
    s.clock = Math.max(s.clock, m.recvTime);
    this.sink?.message({ ...m, recvTime: s.clock });
  }
  private setStatus(id: InstrumentId, s: FpSub, status: FPFeedStatus, detail: string | null): void {
    if (s.status === status) return;
    const prev = s.status;
    s.status = status;
    const out: FPFeedStatus = status === 'LIVE' && prev === 'DISCONNECTED' ? 'RECONNECTED' : status;
    this.msg(id, s, { type: 'status', instrumentId: id, recvTime: s.clock, status: out, detail });
  }

  private async loadTrades(id: InstrumentId, s: FpSub, initial: boolean): Promise<void> {
    if (s.fetching) return;
    s.fetching = true;
    try {
      for (let page = 0; page < 20; page++) {
        const r = await this.feed.api.trades(s.root, s.lastI, 20000);
        if (this.subs.get(id) !== s) return;
        if (!r.complete && !initial && s.lastI > 0) {
          // Trades were lost between bridge and browser (buffer overrun): flagged, never filled.
          this.setStatus(id, s, 'DISCONNECTED', 'Trades missed while the browser was behind the bridge - gap flagged, never invented.');
          this.setStatus(id, s, 'LIVE', null);
        }
        this.emitTrades(id, s, r.trades);
        if (r.trades.length < 20000) break;
      }
    } catch {
      /* status arrives through the feed */
    } finally {
      s.fetching = false;
    }
  }

  private emitTrades(id: InstrumentId, s: FpSub, trades: readonly DbTrade[]): void {
    for (const t of trades) {
      if (t.i <= s.lastI) continue;
      s.lastI = t.i;
      const exch = nsToMs(t.tsEventNs);
      s.lastExch = Math.max(s.lastExch, exch);
      this.msg(id, s, { type: 'trade', instrumentId: id, contract: t.contract, seq: null, tradeId: t.key, exchTime: exch, recvTime: nsToMs(t.tsRecvNs), price: t.price, size: t.size, aggressor: t.aggressor });
    }
  }

  private onEvent(id: InstrumentId, s: FpSub, e: DbFeedEvent): void {
    if (e.kind === 'offline') return this.setStatus(id, s, 'DISCONNECTED', 'Databento bridge offline.');
    if (e.kind === 'reset') {
      void this.loadTrades(id, s, false);
      return;
    }
    if (e.kind === 'health') return;
    const d = e.data;
    const st = d.status;
    if (st.capabilities?.trades === 'NOT_ENTITLED') this.setStatus(id, s, 'DATA_UNAVAILABLE', 'Databento trades schema not entitled for this subscription.');
    else if (st.status === 'AUTH_ERROR' || st.status === 'UNAVAILABLE') this.setStatus(id, s, 'DATA_UNAVAILABLE', st.reasons.join(' ') || 'DATA UNAVAILABLE');
    else if (st.status === 'CONNECTING') this.setStatus(id, s, 'CONNECTING', null);
    else if (st.status === 'RECONNECTING' || st.status === 'STALE') this.setStatus(id, s, 'DISCONNECTED', st.reasons.join(' ') || `Databento ${st.status.toLowerCase()}`);
    else this.setStatus(id, s, 'LIVE', null);
    const gaps = st.counts.tapeGaps ?? 0;
    if (s.gaps >= 0 && gaps > s.gaps) {
      // The bridge could not replay part of the tape (outage beyond the replay window): a real gap.
      this.setStatus(id, s, 'DISCONNECTED', 'Trade history gap reported by the bridge - never filled.');
      this.setStatus(id, s, 'LIVE', null);
    }
    s.gaps = gaps;
    if (d.trades?.length) {
      if (d.trades[0]!.i > s.lastI + 1 && s.lastI > 0) void this.loadTrades(id, s, false);
      else this.emitTrades(id, s, d.trades);
    }
    // Exchange-clock heartbeat (latest source event time) lets footprint candles close in quiet markets.
    if (st.lastEventNs && (st.freshness === 'LIVE' || st.freshness === 'DELAYED')) {
      const exch = nsToMs(st.lastEventNs);
      if (exch > s.lastExch) {
        s.lastExch = exch;
        this.msg(id, s, { type: 'heartbeat', instrumentId: id, exchTime: exch, recvTime: st.lastRecvNs ? nsToMs(st.lastRecvNs) : exch });
      }
    }
  }
}
