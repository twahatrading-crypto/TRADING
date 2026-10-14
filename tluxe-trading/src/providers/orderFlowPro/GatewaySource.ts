import { MAX_BARS, OFP_TF_MS, OFP_TFS } from '../../engines/orderFlowPro/config';
import { sessionWindow } from '../../engines/orderFlowPro/nyTime';
import type {
  ClassificationStats,
  GatewayProvenance,
  OfpEvent,
  OfpFrame,
  OfpRoot,
  QuoteEvent,
  ReplayProvenance,
  SessionHistory,
  SourceStatus,
  StreamLiveness,
  StreamProvenance,
} from '../../engines/orderFlowPro/types';
import {
  checkSequence,
  contractInfo,
  contractLabel,
  GATEWAY_TF,
  parseBook,
  parseCandles,
  parseDatabentoHealth,
  parseHeatmap,
  parseLocalSymbol,
  parseTradesPage,
  parseUpdates,
  toBookEvent,
  toDepthEvent,
  toTradeEvent,
  topOfBook,
  type DatabentoRootStatus,
  type GatewayTrade,
  type TradesPage,
} from './gatewayMap';
import { historyBudget } from './historyBudget';
import type { OfpSource, SourceSink } from './source';

/* ============================================================================
 * GatewaySource - Order Flow Pro data from the TLUXE gateway's EXISTING read-only market-data endpoints (same
 * origin). It opens no provider session and changes nothing upstream: every request is a GET of an endpoint the
 * website already serves.
 *
 *   trades : GET /api/databento/v1/trades/{root}  Databento GLBX.MDP3 (CME) prints, exchange event time,
 *            EXCHANGE-reported aggressor side (N -> UNKNOWN, never guessed)
 *   depth  : GET /api/ibkr/book + /api/ibkr/updates  IBKR price-level depth (10 rows, VPS depth-service time)
 *   health : GET /api/databento/v1/health  per-root Databento status (one upstream request per call)
 *   bars   : GET /api/databento/v1/candles/{root}  real Databento OHLCV, closed bars only, BEFORE the first trade
 *            (BARS_ONLY: never turned into a footprint)
 *   replay : trades from the gateway ring (<= ~24 h / 100,000 trades) + recorded depth (/api/ibkr/heatmap,
 *            time-weighted per bucket, gaps explicit)
 *
 * Start-up loads only a recent, hour-aligned window of prints (the visible chart); the earlier part of the session
 * is loaded on demand (loadEarlierHistory) and merged into strictly older bar slots - session statistics are
 * labelled PARTIAL until it is complete, and indices already loaded are never downloaded again.
 * Idle streams back off (no new prints / no depth change -> longer interval, reset on the next change).
 *
 * Safety: at most one request in flight per stream (4 streams per subscribed root), AbortController on every
 * request (timeout + unsubscribe + hidden page), exponential back-off with jitter (Retry-After honoured on 429),
 * polling suspended while the page is hidden, bounded back-fill, contract guard (trades and depth must report the
 * same COMEX contract or depth is withheld), explicit gap events for every loss of continuity. Never fabricates
 * a trade, a size or a level; never reports LIVE without a successful poll of a source that reports LIVE.
 * ========================================================================== */

export interface GatewayLimits {
  tradesMs: number;
  depthMs: number;
  healthMs: number;
  /** Idle re-check of the bars stream (no request unless bars are needed). */
  barsMs: number;
  requestTimeoutMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Trades per request (gateway maximum 50,000). */
  tradesPage: number;
  /** Consecutive pages per steady-state poll (catch-up after a pause). */
  catchUpPages: number;
  /** Back-fill bound at subscription: pages x tradesPage trades. */
  backfillMaxPages: number;
  backfillMaxProbes: number;
  /** A successful poll older than this -> the stream is DISCONNECTED. */
  disconnectedAfterMs: number;
  /** No new trade for this long while Databento reports LIVE -> QUIET (never a gap). */
  tradeQuietMs: number;
  /** No IBKR depth change for this long while the gateway reports LIVE -> QUIET. */
  depthQuietMs: number;
  /** A trade more than this much older than the newest accepted one is rejected as out of order. */
  outOfOrderToleranceMs: number;
  /** A trade time this far in the future (vs the gateway clock) is rejected. */
  futureToleranceMs: number;
  /**
   * Bars are closed only up to (gateway time at the start of the last fully caught-up trades poll) minus this margin,
   * so a print that reaches the gateway late is never dropped as "late" by an early bar close.
   */
  tradeSettleMs: number;
  maxReplaySpanMs: number;
  maxReplayTrades: number;
  /** Start-up window: prints since (now - this), rounded DOWN to the hour (whole bars on every timeframe). */
  initialWindowMs: number;
  /** On-demand earlier-session history: at most this many pages of tradesPage prints. */
  historyMaxPages: number;
  /** Idle back-off ceilings: a poll that returned nothing stretches the next interval (x1.5) up to these. */
  tradesIdleMaxMs: number;
  depthIdleMaxMs: number;
  /**
   * The displayed book is only current while depth polls keep confirming it. No successful depth poll for this long
   * (>= 2x the slowest quiet-book poll) -> the book is withdrawn with an explicit gap and re-synchronised on recovery:
   * a frozen book is never shown or recorded as current liquidity.
   */
  depthConfirmMaxMs: number;
}

export const DEFAULT_GATEWAY_LIMITS: Readonly<GatewayLimits> = Object.freeze({
  tradesMs: 1000,
  depthMs: 1000,
  healthMs: 10_000,
  barsMs: 60_000,
  requestTimeoutMs: 8000,
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  tradesPage: 5000,
  catchUpPages: 3,
  backfillMaxPages: 10,
  backfillMaxProbes: 20,
  disconnectedAfterMs: 25_000,
  tradeQuietMs: 60_000,
  depthQuietMs: 60_000,
  outOfOrderToleranceMs: 2000,
  futureToleranceMs: 5000,
  tradeSettleMs: 2000,
  maxReplaySpanMs: 2 * 3600_000,
  maxReplayTrades: 50_000,
  initialWindowMs: 3600_000,
  historyMaxPages: 30,
  tradesIdleMaxMs: 4000,
  depthIdleMaxMs: 3000,
  depthConfirmMaxMs: 6000,
});

const HOUR = 3600_000;

/** Gateway trade ring capacity (bridge `maxTrades`). Older indices are gone. */
export const GATEWAY_TRADE_RING = 100_000;
/** Recorded-depth bucket sizes the gateway accepts (depth_history.BUCKETS_MS). */
const HEAT_BUCKETS_MS = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const TIP = Number.MAX_SAFE_INTEGER;

export interface Visibility {
  hidden(): boolean;
  onChange(cb: () => void): () => void;
}

export interface GatewayEnv {
  fetch: typeof fetch;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
  visibility: Visibility | null;
  /** '' = same origin (the website). */
  base: string;
  random: () => number;
}

function documentVisibility(): Visibility | null {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return null;
  return {
    hidden: () => document.visibilityState === 'hidden',
    onChange: (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}
class SchemaError extends Error {}

type StreamName = 'trades' | 'depth' | 'health' | 'bars';
const STREAMS: StreamName[] = ['health', 'trades', 'depth', 'bars'];

const emptyQuality = (): GatewayProvenance['quality'] => ({
  tradesAccepted: 0,
  tradesDuplicate: 0,
  tradesRejected: 0,
  tradesOutOfOrder: 0,
  unknownSide: 0,
  depthChanges: 0,
  depthResyncs: 0,
  depthSeqGaps: 0,
  depthRejected: 0,
  gaps: 0,
  requestErrors: 0,
  rateLimited: 0,
});

/** Requests issued across all subscriptions of one GatewaySource (diagnostics / tests). */
export interface RequestLog {
  count: number;
  paths: string[];
}

export class GatewaySource implements OfpSource {
  readonly info = { id: 'ofp-gateway', name: 'TLUXE gateway (Databento CME trades + IBKR price-level depth)', demo: false };
  readonly env: GatewayEnv;
  readonly limits: GatewayLimits;
  readonly log: RequestLog = { count: 0, paths: [] };

  constructor(env: Partial<GatewayEnv> = {}, limits: Partial<GatewayLimits> = {}) {
    this.env = {
      fetch: env.fetch ?? ((...a) => fetch(...a)),
      now: env.now ?? Date.now,
      setTimeout: env.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: env.clearTimeout ?? ((h) => clearTimeout(h)),
      visibility: env.visibility === undefined ? documentVisibility() : env.visibility,
      base: env.base ?? '',
      random: env.random ?? Math.random,
    };
    this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...limits };
  }

  /** One GET with timeout + external abort. Never sends anything but a read. */
  async get(path: string, signal: AbortSignal | null, track?: { onRequest(): void; onResponse?(): void }): Promise<unknown> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) ctl.abort();
    const timer = this.env.setTimeout(() => ctl.abort(), this.limits.requestTimeoutMs);
    this.log.count++;
    if (this.log.paths.length < 2000) this.log.paths.push(path);
    track?.onRequest();
    try {
      const r = await this.env.fetch(`${this.env.base}${path}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (r.status !== 200) {
        const ra = Number(r.headers?.get?.('Retry-After') ?? NaN);
        throw new HttpError(r.status, Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 120) * 1000 : null);
      }
      const body = (await r.json()) as unknown;
      track?.onResponse?.();
      return body;
    } finally {
      this.env.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private sessions = new Map<OfpRoot, RootSession>();

  subscribe(root: OfpRoot, sink: SourceSink): () => void {
    const s = new RootSession(this, root, sink);
    this.sessions.set(root, s);
    s.start();
    return () => {
      s.stop();
      if (this.sessions.get(root) === s) this.sessions.delete(root);
    };
  }

  /** Load the earlier part of the current session's prints (on demand, bounded, cancellable). */
  async loadEarlierHistory(root: OfpRoot): Promise<void> {
    await this.sessions.get(root)?.loadEarlier();
  }

  cancelEarlierHistory(root: OfpRoot): void {
    this.sessions.get(root)?.cancelEarlier('Cancelled');
  }

  async history(root: OfpRoot, from: number, to: number): Promise<OfpFrame[]> {
    return (await this.historyDetailed(root, from, to)).frames;
  }

  /**
   * Replay: real trades from the gateway ring in [from, to] + recorded IBKR depth for the same contract, with an
   * explicit description of what is exact (prints) and what is an aggregate (depth). Everything not covered is an
   * explicit gap event - nothing is filled in. Exact historical book snapshots are not served by the gateway.
   */
  async historyDetailed(root: OfpRoot, from: number, to: number): Promise<{ frames: OfpFrame[]; provenance: ReplayProvenance }> {
    const L = this.limits;
    const prov: ReplayProvenance = {
      trades: { kind: 'EXACT_PRINTS', source: 'Databento GLBX.MDP3 trades (CME) from the gateway trade window', count: 0, from: null, to: null, complete: true, detail: null },
      depth: { kind: 'NONE', source: 'Interactive Brokers price-level depth recorded by the gateway', bucketMs: null, buckets: 0, coveredBuckets: 0, firstRecordedMs: null, detail: null },
      exactDepthSnapshots: 'NOT_AVAILABLE',
      gaps: [],
    };
    if (!(to > from)) throw new Error('Replay range is empty');
    if (to - from > L.maxReplaySpanMs) throw new Error(`Replay is limited to ${L.maxReplaySpanMs / 3600_000} h`);
    const events: OfpEvent[] = [];
    const tip = this.page(root, TIP, 1, null);
    const t0 = await tip;
    if (!t0.contract) throw new Error('Databento trade tape not available on the gateway');
    const parsed = parseLocalSymbol(t0.contract, root, new Date(from).getUTCFullYear());
    if (!parsed) throw new Error(`Unexpected trade contract ${t0.contract} for ${root}`);
    const contract = t0.contract;
    const { start, ringFloor } = await findIndexAtTime(this, root, from, t0.lastIndex, null, L.backfillMaxProbes);
    let after = start - 1;
    let n = 0;
    let first: GatewayTrade | null = null;
    let truncated = false;
    let lastT = -Infinity;
    for (let pages = 0; pages < Math.ceil(L.maxReplayTrades / L.tradesPage) + 1; pages++) {
      const p = await this.page(root, after, L.tradesPage, null);
      if (p.contract !== contract) break; // rolled meanwhile - never mixed
      let done = false;
      for (const tr of p.trades) {
        if (tr.i <= after) continue;
        after = tr.i;
        if (tr.t < from) continue;
        if (tr.t > to) {
          done = true;
          break;
        }
        if (tr.t + L.outOfOrderToleranceMs < lastT) continue;
        lastT = Math.max(lastT, tr.t);
        first ??= tr;
        events.push(toTradeEvent(tr, contract));
        if (++n >= L.maxReplayTrades) {
          truncated = true;
          done = true;
          break;
        }
      }
      if (done || p.trades.length < L.tradesPage) break;
    }
    prov.trades.count = n;
    prov.trades.from = first ? first.t : null;
    prov.trades.to = Number.isFinite(lastT) ? lastT : null;
    if (ringFloor && (!first || first.t > from)) {
      prov.trades.complete = false;
      prov.trades.detail = 'Earlier prints have left the gateway trade window';
      events.push({ kind: 'gap', from, to: first ? first.t : to, reason: `Trades before ${new Date(first ? first.t : to).toISOString().slice(11, 19)} UTC are outside the gateway trade window (about 24 h / ${GATEWAY_TRADE_RING.toLocaleString('en-US')} trades)` });
    }
    if (truncated) {
      prov.trades.complete = false;
      prov.trades.detail = `Replay limited to ${L.maxReplayTrades.toLocaleString('en-US')} trades`;
      events.push({ kind: 'gap', from: lastT, to, reason: `Replay limited to ${L.maxReplayTrades.toLocaleString('en-US')} trades` });
    }
    // Recorded depth for the same contract (time-weighted average displayed size per bucket - not exact book states).
    const span = to - from;
    const bucket = HEAT_BUCKETS_MS.find((b) => span / b <= 1500) ?? HEAT_BUCKETS_MS[HEAT_BUCKETS_MS.length - 1]!;
    try {
      // the page-wide recorded-depth budget (shared with the heatmap history and the liquidity-history read)
      if (!(await historyBudget.acquire())) throw new Error('recorded depth request budget exhausted');
      const h = parseHeatmap(await this.get(`/api/ibkr/heatmap?root=${root}&from=${Math.floor(from)}&to=${Math.ceil(to)}&bucket=${bucket}`, null), root);
      if (!h) throw new SchemaError('recorded depth: unexpected response');
      prov.depth.firstRecordedMs = h.firstRecordedMs;
      prov.depth.bucketMs = h.bucketMs;
      if (h.contract !== contract) {
        prov.depth.detail = `Recorded depth ${h.contract ?? 'none'} ≠ trades ${contract} - withheld`;
        events.push({ kind: 'gap', from, to, reason: `Recorded depth ${h.contract ?? 'none'} ≠ trades ${contract} - depth withheld (contracts are never mixed)` });
      } else if (!h.columns.length) {
        prov.depth.detail = h.firstRecordedMs === null ? 'No recorded IBKR depth for this contract' : 'No recorded IBKR depth in this range';
        events.push({ kind: 'gap', from, to, reason: h.firstRecordedMs === null ? 'No recorded IBKR depth for this contract' : 'No recorded IBKR depth in this range' });
      } else {
        prov.depth.kind = 'RECORDED_TIME_WEIGHTED_AGGREGATE';
        prov.depth.buckets = Math.max(1, Math.round((to - from) / h.bucketMs));
        let cursor = from;
        let gapFrom: number | null = null;
        const closeGap = (until: number, why: string) => {
          if (gapFrom !== null && until > gapFrom) events.push({ kind: 'gap', from: gapFrom, to: until, reason: why });
          gapFrom = null;
        };
        for (const c of h.columns) {
          if (c.t > cursor + h.bucketMs) {
            gapFrom ??= cursor;
          }
          if (c.coverage < 0.999) {
            gapFrom ??= c.t;
            cursor = c.t + h.bucketMs;
            continue;
          }
          closeGap(c.t, 'Recorded IBKR depth incomplete in this interval');
          prov.depth.coveredBuckets++;
          events.push({ kind: 'book', t: c.t, bids: c.bids, asks: c.asks });
          cursor = c.t + h.bucketMs;
        }
        if (cursor < to) gapFrom ??= cursor;
        closeGap(to, 'Recorded IBKR depth incomplete in this interval');
      }
    } catch (e) {
      prov.depth.detail = `Recorded depth unavailable (${e instanceof Error ? e.message : 'error'})`;
      events.push({ kind: 'gap', from, to, reason: `Recorded depth unavailable (${e instanceof Error ? e.message : 'error'})` });
    }
    for (const e of events) if (e.kind === 'gap') prov.gaps.push({ from: e.from, to: e.to, reason: e.reason });
    const at = (e: OfpEvent) => ('t' in e ? e.t : e.from);
    events.sort((a, b) => at(a) - at(b));
    const frames: OfpFrame[] = [];
    let seq = 1;
    for (let i = 0; i < events.length; i += 1000) {
      const chunk = events.slice(i, i + 1000);
      frames.push({ root, seq, events: chunk });
      seq += chunk.length;
    }
    return { frames, provenance: prov };
  }

  /** Parsed trades page (throws SchemaError / HttpError). */
  async page(root: OfpRoot, after: number, limit: number, signal: AbortSignal | null, track?: { onRequest(): void; onResponse?(): void }): Promise<TradesPage> {
    const p = parseTradesPage(await this.get(`/api/databento/v1/trades/${root}?after=${after}&limit=${limit}`, signal, track), root);
    if (!p) throw new SchemaError('trades: unexpected response schema');
    return p;
  }
}

/**
 * Smallest retained transport index whose exchange time is >= target (bounded binary search with limit=1 probes).
 * ringFloor = the search hit the oldest retained trade (older trades have left the gateway ring).
 */
async function findIndexAtTime(src: GatewaySource, root: OfpRoot, target: number, lastIndex: number, signal: AbortSignal | null, maxProbes: number, track?: { onRequest(): void; onResponse?(): void }) {
  // Invariant: the answer lies in [a, b]; b = lastIndex + 1 means "no retained trade at or after target".
  let a = Math.max(1, lastIndex - GATEWAY_TRADE_RING + 1);
  let b = lastIndex + 1;
  let probes = 0;
  let floorSeen = false;
  while (a < b && probes < maxProbes) {
    const mid = Math.floor((a + b) / 2);
    const p = await src.page(root, mid - 1, 1, signal, track);
    probes++;
    const tr = p.trades[0];
    if (!p.complete) floorSeen = true; // indices below the returned one have left the gateway ring
    if (!tr) {
      b = mid; // nothing at or after mid
      continue;
    }
    if (tr.i > mid) {
      // mid is no longer retained: the oldest retained trade is tr.i - nothing below it exists any more.
      a = tr.i;
      if (tr.t >= target) b = tr.i;
      else a = tr.i + 1;
      continue;
    }
    if (tr.t < target) a = mid + 1;
    else b = mid;
  }
  return { start: a, probes, ringFloor: floorSeen };
}

/* ============================================================================ one subscribed root */

class RootSession {
  private stopped = false;
  private paused = false;
  private timers: Partial<Record<StreamName, ReturnType<typeof setTimeout>>> = {};
  /** Local timer only (no request): withdraws a book that depth polls stopped confirming. */
  private depthWatch: ReturnType<typeof setTimeout> | undefined;
  /** Gateway time of the last successful depth poll that left the book valid. */
  private depthConfirmedAt: number | null = null;
  /** Why the book was withdrawn for lack of confirmation (shown until a fresh snapshot is accepted). */
  private depthWithdrawn: string | null = null;
  private busy = new Set<StreamName>();
  private fails: Record<StreamName, number> = { trades: 0, depth: 0, health: 0, bars: 0 };
  private lastOk: Record<StreamName, number | null> = { trades: null, depth: null, health: null, bars: null };
  private lastErr: Record<StreamName, string | null> = { trades: null, depth: null, health: null, bars: null };
  private ctl = new AbortController();
  private unlisten: (() => void) | null = null;
  private seq = 1;
  private serverOffset = 0;
  /** The gateway clock is known (offset measured); trade intake and bar closing wait for it. */
  private clockKnown = false;
  private startedAt = 0;
  private q = emptyQuality();
  private requests = 0;
  // trades
  private contract: string | null = null;
  private contractProblem: string | null = null;
  private cursor: number | null = null;
  private lastTradeT: number | null = null;
  private lastTradeRecv: number | null = null;
  private firstTradeT: number | null = null;
  private tradesLagMs: number | null = null;
  /** Engine time may only advance to here: every print up to this time has been received (see tradeSettleMs). */
  private watermark: number | null = null;
  private vol = { BUY: 0, SELL: 0, UNKNOWN: 0 };
  private reasons: Record<string, number> = {};
  private db: DatabentoRootStatus | null = null;
  // depth
  private needBook = true;
  private bookValid = false;
  private epoch = -1;
  private depthSeq = 0;
  private depthT: number | null = null;
  private depthState: { state: string; detail: string | null; lastUpdateMs: number | null } | null = null;
  private depthContract: string | null = null;
  private depthMismatch: string | null = null;
  private depthRows = 0;
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private lastTop: string | null = null;
  // bars
  private barsNeeded = false;
  private barsLoaded = false;
  // idle back-off (consecutive polls that returned nothing)
  private idle: Record<StreamName, number> = { trades: 0, depth: 0, health: 0, bars: 0 };
  // session history (start-up window + on-demand earlier prints)
  private hist: SessionHistory | null = null;
  /** Lowest transport index loaded for the current contract (earlier history ends just below it). */
  private firstIndex: number | null = null;
  private histCtl: AbortController | null = null;
  /** Earlier-history progress: last index already merged (a resume continues after it - never re-applied). */
  private histCursor: number | null = null;
  private histStartIndex: number | null = null;
  private histRingFloor = false;
  private histFirstT: number | null = null;
  private histLastT = -Infinity;

  constructor(
    private readonly src: GatewaySource,
    readonly root: OfpRoot,
    private readonly sink: SourceSink,
  ) {}

  private get L() {
    return this.src.limits;
  }
  private get env() {
    return this.src.env;
  }
  private now() {
    return this.env.now();
  }
  /** Gateway clock estimate (from serverMs of the IBKR endpoints). */
  private serverNow() {
    return this.now() + this.serverOffset;
  }
  private track = { onRequest: () => void this.requests++ };
  /** A successful trades page inside a long (multi-request) load still proves the stream is alive. */
  private tradesAlive() {
    this.lastOk.trades = this.now();
  }
  /** Trade-stream requests (tip, probes, pages): every successful response proves the trade stream is alive. */
  private tradesTrack = { onRequest: () => void this.requests++, onResponse: () => this.tradesAlive() };

  start() {
    this.startedAt = this.now();
    const vis = this.env.visibility;
    if (vis) {
      this.unlisten = vis.onChange(() => (vis.hidden() ? this.pause() : this.resume()));
      if (vis.hidden()) {
        this.paused = true;
        this.publish();
        return;
      }
    }
    this.publish();
    for (const s of STREAMS) this.schedule(s, 0);
  }

  stop() {
    this.stopped = true;
    this.histCtl?.abort();
    this.ctl.abort();
    for (const s of STREAMS) this.clear(s);
    this.clearDepthWatch();
    this.unlisten?.();
    this.unlisten = null;
  }

  private pause() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.cancelEarlier('Paused: page hidden');
    this.ctl.abort(); // cancel in-flight requests
    this.ctl = new AbortController();
    for (const s of STREAMS) this.clear(s);
    this.clearDepthWatch(); // the book is re-synchronised on resume anyway
    this.publish();
  }

  private resume() {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    if (this.bookValid) {
      // The book was not observed while hidden: never pretend continuity.
      this.gap(this.depthT ?? this.serverNow(), this.serverNow(), 'Polling paused while the page was hidden - depth re-synchronised');
      this.invalidateBook();
    }
    this.needBook = true;
    for (const s of STREAMS) this.schedule(s, 0);
  }

  private clear(s: StreamName) {
    const h = this.timers[s];
    if (h !== undefined) this.env.clearTimeout(h);
    delete this.timers[s];
  }

  private schedule(s: StreamName, ms: number) {
    if (this.stopped || this.paused) return;
    this.clear(s);
    this.timers[s] = this.env.setTimeout(() => {
      delete this.timers[s];
      void this.run(s);
    }, ms);
  }

  private backoff(s: StreamName, e: unknown): number {
    const f = this.fails[s];
    const base = Math.min(this.L.backoffMaxMs, this.L.backoffMinMs * 2 ** Math.max(0, f - 1));
    const jittered = base * (0.75 + 0.5 * this.env.random());
    if (e instanceof HttpError && e.status === 429) return Math.max(jittered, e.retryAfterMs ?? 0);
    return jittered;
  }

  private interval(s: StreamName) {
    const base = s === 'trades' ? this.L.tradesMs : s === 'depth' ? this.L.depthMs : s === 'health' ? this.L.healthMs : this.L.barsMs;
    const cap = s === 'trades' ? this.L.tradesIdleMaxMs : s === 'depth' ? this.L.depthIdleMaxMs : base;
    return Math.min(cap, base * 1.5 ** this.idle[s]);
  }

  private async run(s: StreamName) {
    if (this.stopped || this.paused || this.busy.has(s)) return;
    this.busy.add(s);
    const signal = this.ctl.signal;
    let next = this.interval(s);
    try {
      const again = await (s === 'trades' ? this.trades(signal) : s === 'depth' ? this.depth(signal) : s === 'health' ? this.health(signal) : this.bars(signal));
      if (this.stopped || this.paused) return;
      this.fails[s] = 0;
      this.lastOk[s] = this.now();
      this.lastErr[s] = null;
      this.idle[s] = again === 'idle' ? Math.min(this.idle[s] + 1, 10) : 0;
      next = again === 'now' ? 0 : this.interval(s);
    } catch (e) {
      if (this.stopped || this.paused || signal.aborted) return;
      this.fails[s]++;
      this.q.requestErrors++;
      if (e instanceof HttpError && e.status === 429) this.q.rateLimited++;
      this.lastErr[s] = e instanceof HttpError ? `HTTP ${e.status}` : e instanceof SchemaError ? e.message : e instanceof Error ? e.message || 'network error' : 'network error';
      next = this.backoff(s, e);
    } finally {
      this.busy.delete(s);
      if (s === 'depth' && !this.stopped && !this.paused) this.armDepthWatch();
      if (!this.stopped) {
        if (this.watermark !== null) this.sink.time(this.watermark);
        this.publish();
        this.schedule(s, next);
      }
    }
  }

  /* ------------------------------------------------------------------ emit */

  private emit(events: OfpEvent[]) {
    if (!events.length || this.stopped) return;
    this.sink.frames([{ root: this.root, seq: this.seq, events }]);
    this.seq += events.length;
  }

  private gap(from: number, to: number, reason: string) {
    this.q.gaps++;
    this.emit([{ kind: 'gap', from, to: Math.max(from, to), reason }]);
  }

  /** Clear everything derived (contract roll / gateway restart): the engine is reset, then re-filled from real data. */
  private fullReset(reason: string) {
    this.sink.reset?.(reason);
    this.contract = null;
    this.contractProblem = null;
    this.cursor = null;
    this.lastTradeT = null;
    this.lastTradeRecv = null;
    this.firstTradeT = null;
    this.watermark = null;
    this.vol = { BUY: 0, SELL: 0, UNKNOWN: 0 };
    this.reasons = {};
    this.invalidateBook();
    this.needBook = true;
    // depth confirmation state belongs to the previous contract: no old timer, reason or confirmation time survives
    this.clearDepthWatch();
    this.depthWithdrawn = null;
    this.depthConfirmedAt = null;
    this.depthState = null;
    this.depthContract = null;
    this.depthMismatch = null;
    this.barsNeeded = false;
    this.barsLoaded = false;
    this.cancelEarlier(null);
    this.hist = null;
    this.firstIndex = null;
    this.histCursor = null;
    this.histStartIndex = null;
    this.histRingFloor = false;
    this.histFirstT = null;
    this.histLastT = -Infinity;
    this.idle = { trades: 0, depth: 0, health: 0, bars: 0 };
    this.seq = 1;
    this.schedule('health', 0); // invalidate the cached Databento status (contract / session)
  }

  /* ------------------------------------------------------------------ trades */

  private async trades(signal: AbortSignal): Promise<'now' | 'idle' | void> {
    if (this.cursor === null) return this.initTrades(signal);
    const pollStart = this.serverNow();
    for (let pages = 0; pages < this.L.catchUpPages; pages++) {
      const p = await this.src.page(this.root, this.cursor, this.L.tradesPage, signal, this.tradesTrack);
      this.tradesAlive();
      if (!this.acceptPage(p)) return 'now';
      if (p.trades.length < this.L.tradesPage) {
        this.advanceWatermark(pollStart);
        return p.trades.length === 0 && pages === 0 ? 'idle' : undefined;
      }
    }
    return 'now'; // still behind: continue immediately (bounded per poll); bars stay open meanwhile
  }

  /**
   * Validates contract / continuity of a page and applies its trades. false = a reset was triggered.
   * `measureLag`: steady-state polls only - the delivery latency of the newest print (gateway time - Databento
   * receipt time, including the poll interval). Never measured on back-fill pages (those prints are old by design).
   */
  private acceptPage(p: TradesPage, measureLag = true): boolean {
    if (p.contract === null) {
      this.contractProblem = 'Databento trade tape has no active contract yet';
      return true;
    }
    if (this.contract !== null && p.contract !== this.contract) {
      this.fullReset(`Contract changed ${this.contract} → ${p.contract} (Databento roll) - all derived data cleared, never combined`);
      return false;
    }
    if (this.cursor !== null && p.lastIndex < this.cursor) {
      this.fullReset('Gateway trade stream restarted - re-synchronised from the gateway');
      return false;
    }
    for (const [k, n] of Object.entries(p.rejected)) {
      this.q.tradesRejected += n;
      this.reasons[`REJECTED_${k}`] = (this.reasons[`REJECTED_${k}`] ?? 0) + n;
    }
    const events: OfpEvent[] = [];
    const first = p.trades.find((t) => this.cursor === null || t.i > this.cursor);
    if (this.cursor !== null && first && (!p.complete || first.i !== this.cursor + 1)) {
      // Trades left the gateway ring before we read them (or the index jumped): explicit, never filled.
      this.q.gaps++;
      events.push({ kind: 'gap', from: this.lastTradeT ?? first.t, to: first.t, reason: !p.complete ? 'Trades missing: the gateway trade window moved on before they were read' : `Trade index gap ${this.cursor} → ${first.i}` });
    }
    const limit = this.serverNow() + this.L.futureToleranceMs;
    let newestRecv: number | null = null;
    for (const tr of p.trades) {
      if (this.cursor !== null && tr.i <= this.cursor) {
        this.q.tradesDuplicate++;
        continue;
      }
      this.cursor = tr.i;
      if (tr.t > limit) {
        this.q.tradesRejected++;
        this.reasons.REJECTED_FUTURE_TIME = (this.reasons.REJECTED_FUTURE_TIME ?? 0) + 1;
        continue;
      }
      if (this.lastTradeT !== null && tr.t < this.lastTradeT) {
        this.q.tradesOutOfOrder++;
        if (tr.t + this.L.outOfOrderToleranceMs < this.lastTradeT) {
          this.q.tradesRejected++;
          this.reasons.REJECTED_OUT_OF_ORDER = (this.reasons.REJECTED_OUT_OF_ORDER ?? 0) + 1;
          continue;
        }
      }
      const ev = toTradeEvent(tr, p.contract);
      events.push(ev);
      this.q.tradesAccepted++;
      if (ev.aggressor === 'UNKNOWN') this.q.unknownSide++;
      this.vol[ev.aggressor] += ev.size;
      this.reasons[ev.basis!] = (this.reasons[ev.basis!] ?? 0) + 1;
      this.lastTradeT = Math.max(this.lastTradeT ?? tr.t, tr.t);
      this.lastTradeRecv = Math.max(this.lastTradeRecv ?? tr.tRecv, tr.tRecv);
      newestRecv = Math.max(newestRecv ?? tr.tRecv, tr.tRecv);
      this.firstTradeT ??= tr.t;
    }
    if (p.trades.length) this.cursor = Math.max(this.cursor ?? 0, p.trades[p.trades.length - 1]!.i);
    else this.cursor ??= p.lastIndex;
    if (measureLag && newestRecv !== null) this.tradesLagMs = Math.max(0, this.serverNow() - newestRecv);
    this.emit(events);
    return true;
  }

  /** Every print up to pollStart - tradeSettleMs has been received: bars ending before that may close. */
  private advanceWatermark(pollStart: number) {
    const w = pollStart - this.L.tradeSettleMs;
    this.watermark = this.watermark === null ? w : Math.max(this.watermark, w);
  }

  private async initTrades(signal: AbortSignal): Promise<'now' | void> {
    // Exchange-time checks and bar closing use the gateway clock: wait until it is known (a skewed PC clock could
    // otherwise reject current prints as "future" or close bars too early).
    if (!this.clockKnown) return;
    const pollStart = this.serverNow();
    const tip = await this.src.page(this.root, TIP, 1, signal, this.tradesTrack);
    if (tip.contract === null) {
      this.contractProblem = 'Databento trade tape has no active contract yet';
      return;
    }
    const parsed = parseLocalSymbol(tip.contract, this.root, new Date(this.serverNow()).getUTCFullYear());
    if (!parsed) {
      this.contractProblem = `Gateway reports ${tip.contract}, not a ${this.root} COMEX outright - nothing accepted`;
      return;
    }
    if (this.db?.contract && this.db.contract !== tip.contract) {
      this.contractProblem = `Trade tape ${tip.contract} ≠ Databento status ${this.db.contract} - waiting (never combined)`;
      this.schedule('health', 0); // contract changed: refresh the cached status now instead of at the next interval
      return;
    }
    this.contractProblem = null;
    this.contract = tip.contract;
    const sessionStart = sessionWindow(this.serverNow(), 'ETH').start;
    // Start-up window: whole hours only, so every timeframe's earlier slots stay strictly older than loaded prints.
    const target = Math.max(sessionStart, Math.floor((this.serverNow() - this.L.initialWindowMs) / HOUR) * HOUR);
    const hist: SessionHistory = { sessionStart, loadedFrom: target, complete: target <= sessionStart, loading: false, historyLoaded: 0, historyThrough: null, unavailable: null, error: null };
    if (tip.lastIndex <= 0) {
      this.hist = hist;
      this.cursor = 0;
      this.barsNeeded = true;
      this.schedule('bars', 0);
      this.advanceWatermark(pollStart);
      return;
    }
    const found = await findIndexAtTime(this.src, this.root, target, tip.lastIndex, signal, this.L.backfillMaxProbes, this.tradesTrack);
    let start = found.start;
    const cap = this.L.backfillMaxPages * this.L.tradesPage;
    let limited = false;
    if (tip.lastIndex - start + 1 > cap) {
      start = tip.lastIndex - cap + 1;
      limited = true;
    }
    this.cursor = start - 1;
    let firstT: number | null = null;
    let caughtUp = false;
    for (let pages = 0; pages < this.L.backfillMaxPages; pages++) {
      const p = await this.src.page(this.root, this.cursor, this.L.tradesPage, signal, this.tradesTrack);
      this.tradesAlive();
      if (pages === 0) {
        // The first page defines continuity from here on; a ring overrun before it is the ring floor gap below.
        const f = p.trades.find((t) => t.i > (this.cursor ?? 0));
        firstT = f ? f.t : null;
        if (f) this.cursor = f.i - 1;
        this.firstIndex = f ? f.i : start;
      }
      if (!this.acceptPage({ ...p, complete: true }, false)) return 'now';
      if (p.trades.length < this.L.tradesPage) {
        caughtUp = true;
        break;
      }
    }
    if (firstT !== null && firstT > target) {
      if (limited) this.gap(target, firstT, `Back-fill limited to the most recent ${cap.toLocaleString('en-US')} trades`);
      else if (found.ringFloor) this.gap(target, firstT, `Trades before ${new Date(firstT).toISOString().slice(11, 19)} UTC are outside the gateway trade window`);
    }
    if (limited || found.ringFloor) {
      // The start-up window itself already reaches past what the gateway still holds.
      if (found.ringFloor) {
        hist.unavailable = { from: sessionStart, to: firstT ?? target };
        hist.complete = false;
      }
      if (limited) hist.loadedFrom = firstT;
    }
    // Only now (start-up window loaded) is the earlier history offered: before that there is nothing to merge into.
    this.hist = hist;
    this.barsNeeded = true;
    this.schedule('bars', 0);
    // Caught up: bars before the poll start may close. Otherwise the steady poll continues the catch-up first.
    if (caughtUp) this.advanceWatermark(pollStart);
    return 'now';
  }

  /* ------------------------------------------------------------------ earlier session history (on demand) */

  cancelEarlier(reason: string | null) {
    if (!this.histCtl) return;
    this.histCtl.abort();
    this.histCtl = null;
    if (this.hist) {
      this.hist.loading = false;
      if (reason) this.hist.error = reason;
    }
    if (!this.stopped) this.publish();
  }

  /**
   * Earlier prints of the session [session start, first loaded index): downloaded once, oldest first, in bounded
   * pages, and merged into strictly older bar slots (history events). Indices already loaded are never requested.
   * Aborted by cancel, hidden page, unsubscribe and any contract roll / gateway restart (then nothing is applied).
   */
  async loadEarlier(): Promise<void> {
    const h = this.hist;
    if (!h || h.loading || h.complete || this.contract === null || this.firstIndex === null || this.stopped || this.paused) return;
    const contract = this.contract;
    const upTo = this.firstIndex - 1; // inclusive
    const histStart = h.loadedFrom ?? this.firstTradeT ?? h.sessionStart;
    const ctl = new AbortController();
    this.histCtl = ctl;
    h.loading = true;
    h.error = null;
    this.publish();
    try {
      if (this.histCursor === null || this.histStartIndex === null) {
        const tip = await this.src.page(this.root, TIP, 1, ctl.signal, this.track);
        if (tip.contract !== contract) throw new Error('contract changed - history discarded');
        const found = await findIndexAtTime(this.src, this.root, h.sessionStart, Math.min(tip.lastIndex, upTo), ctl.signal, this.L.backfillMaxProbes, this.track);
        if (ctl.signal.aborted || this.contract !== contract) return;
        this.histStartIndex = found.start;
        this.histRingFloor = found.ringFloor;
        this.histCursor = found.start - 1;
      }
      let after = this.histCursor;
      let loaded = h.historyLoaded;
      let pages = 0;
      while (after < upTo && pages < this.L.historyMaxPages) {
        const p = await this.src.page(this.root, after, Math.min(this.L.tradesPage, upTo - after), ctl.signal, this.track);
        pages++;
        if (ctl.signal.aborted || this.contract !== contract) return;
        if (p.contract !== contract) throw new Error('contract changed - history discarded');
        const events: OfpEvent[] = [];
        for (const tr of p.trades) {
          if (tr.i <= after) continue;
          if (tr.i > upTo) break;
          after = tr.i;
          // Only prints strictly before the start-up window belong to the earlier history (never double-counted).
          if (tr.t >= histStart || tr.t < h.sessionStart) continue;
          if (tr.t + this.L.outOfOrderToleranceMs < this.histLastT) {
            this.q.tradesOutOfOrder++;
            this.q.tradesRejected++;
            continue;
          }
          this.histLastT = Math.max(this.histLastT, tr.t);
          this.histFirstT ??= tr.t;
          const ev = { ...toTradeEvent(tr, contract), history: true };
          events.push(ev);
          loaded++;
          this.q.tradesAccepted++;
          if (ev.aggressor === 'UNKNOWN') this.q.unknownSide++;
          this.vol[ev.aggressor] += ev.size;
          this.reasons[ev.basis!] = (this.reasons[ev.basis!] ?? 0) + 1;
        }
        for (const n of Object.values(p.rejected)) this.q.tradesRejected += n;
        this.emit(events);
        this.histCursor = after; // merged: a cancelled / resumed load continues after this index
        h.historyLoaded = loaded;
        if (Number.isFinite(this.histLastT)) h.historyThrough = this.histLastT;
        this.publish();
        if (!p.trades.length) break;
      }
      if (after >= upTo) {
        this.firstIndex = this.histStartIndex;
        h.loadedFrom = h.sessionStart;
        h.historyThrough = null;
        h.complete = !this.histRingFloor;
        if (this.histRingFloor) {
          const until = this.histFirstT ?? histStart;
          h.loadedFrom = until;
          h.unavailable = { from: h.sessionStart, to: until };
          this.gap(h.sessionStart, until, `Earlier session prints (before ${new Date(until).toISOString().slice(11, 19)} UTC) have left the gateway trade window`);
        }
      } else {
        h.error = `History limited to ${(this.L.historyMaxPages * this.L.tradesPage).toLocaleString('en-US')} prints per request - load again to continue`;
      }
    } catch (e) {
      if (!ctl.signal.aborted) h.error = e instanceof Error ? e.message : 'history request failed';
    } finally {
      if (this.histCtl === ctl) this.histCtl = null;
      h.loading = false;
      if (!this.stopped) this.publish();
    }
  }

  /* ------------------------------------------------------------------ depth */

  private invalidateBook() {
    this.bookValid = false;
    this.bids.clear();
    this.asks.clear();
    this.lastTop = null;
  }

  private loseBook(reason: string, from: number | null = null) {
    if (this.bookValid) this.gap(from ?? this.depthT ?? this.serverNow(), this.serverNow(), reason);
    this.invalidateBook();
    this.needBook = true;
    this.depthConfirmedAt = null;
  }

  private clearDepthWatch() {
    if (this.depthWatch !== undefined) this.env.clearTimeout(this.depthWatch);
    this.depthWatch = undefined;
  }

  /** (Re)arm the confirmation deadline of a valid book: last successful depth poll + depthConfirmMaxMs. */
  private armDepthWatch() {
    this.clearDepthWatch();
    const ok = this.lastOk.depth;
    if (!this.bookValid || ok === null) return;
    const due = Math.max(0, ok + this.L.depthConfirmMaxMs - this.now());
    this.depthWatch = this.env.setTimeout(() => {
      this.depthWatch = undefined;
      this.checkDepthConfirmed();
    }, due + 1);
  }

  /**
   * A valid book that no depth poll has confirmed for depthConfirmMaxMs is withdrawn: an explicit gap from the last
   * confirmation (the engine's recorder stops treating it as valid), then a fresh snapshot once polls succeed again.
   */
  private checkDepthConfirmed() {
    if (this.stopped || this.paused || !this.bookValid) return;
    const ok = this.lastOk.depth;
    if (ok !== null && this.now() - ok <= this.L.depthConfirmMaxMs) return this.armDepthWatch();
    const last = this.depthConfirmedAt;
    const why = this.lastErr.depth ? `gateway depth request failing (${this.lastErr.depth})` : 'no depth poll completed';
    const reason = `No IBKR depth confirmation for > ${Math.round(this.L.depthConfirmMaxMs / 1000)} s (${why}) - book withdrawn${last !== null ? `; last confirmed ${new Date(last).toISOString().slice(11, 19)} UTC` : ''}`;
    this.loseBook(reason, last);
    this.depthWithdrawn = reason;
    this.publish();
  }

  private async depth(signal: AbortSignal): Promise<'now' | 'idle' | void> {
    if (this.contract === null) return; // depth is only accepted for a known trade contract
    if (this.needBook) {
      const t0 = this.now();
      const b = parseBook(await this.src.get(`/api/ibkr/book?root=${this.root}`, signal, this.track), this.root);
      if (!b) throw new SchemaError('depth: unexpected book schema');
      this.setClock(b.serverMs, t0);
      this.depthState = { state: b.state, detail: b.problem ?? b.detail, lastUpdateMs: b.lastUpdateMs };
      this.depthContract = b.contract;
      this.depthRows = b.rows;
      if (b.problem) {
        this.q.depthRejected++;
        this.loseBook(`IBKR depth rejected: ${b.problem}`);
        return;
      }
      if (b.state !== 'LIVE' || !b.valid) {
        this.depthMismatch = b.state === 'CONTRACT_MISMATCH' ? b.detail ?? 'IBKR and Databento contracts differ' : null;
        this.loseBook(`IBKR depth ${b.state}${b.detail ? `: ${b.detail}` : ''}`);
        return;
      }
      if (b.contract !== this.contract || b.exchange !== 'COMEX') {
        this.depthMismatch = `IBKR depth ${b.contract ?? '—'} (${b.exchange ?? '—'}) ≠ trades ${this.contract} (COMEX) - depth withheld`;
        this.loseBook(this.depthMismatch);
        return;
      }
      this.depthMismatch = null;
      this.epoch = b.epoch;
      this.depthSeq = b.depthSeq;
      this.bids = new Map(b.bids);
      this.asks = new Map(b.asks);
      this.bookValid = true;
      this.needBook = false;
      this.depthWithdrawn = null;
      const ev = toBookEvent(b);
      this.depthT = ev.t;
      this.depthConfirmedAt = this.serverNow();
      const out: OfpEvent[] = [ev];
      const q = this.quote(ev.t);
      if (q) out.push(q);
      this.emit(out);
      return 'now';
    }
    const t1 = this.now();
    const u = parseUpdates(await this.src.get(`/api/ibkr/updates?root=${this.root}&epoch=${this.epoch}&after=${this.depthSeq}`, signal, this.track), this.root);
    if (!u) throw new SchemaError('depth: unexpected updates schema');
    this.setClock(u.serverMs, t1);
    this.depthState = { state: u.state, detail: u.detail, lastUpdateMs: u.lastUpdateMs };
    if (u.state !== 'LIVE' || !u.valid) {
      this.depthMismatch = u.state === 'CONTRACT_MISMATCH' ? u.detail ?? 'IBKR and Databento contracts differ' : null;
      this.loseBook(`IBKR depth ${u.state}${u.detail ? `: ${u.detail}` : ''}`);
      return;
    }
    if (u.resync || u.epoch !== this.epoch) {
      this.q.depthResyncs++;
      this.loseBook('IBKR depth re-synchronised by the gateway (new epoch / ring overrun)');
      return 'now';
    }
    const { ok, gapAt } = checkSequence(u.changes, this.depthSeq);
    const quietPoll = u.changes.length === 0;
    const out: OfpEvent[] = [];
    for (const c of ok) {
      out.push(toDepthEvent(c));
      (c.side === 'BID' ? this.bids : this.asks).set(c.price, c.size);
      if (c.size === 0) (c.side === 'BID' ? this.bids : this.asks).delete(c.price);
      this.depthSeq = c.seq;
      this.depthT = c.t;
      this.q.depthChanges++;
      const q = this.quote(c.t);
      if (q) out.push(q);
    }
    this.emit(out);
    if (gapAt !== null || u.rejected > 0) {
      if (u.rejected > 0) this.q.depthRejected += u.rejected;
      else this.q.depthSeqGaps++;
      this.loseBook(gapAt !== null ? `IBKR depth sequence gap at ${gapAt}` : `IBKR depth: ${u.rejected} malformed change(s) - book re-synchronised`);
      return 'now';
    }
    if (this.bookValid) this.depthConfirmedAt = this.serverNow();
    return quietPoll ? 'idle' : undefined;
  }

  /** Top-of-book quote from the IBKR price-level book; emitted only when it changes (OFI input, never a trade side). */
  private quote(t: number): QuoteEvent | null {
    const q = topOfBook(t, this.bids, this.asks);
    if (!q) return null;
    const key = `${q.bid}|${q.bidSize}|${q.ask}|${q.askSize}`;
    if (key === this.lastTop) return null;
    this.lastTop = key;
    return q;
  }

  /* ------------------------------------------------------------------ health / bars */

  private async health(signal: AbortSignal): Promise<void> {
    const t0 = this.now();
    const d = parseDatabentoHealth(await this.src.get('/api/databento/v1/health', signal, this.track), this.root);
    if (!d) throw new SchemaError('Databento health: unexpected response schema');
    this.db = d;
    if (d.serverMs !== null) this.setClock(d.serverMs, t0);
  }

  /** Gateway clock from a response's server time, compensated for half the round trip (never the browser clock). */
  private setClock(serverMs: number, sentAt: number) {
    this.serverOffset = serverMs - (sentAt + this.now()) / 2;
    this.clockKnown = true;
  }

  private async bars(signal: AbortSignal): Promise<void> {
    if (!this.barsNeeded || this.contract === null) return;
    const out: OfpEvent[] = [];
    for (const tf of OFP_TFS) {
      const c = parseCandles(await this.src.get(`/api/databento/v1/candles/${this.root}?timeframe=${GATEWAY_TF[tf]}&limit=${MAX_BARS}`, signal, this.track), this.root, tf);
      if (!c) throw new SchemaError('bars: unexpected response schema');
      if (c.contract !== this.contract) continue; // never mix contracts
      // Only bars entirely BEFORE the first real trade: those slots stay BARS_ONLY (no footprint is ever derived).
      const cut = this.firstTradeT === null ? Infinity : Math.floor(this.firstTradeT / OFP_TF_MS[tf]) * OFP_TF_MS[tf];
      for (const b of c.bars) if (b.t < cut) out.push(b);
    }
    this.barsNeeded = false;
    this.barsLoaded = true;
    out.sort((a, b) => ('t' in a && 't' in b ? a.t - b.t : 0));
    this.emit(out);
  }

  /* ------------------------------------------------------------------ status */

  private stale(s: StreamName) {
    const ok = this.lastOk[s];
    return ok === null || this.now() - ok > this.L.disconnectedAfterMs;
  }

  private tradesProv(): StreamProvenance {
    const age = this.lastTradeT === null ? null : Math.max(0, this.serverNow() - this.lastTradeT);
    const base = { provider: 'Databento GLBX.MDP3 trades (CME) via TLUXE gateway', timeBasis: 'EXCHANGE_EVENT' as const, contract: this.contract, lastMs: this.lastTradeT, ageMs: age, lastPollMs: this.lastOk.trades };
    let state: StreamLiveness;
    let detail: string | null = null;
    if (this.contractProblem) {
      state = 'UNAVAILABLE';
      detail = this.contractProblem;
    } else if (this.stale('trades')) {
      state = 'DISCONNECTED';
      detail = this.lastErr.trades ? `gateway trades request failing (${this.lastErr.trades})` : this.lastOk.trades === null ? 'connecting' : 'no successful poll recently';
    } else if (!this.db || this.stale('health')) {
      state = 'DISCONNECTED';
      detail = this.db ? `Databento status not readable (${this.lastErr.health ?? 'no recent poll'})` : this.lastErr.health ? `Databento status failing (${this.lastErr.health})` : 'connecting (Databento status not received yet)';
    } else if (this.db.contract && this.contract && this.db.contract !== this.contract) {
      state = 'CONTRACT_MISMATCH';
      detail = `Databento status ${this.db.contract} ≠ trade tape ${this.contract}`;
    } else if (this.db.freshness === 'LIVE' && (this.db.state === 'LIVE' || this.db.state === 'DEGRADED')) {
      state = age !== null && age <= this.L.tradeQuietMs ? 'LIVE' : 'QUIET';
      detail = this.db.state === 'DEGRADED' ? `Databento reports DEGRADED: ${this.db.detail ?? ''}` : age === null ? 'connected; no trade received yet in this window' : null;
    } else if (this.db.freshness === 'STALE' || this.db.freshness === 'DELAYED') {
      state = 'STALE';
      detail = `Databento ${this.db.state} / ${this.db.freshness}${this.db.detail ? `: ${this.db.detail}` : ''}`;
    } else if (this.db.freshness === 'UNAVAILABLE') {
      state = 'UNAVAILABLE';
      detail = `Databento ${this.db.state}${this.db.detail ? `: ${this.db.detail}` : ''}`;
    } else {
      state = 'DISCONNECTED';
      detail = `Databento ${this.db.state} / ${this.db.freshness}${this.db.detail ? `: ${this.db.detail}` : ''}`;
    }
    return { ...base, state, detail };
  }

  private depthProv(): StreamProvenance {
    const age = this.depthState?.lastUpdateMs != null ? Math.max(0, this.serverNow() - this.depthState.lastUpdateMs) : null;
    const base = { provider: 'Interactive Brokers price-level depth (10 rows, VPS depth service) via TLUXE gateway', timeBasis: 'VPS_DEPTH_UPDATE' as const, contract: this.depthContract, lastMs: this.depthState?.lastUpdateMs ?? null, ageMs: age, lastPollMs: this.lastOk.depth };
    let state: StreamLiveness;
    let detail: string | null = this.depthState?.detail ?? null;
    if (this.contract === null) {
      state = 'DISCONNECTED';
      detail = 'waiting for the trade contract (depth is only accepted for the same contract)';
    } else if (this.depthMismatch) {
      state = 'CONTRACT_MISMATCH';
      detail = this.depthMismatch;
    } else if (this.stale('depth')) {
      state = 'DISCONNECTED';
      detail = this.lastErr.depth ? `gateway depth request failing (${this.lastErr.depth})` : this.lastOk.depth === null ? 'connecting' : 'no successful poll recently';
    } else if (!this.bookValid && this.depthWithdrawn) {
      state = 'DISCONNECTED';
      detail = this.depthWithdrawn;
    } else if (this.bookValid && this.depthState?.state === 'LIVE') {
      state = age !== null && age > this.L.depthQuietMs ? 'QUIET' : 'LIVE';
    } else {
      const st = this.depthState?.state ?? null;
      state = st === 'STALE' ? 'STALE' : st === 'NOT_CONFIGURED' || st === 'NOT_ENTITLED' ? 'UNAVAILABLE' : 'DISCONNECTED';
      detail =
        st === null
          ? this.lastErr.depth
            ? `gateway depth request failing (${this.lastErr.depth})`
            : 'waiting for the first IBKR depth snapshot of this contract'
          : `IBKR depth ${st}${this.depthState?.detail ? `: ${this.depthState.detail}` : ''}`;
    }
    return { ...base, state, detail };
  }

  private barsProv(): StreamProvenance {
    const failing = this.lastErr.bars !== null;
    return {
      state: this.barsLoaded ? 'LIVE' : failing ? 'DISCONNECTED' : 'UNAVAILABLE',
      provider: 'Databento OHLCV (CME) via TLUXE gateway - closed bars before the first trade only (no footprint)',
      timeBasis: 'BAR_OPEN',
      contract: this.barsLoaded ? this.contract : null,
      lastMs: null,
      ageMs: null,
      lastPollMs: this.lastOk.bars,
      detail: failing ? `bars request failing (${this.lastErr.bars})` : this.barsLoaded ? null : 'not loaded yet',
    };
  }

  private publish() {
    const trades = this.tradesProv();
    const depth = this.depthProv();
    const bars = this.barsProv();
    // Until the start-up window is loaded there is no data to call LIVE: CONNECTING (never LIVE / QUIET).
    // "Loading" only while requests are succeeding (or within the grace period after start) - never forever.
    const loadingWindow =
      this.hist === null &&
      !this.contractProblem &&
      this.fails.trades === 0 &&
      this.fails.health === 0 &&
      (this.lastOk.trades !== null ? !this.stale('trades') : this.now() - this.startedAt <= this.L.disconnectedAfterMs);
    const live = (trades.state === 'LIVE' || trades.state === 'QUIET') && !loadingWindow;
    let feed: SourceStatus['feed'];
    if (this.paused) feed = 'STALE';
    else if (live) feed = 'LIVE';
    else if (loadingWindow) feed = 'CONNECTING';
    else if (trades.state === 'STALE') feed = 'STALE';
    else if (trades.state === 'UNAVAILABLE') feed = 'UNAVAILABLE';
    else if (trades.state === 'CONTRACT_MISMATCH') feed = 'CONTRACT_MISMATCH';
    else if ((this.lastOk.trades === null || this.lastOk.health === null) && this.fails.trades === 0 && this.fails.health === 0) feed = 'CONNECTING';
    else feed = 'DISCONNECTED';
    const depthOk = depth.state === 'LIVE' || depth.state === 'QUIET';
    const parsed = this.contract ? parseLocalSymbol(this.contract, this.root, new Date(this.serverNow()).getUTCFullYear()) : null;
    const totalVol = this.vol.BUY + this.vol.SELL + this.vol.UNKNOWN;
    const classification: ClassificationStats = {
      method: 'EXCHANGE',
      inferred: false,
      touchSource: null,
      prevTouchWindowMs: 0,
      reasons: { ...this.reasons },
      volume: { ...this.vol },
      unknownVolumePct: totalVol ? Math.round((this.vol.UNKNOWN / totalVol) * 10_000) / 100 : null,
    };
    const provenance: GatewayProvenance = { trades, depth, bars, aggressor: this.contract ? 'EXCHANGE' : 'NONE', quality: { ...this.q }, requests: this.requests, history: this.hist ? { ...this.hist, unavailable: this.hist.unavailable ? { ...this.hist.unavailable } : null } : undefined };
    const diagnostics = [
      loadingWindow ? `Trades: loading the start-up window (prints since ${new Date(Math.floor((this.serverNow() - this.L.initialWindowMs) / HOUR) * HOUR).toISOString().slice(11, 16)} UTC)…` : `Trades: ${trades.provider} · ${trades.state}${trades.detail ? ` · ${trades.detail}` : ''}`,
      `Trade side: exchange-reported aggressor (CME via Databento); not reported (N) → UNKNOWN, never inferred`,
      `Depth: ${depth.provider} · ${depth.state}${depth.detail ? ` · ${depth.detail}` : ''}`,
      'Depth timestamps are the VPS depth service update time (not exchange time); changes are net differences between ~250 ms IBKR snapshots',
      parsed ? `Contract: ${contractLabel(parsed)} · COMEX · trades and depth ${depthOk ? 'MATCH' : 'not matched - depth withheld'}` : 'Contract: not resolved',
      ...(this.hist && !this.hist.complete
        ? [`Session history PARTIAL: prints loaded from ${this.hist.loadedFrom ? new Date(this.hist.loadedFrom).toISOString().slice(11, 16) : '—'} UTC (session from ${new Date(this.hist.sessionStart).toISOString().slice(11, 16)} UTC)${this.hist.unavailable ? ' - earlier prints no longer available from the gateway' : ' - earlier prints load on demand'}`]
        : []),
      ...(this.paused ? ['Polling paused: page hidden'] : []),
    ];
    this.sink.status({
      root: this.root,
      feed,
      marketDataType: feed === 'LIVE' ? 'REALTIME' : null,
      contract: parsed ? contractInfo(parsed, depthOk && this.depthContract === this.contract) : null,
      capabilities: {
        trades: live ? 'AVAILABLE' : 'UNAVAILABLE',
        aggressor: live ? 'AVAILABLE' : 'UNAVAILABLE',
        depth: depthOk ? 'AVAILABLE' : 'UNAVAILABLE',
        historicalBars: this.barsLoaded ? 'AVAILABLE' : 'UNAVAILABLE',
      },
      depthRows: depthOk ? this.depthRows : 0,
      lastEventMs: Math.max(this.lastTradeT ?? 0, this.depthT ?? 0) || null,
      latencyMs: live ? this.tradesLagMs : null,
      diagnostics,
      classification,
      provenance,
    });
  }
}
