import type { FeedStatus, OrderFlowCapabilities } from '../../engines/orderFlow/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';
import type { OrderFlowDepthProvider, OrderFlowSink } from '../orderFlow/types';

/* ============================================================================
 * IBKR COMEX Level-2 depth (DEPTH ONLY - trades stay Databento).
 *
 *   IB Gateway (cloud Windows VPS) -> TLUXE IBKR depth bridge -> outbound wss -> TLUXE gateway
 *   browser (any device) -> same-origin GET /api/ibkr/status | book | updates   (never localhost, never the VPS)
 *
 * Normalization: the gateway serves IBKR's aggregated price levels (MBP) as a sequenced book: `book` snapshots and
 * price-level changes (new size; 0 = level removed). This adapter re-numbers them into ONE local, contiguous sequence
 * for the order-flow engine, so its own gap / snapshot / rebuild logic stays in charge. IBKR depth has no exchange
 * timestamp: the event time is the VPS receive time.
 *
 * Honesty rules:
 *  - capabilities are declared ONCE per instrument (a capability change rebuilds the engine, which would also drop the
 *    Databento trade history); availability is expressed through the depth STATUS instead;
 *  - whenever IBKR is not LIVE (offline, auth required, stale, not entitled, gap, resync) the engine's book is first
 *    invalidated through a continuity break in the local sequence, so NO depth of uncertain continuity is ever shown;
 *    the book comes back only from a fresh IBKR snapshot;
 *  - never MBO: IBKR reqMktDepth provides aggregated levels, not orders.
 * ========================================================================== */

export type IbkrState = 'NOT_CONFIGURED' | 'CONNECTING' | 'LIVE' | 'STALE' | 'RECONNECTING' | 'AUTH_REQUIRED' | 'OFFLINE' | 'NOT_ENTITLED' | 'UNSUPPORTED' | 'CONTRACT_UNRESOLVED' | 'CONTRACT_MISMATCH' | 'UNKNOWN';

export interface IbkrContract {
  conId: number;
  localSymbol: string;
  exchange: string;
  currency: string;
  expiry: string;
  minTick: number;
  tradingClass?: string;
  multiplier?: string;
}

export interface IbkrRootStatus {
  state: IbkrState;
  detail: string | null;
  valid: boolean;
  contract: IbkrContract | null;
  bidLevels: number;
  askLevels: number;
  lastDepthMs: number | null;
  /** Bridge receive time of the last IBKR depth snapshot (UTC) - NOT an exchange timestamp. */
  lastUpdateMs?: number | null;
  rowsRequested?: number | null;
  ops?: Record<string, number> | null;
  marketMakerField?: boolean | null;
}

export interface IbkrStatus {
  configured: boolean;
  mode?: 'pull' | 'link';
  depthTypeCode?: 'PRICE_LEVEL';
  mbo?: false;
  link: { connected: boolean; stale: boolean; lastMessageMs: number | null; detail: string | null };
  session: {
    state: string | null;
    apiConnected?: boolean | null;
    authRequired?: boolean | null;
    detail?: string | null;
    lastIbHeartbeatMs?: number | null;
    lastConnectedMs?: number | null;
    reconnects?: number | null;
    nextReconnectMs?: number | null;
    lastError?: { code: number; message: string; atMs: number } | null;
  };
  roots: Record<string, IbkrRootStatus>;
  depthType: string;
  timestampSource: string;
}

export interface IbkrHealthState {
  status: IbkrStatus | null;
  error: string | null;
  fetchedAt: number | null;
}

/** Shared, read-only health for the UI (DEPTH · IBKR <state>, session panel). */
export const ibkrHealth: Store<IbkrHealthState> = createStore<IbkrHealthState>({ status: null, error: null, fetchedAt: null });

/** One visible IBKR price-level row exactly as IBKR published it (marketMaker null = not supplied; never inferred). */
export interface IbkrRow {
  position: number;
  price: number;
  size: number;
  marketMaker: string | null;
}
export interface IbkrVisibleBook {
  bids: IbkrRow[];
  asks: IbkrRow[];
  /** bridge receive time (lastUpdate, UTC) - not a proven exchange timestamp */
  lastUpdateMs: number | null;
  /** first time this browser session received a valid IBKR book for the root (heatmap history starts here) */
  since: number;
}
/** The current visible IBKR book per root (DOM). null whenever depth is not LIVE + valid - never old depth as live. */
export const ibkrBook: Store<Record<string, IbkrVisibleBook | null>> = createStore<Record<string, IbkrVisibleBook | null>>({});
const recordedSince: Record<string, number> = {};

export const IBKR_DEPTH_CAPS: Readonly<OrderFlowCapabilities> = Object.freeze({
  depth: 'MBP',
  depthLevels: null,
  incrementalDepth: true,
  trades: false,
  aggressorSide: false,
  depthReasons: false, // IBKR says insert / update / delete of a row - never WHY (cancel vs execution)
  sequenced: true, // local contiguous sequence (see above)
  snapshotOnDemand: true,
});

const ROOTS: readonly InstrumentId[] = ['GC', 'SI'];
const REQUEST_TIMEOUT_MS = 4000;

type FetchLike = (input: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void; now: () => number };

interface BookResponse {
  root: string;
  state: IbkrState;
  detail: string | null;
  valid: boolean;
  epoch: number;
  depthSeq: number;
  lastDepthMs: number | null;
  serverMs: number;
  bids: [number, number][];
  asks: [number, number][];
  rows?: { bids: IbkrRow[]; asks: IbkrRow[] };
  lastUpdateMs?: number | null;
}
interface UpdatesResponse {
  state: IbkrState;
  detail: string | null;
  valid: boolean;
  epoch: number;
  depthSeq: number;
  serverMs: number;
  resync: boolean;
  changes: [number, 'bid' | 'ask', number, number, number][];
  rows?: { bids: IbkrRow[]; asks: IbkrRow[] };
  lastUpdateMs?: number | null;
}

/** IBKR state -> engine feed status. DISCONNECTED / CONNECTING are only sent AFTER the book is invalidated. */
export function feedStatusOf(s: IbkrState): FeedStatus {
  switch (s) {
    case 'LIVE':
      return 'LIVE';
    case 'STALE':
      return 'STALE';
    case 'CONNECTING':
      return 'CONNECTING';
    case 'RECONNECTING':
    case 'OFFLINE':
    case 'UNKNOWN':
      return 'DISCONNECTED';
    default:
      return 'DATA_UNAVAILABLE'; // NOT_CONFIGURED / AUTH_REQUIRED / NOT_ENTITLED / UNSUPPORTED / CONTRACT_*
  }
}

export function ibkrLabel(s: IbkrState): string {
  return s.replace(/_/g, ' ');
}

interface Sub {
  def: InstrumentDefinition;
  timer: unknown;
  epoch: number | null;
  after: number;
  local: number; // local contiguous sequence fed to the engine
  bookShown: boolean; // the engine currently holds a valid IBKR book from us
  needSnapshot: boolean;
  lastStatus: string | null;
  busy: boolean;
}

export class IbkrDepthProvider implements OrderFlowDepthProvider {
  readonly info = { id: 'ibkr-depth', name: 'IBKR · COMEX Level-2' };
  readonly stream = 'depth' as const;
  private sink: OrderFlowSink | null = null;
  private subs = new Map<InstrumentId, Sub>();
  private statusTimer: unknown = null;
  private readonly fetchImpl: FetchLike;
  private readonly timers: Timers;

  constructor(private readonly opts: { base?: string; pollMs?: number; statusMs?: number; fetchImpl?: FetchLike; timers?: Timers } = {}) {
    // Same-origin gateway only (never the VPS, never a token): cookies only, with a request timeout.
    this.fetchImpl = opts.fetchImpl ?? ((u) => fetch(u, { credentials: 'same-origin', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
    this.timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), now: () => Date.now() };
  }

  private url(path: string): string {
    return `${this.opts.base ?? ''}/api/ibkr/${path}`;
  }

  connect(sink: OrderFlowSink): void {
    this.sink = sink;
    this.pollStatus();
  }

  disconnect(): void {
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
    this.timers.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.sink = null;
  }

  subscribe(def: InstrumentDefinition): void {
    this.unsubscribe(def.id);
    const sink = this.sink;
    if (!sink) return;
    sink.capabilities(def.id, IBKR_DEPTH_CAPS);
    if (!ROOTS.includes(def.id)) {
      sink.status(def.id, 'depth', 'DATA_UNAVAILABLE', 'IBKR COMEX Level-2 covers GC and SI only.');
      return;
    }
    const s: Sub = { def, timer: null, epoch: null, after: 0, local: 0, bookShown: false, needSnapshot: true, lastStatus: null, busy: false };
    this.subs.set(def.id, s);
    this.setStatus(s, 'CONNECTING', 'Connecting to IBKR depth (cloud VPS)…');
    this.schedule(s, 0);
  }

  unsubscribe(id: InstrumentId): void {
    const s = this.subs.get(id);
    if (!s) return;
    this.timers.clearTimeout(s.timer);
    this.subs.delete(id);
    this.showRows(id, null);
  }

  /** The engine saw a gap / needs a fresh book: the next LIVE poll fetches a snapshot. */
  requestSnapshot(id: InstrumentId): void {
    const s = this.subs.get(id);
    if (s) s.needSnapshot = true;
  }

  // ---------------------------------------------------------------- internals
  private schedule(s: Sub, ms: number): void {
    this.timers.clearTimeout(s.timer);
    s.timer = this.timers.setTimeout(() => void this.poll(s), ms);
  }

  /** Publish the visible rows for the DOM (or clear them). Polls are sequential per root, and a response whose
   *  lastUpdate is older than the rows already shown is ignored (never overwrites newer depth). */
  private showRows(root: string, r: { rows?: { bids: IbkrRow[]; asks: IbkrRow[] }; lastUpdateMs?: number | null } | null): void {
    const cur = ibkrBook.getState()[root] ?? null;
    if (!r || !r.rows) {
      if (cur) ibkrBook.setState({ ...ibkrBook.getState(), [root]: null });
      return;
    }
    const t = r.lastUpdateMs ?? null;
    if (cur && cur.lastUpdateMs !== null && t !== null && t < cur.lastUpdateMs) return;
    if (cur && t === cur.lastUpdateMs) return;
    const since = (recordedSince[root] ??= this.timers.now());
    ibkrBook.setState({ ...ibkrBook.getState(), [root]: { bids: r.rows.bids, asks: r.rows.asks, lastUpdateMs: t, since } });
  }

  private setStatus(s: Sub, st: IbkrState, detail: string | null): void {
    const key = `${st}|${detail ?? ''}`;
    if (key === s.lastStatus) return;
    s.lastStatus = key;
    this.sink?.status(s.def.id, 'depth', feedStatusOf(st), `IBKR ${ibkrLabel(st)}${detail ? ` — ${detail}` : ''}`);
  }

  /** Invalidate the engine's book (continuity unknown) BEFORE reporting a non-LIVE status: a skipped local sequence
   *  number puts the engine into SEQUENCE GAP; the held marker is never applied because every later snapshot carries
   *  a higher local sequence. */
  private invalidate(s: Sub, now: number): void {
    this.showRows(s.def.id, null);
    if (!s.bookShown) return;
    s.bookShown = false;
    s.needSnapshot = true;
    s.local += 2;
    this.sink?.message({ type: 'depth', instrumentId: s.def.id, seq: s.local, exchTime: now, recvTime: now, side: 'bid', price: 0, size: 0, action: 'delete' });
  }

  private async get<T>(path: string): Promise<T | null> {
    try {
      const r = await this.fetchImpl(this.url(path));
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }

  private async poll(s: Sub): Promise<void> {
    if (this.subs.get(s.def.id) !== s || s.busy) return;
    s.busy = true;
    const now = this.timers.now();
    try {
      if (s.needSnapshot || s.epoch === null) {
        const b = await this.get<BookResponse>(`book?root=${s.def.id}`);
        if (this.subs.get(s.def.id) !== s) return;
        if (!b) {
          this.invalidate(s, now);
          this.setStatus(s, 'OFFLINE', 'TLUXE gateway unreachable');
        } else if (!b.valid || b.state !== 'LIVE') {
          this.invalidate(s, now);
          this.setStatus(s, b.state, b.detail);
        } else {
          s.local += 1;
          this.sink?.message({ type: 'snapshot', instrumentId: s.def.id, seq: s.local, exchTime: b.lastDepthMs ?? b.serverMs, recvTime: now,
                               bids: b.bids.map(([price, size]) => ({ price, size })), asks: b.asks.map(([price, size]) => ({ price, size })) });
          s.epoch = b.epoch;
          s.after = b.depthSeq;
          s.bookShown = true;
          s.needSnapshot = false;
          this.showRows(s.def.id, b);
          this.setStatus(s, 'LIVE', null);
        }
      } else {
        const u = await this.get<UpdatesResponse>(`updates?root=${s.def.id}&epoch=${s.epoch}&after=${s.after}`);
        if (this.subs.get(s.def.id) !== s) return;
        if (!u) {
          this.invalidate(s, now);
          this.setStatus(s, 'OFFLINE', 'TLUXE gateway unreachable');
        } else if (u.resync || !u.valid || u.state !== 'LIVE' || u.epoch !== s.epoch) {
          this.invalidate(s, now);
          s.needSnapshot = true;
          s.epoch = null;
          this.setStatus(s, u.state, u.detail);
        } else {
          for (const [seq, side, price, size, recv] of u.changes) {
            if (seq !== s.after + 1) {
              // never apply across a hole: rebuild from a snapshot
              this.invalidate(s, now);
              s.epoch = null;
              break;
            }
            s.after = seq;
            s.local += 1;
            this.sink?.message({ type: 'depth', instrumentId: s.def.id, seq: s.local, exchTime: recv, recvTime: now, side, price, size, action: size > 0 ? 'set' : 'delete' });
          }
          if (s.bookShown) {
            this.showRows(s.def.id, u);
            this.setStatus(s, 'LIVE', null);
          }
        }
      }
    } finally {
      s.busy = false;
      if (this.subs.get(s.def.id) === s) this.schedule(s, s.bookShown ? (this.opts.pollMs ?? 300) : 2000);
    }
  }

  private async pollStatus(): Promise<void> {
    if (!this.sink) return;
    const st = await this.get<IbkrStatus>('status');
    ibkrHealth.setState({ status: st, error: st ? null : 'IBKR status unavailable (gateway unreachable)', fetchedAt: this.timers.now() });
    if (this.sink) this.statusTimer = this.timers.setTimeout(() => void this.pollStatus(), this.opts.statusMs ?? 2000);
  }
}
