import { OFP_TICK } from '../../engines/orderFlowPro/config';
import type { BarEvent, BookSnapshotEvent, ContractInfo, DepthLevelEvent, OfpRoot, OfpTf, QuoteEvent, Side, TradeEvent } from '../../engines/orderFlowPro/types';

/* ============================================================================
 * Order Flow Pro <- TLUXE gateway: strict schema validation + mapping (pure functions, no network, no clock).
 *
 * Every response is validated BEFORE anything is accepted. A response whose envelope does not match the verified
 * contract returns null (the caller treats it as an error, never as data). Individual records that fail a check
 * are counted per reason and dropped - never repaired, never guessed.
 *
 * Verified gateway contracts (production f6da572, recorded in testing/gatewayRecorded.json):
 *   GET /api/databento/v1/trades/{GC|SI}?after=&limit=  -> {root, contract, instrumentId, trades[{i, tsEventNs,
 *        tsRecvNs, price, size, side A|B|N, aggressor SELL|BUY|UNKNOWN, sequence, contract}], complete, lastIndex}
 *        side = the EXCHANGE aggressor field (CME MDP3 via Databento): B = buyer aggressor, A = seller aggressor,
 *        N = not reported -> UNKNOWN (never guessed).
 *   GET /api/ibkr/book?root=      -> IBKR PRICE_LEVEL book {state, valid, epoch, depthSeq, contract{localSymbol,
 *        symbol, exchange, currency}, bids[[p,s]], asks[[p,s]], lastUpdateMs (VPS depth-service update time), serverMs}
 *   GET /api/ibkr/updates?root=&epoch=&after= -> {resync, changes[[seq, 'bid'|'ask', price, size, ms]], ...}
 *        one change per contiguous seq: any skipped seq is a gap.
 *   GET /api/databento/v1/candles/{root}?timeframe=&limit= -> {contract, bars[{time s, open, high, low, close,
 *        volume, isClosed}]} - real Databento OHLCV; the last bar may be forming (never used as closed).
 *   GET /api/databento/v1/health -> {instruments{GC|SI{status, freshness, contract, lastEventNs, reasons}},
 *        sessions{tape{state}}} - one upstream request per call.
 *   GET /api/ibkr/heatmap?root=&from=&to=&bucket= -> recorded depth: columns[[t, coverage, bids[[p,avg]], asks]]
 *        (time-weighted average displayed size per bucket, IBKR bridge receive time; nothing before firstRecordedMs).
 * ========================================================================== */

export const MONTH_CODES: Record<string, number> = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
const MULTIPLIER: Record<OfpRoot, string> = { GC: '100', SI: '5000' };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const GATEWAY_TF: Record<OfpTf, string> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '1h': 'H1' };
const TF_S: Record<OfpTf, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Price on the instrument's tick grid (GC 0.1, SI 0.005), tolerant only to binary floating-point noise. */
export function onTick(price: number, root: OfpRoot): boolean {
  if (!isNum(price) || price <= 0) return false;
  const k = price / OFP_TICK[root];
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/* ------------------------------------------------------------------------------------------------ contracts */

export interface ParsedContract {
  root: OfpRoot;
  localSymbol: string;
  month: number;
  /** Four-digit year resolved from the one/two-digit symbol year (nearest year not before refYear - 1). */
  year: number;
}

/**
 * Strict CME outright symbol for the expected root: GCZ6, GCZ26, SIZ6. Anything else (spreads, other roots, the
 * micro / mini classes, MT5 spot names such as XAUUSD) is rejected.
 */
export function parseLocalSymbol(sym: unknown, root: OfpRoot, refYear: number): ParsedContract | null {
  if (!isStr(sym)) return null;
  const m = new RegExp(`^${root}([FGHJKMNQUVXZ])(\\d{1,2})$`).exec(sym);
  if (!m) return null;
  const month = MONTH_CODES[m[1]!]!;
  const d = m[2]!;
  let year: number;
  if (d.length === 2) year = 2000 + Number(d);
  else {
    year = (refYear - 1) - ((refYear - 1) % 10) + Number(d);
    if (year < refYear - 1) year += 10;
  }
  return { root, localSymbol: sym, month, year };
}

export const contractLabel = (c: ParsedContract) => `${c.localSymbol} (${MONTH_NAMES[c.month - 1]} ${c.year})`;

/** ContractInfo for the page. `verified` = Databento trades and IBKR depth report the same COMEX contract. */
export function contractInfo(c: ParsedContract, verified: boolean): ContractInfo {
  return {
    root: c.root,
    localSymbol: c.localSymbol,
    conId: null,
    // Contract month (YYYYMM) - the exact last trade date is not part of the gateway data.
    expiry: `${c.year}${String(c.month).padStart(2, '0')}`,
    exchange: 'COMEX',
    tradingClass: c.root,
    multiplier: MULTIPLIER[c.root],
    verified,
  };
}

/* ------------------------------------------------------------------------------------------------ trades */

export interface GatewayTrade {
  i: number;
  /** Exchange event time (ms) - Databento ts_event. */
  t: number;
  /** Databento receive time (ms) - ts_recv. */
  tRecv: number;
  price: number;
  size: number;
  side: 'A' | 'B' | 'N';
  sequence: number;
}

export interface TradesPage {
  root: OfpRoot;
  contract: string | null;
  instrumentId: number | null;
  lastIndex: number;
  complete: boolean;
  trades: GatewayTrade[];
  rejected: Record<string, number>;
}

const EXPECTED_AGGRESSOR = { B: 'BUY', A: 'SELL', N: 'UNKNOWN' } as const;

export function parseTradesPage(body: unknown, root: OfpRoot): TradesPage | null {
  if (!isObj(body) || body.root !== root || !Array.isArray(body.trades) || !isInt(body.lastIndex) || typeof body.complete !== 'boolean') return null;
  if (body.contract !== null && !isStr(body.contract)) return null;
  const contract = body.contract as string | null;
  const rejected: Record<string, number> = {};
  const bad = (k: string) => void (rejected[k] = (rejected[k] ?? 0) + 1);
  const trades: GatewayTrade[] = [];
  for (const r of body.trades as unknown[]) {
    if (!isObj(r) || !isInt(r.i) || r.i <= 0 || !isNum(r.tsEventNs) || !isNum(r.tsRecvNs) || !isNum(r.price) || !isNum(r.size) || !isStr(r.side)) {
      bad('SCHEMA');
      continue;
    }
    if (r.side !== 'A' && r.side !== 'B' && r.side !== 'N') {
      bad('SIDE');
      continue;
    }
    if (r.aggressor !== EXPECTED_AGGRESSOR[r.side]) {
      bad('AGGRESSOR_MISMATCH');
      continue;
    }
    if (contract === null || r.contract !== contract) {
      bad('CONTRACT');
      continue;
    }
    if (!onTick(r.price, root)) {
      bad('PRICE_OFF_TICK');
      continue;
    }
    if (!Number.isInteger(r.size) || r.size <= 0) {
      bad('SIZE');
      continue;
    }
    // ns timestamps exceed 2^53: millisecond precision is exact enough; de-duplication uses the integer index.
    const t = Math.floor(r.tsEventNs / 1e6);
    const tRecv = Math.floor(r.tsRecvNs / 1e6);
    if (t <= 0 || tRecv + 1000 < t) {
      bad('TIME');
      continue;
    }
    trades.push({ i: r.i, t, tRecv, price: r.price, size: r.size, side: r.side, sequence: isInt(r.sequence) ? r.sequence : 0 });
  }
  return { root, contract, instrumentId: isInt(body.instrumentId) ? body.instrumentId : null, lastIndex: body.lastIndex, complete: body.complete, trades, rejected };
}

/** Exchange-reported aggressor: never inferred, never re-classified downstream (method EXCHANGE). */
export function toTradeEvent(tr: GatewayTrade, contract: string): TradeEvent {
  return {
    kind: 'trade',
    t: tr.t,
    tRecv: tr.tRecv,
    id: `${contract}:${tr.i}`,
    price: tr.price,
    size: tr.size,
    aggressor: EXPECTED_AGGRESSOR[tr.side],
    method: 'EXCHANGE',
    inferred: false,
    basis: tr.side === 'N' ? 'EXCHANGE_SIDE_NOT_REPORTED' : 'EXCHANGE_AGGRESSOR',
    quoteAgeMs: null,
    quoteSource: null,
    bid: null,
    ask: null,
  };
}

/* ------------------------------------------------------------------------------------------------ depth */

export interface GatewayBook {
  state: string;
  detail: string | null;
  valid: boolean;
  epoch: number;
  depthSeq: number;
  contract: string | null;
  exchange: string | null;
  lastUpdateMs: number | null;
  serverMs: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  rows: number;
  /** Set when the levels themselves failed validation (the book is then treated as invalid). */
  problem: string | null;
}

function parseLevels(v: unknown, root: OfpRoot, desc: boolean): Array<[number, number]> | string {
  if (!Array.isArray(v)) return 'levels not an array';
  const out: Array<[number, number]> = [];
  for (const l of v) {
    if (!Array.isArray(l) || l.length < 2 || !isNum(l[0]) || !isNum(l[1])) return 'malformed level';
    if (!onTick(l[0], root)) return `price ${l[0]} off the ${OFP_TICK[root]} tick`;
    if (l[1] < 0) return 'negative size';
    const prev = out[out.length - 1];
    if (prev && (desc ? l[0] >= prev[0] : l[0] <= prev[0])) return 'levels not strictly ordered';
    out.push([l[0], l[1]]);
  }
  return out;
}

export function parseBook(body: unknown, root: OfpRoot): GatewayBook | null {
  if (!isObj(body) || body.root !== root || !isStr(body.state) || typeof body.valid !== 'boolean' || !isInt(body.epoch) || !isInt(body.depthSeq) || !isNum(body.serverMs)) return null;
  if (body.depthType !== 'PRICE_LEVEL' || body.mbo !== false) return null;
  const c = isObj(body.contract) ? body.contract : null;
  const bids = parseLevels(body.bids, root, true);
  const asks = parseLevels(body.asks, root, false);
  let problem: string | null = typeof bids === 'string' ? `bids: ${bids}` : typeof asks === 'string' ? `asks: ${asks}` : null;
  const b = typeof bids === 'string' ? [] : bids;
  const a = typeof asks === 'string' ? [] : asks;
  if (!problem && b.length && a.length && b[0]![0] >= a[0]![0]) problem = `crossed / locked book (bid ${b[0]![0]} >= ask ${a[0]![0]})`;
  const rows = isObj(body.rows) && Array.isArray(body.rows.bids) ? Math.max((body.rows.bids as unknown[]).length, Array.isArray(body.rows.asks) ? (body.rows.asks as unknown[]).length : 0) : 0;
  return {
    state: body.state,
    detail: isStr(body.detail) ? body.detail : null,
    valid: body.valid && !problem,
    epoch: body.epoch,
    depthSeq: body.depthSeq,
    contract: c && isStr(c.localSymbol) ? c.localSymbol : null,
    exchange: c && isStr(c.exchange) ? c.exchange : null,
    lastUpdateMs: isNum(body.lastUpdateMs) ? body.lastUpdateMs : null,
    serverMs: body.serverMs,
    bids: problem ? [] : b,
    asks: problem ? [] : a,
    rows,
    problem,
  };
}

export interface DepthChange {
  seq: number;
  side: Side;
  price: number;
  size: number;
  /** VPS depth-service update time (ms). */
  t: number;
}

export interface GatewayUpdates {
  state: string;
  detail: string | null;
  valid: boolean;
  epoch: number;
  depthSeq: number;
  resync: boolean;
  serverMs: number;
  lastUpdateMs: number | null;
  changes: DepthChange[];
  rejected: number;
}

export function parseUpdates(body: unknown, root: OfpRoot): GatewayUpdates | null {
  if (!isObj(body) || body.root !== root || !isStr(body.state) || typeof body.valid !== 'boolean' || !isInt(body.epoch) || !isInt(body.depthSeq) || typeof body.resync !== 'boolean' || !Array.isArray(body.changes) || !isNum(body.serverMs)) return null;
  const changes: DepthChange[] = [];
  let rejected = 0;
  for (const c of body.changes as unknown[]) {
    if (!Array.isArray(c) || c.length < 5 || !isInt(c[0]) || (c[1] !== 'bid' && c[1] !== 'ask') || !isNum(c[2]) || !isNum(c[3]) || !isNum(c[4]) || c[3] < 0 || !onTick(c[2], root)) {
      rejected++;
      continue;
    }
    changes.push({ seq: c[0], side: c[1] === 'bid' ? 'BID' : 'ASK', price: c[2], size: c[3], t: c[4] });
  }
  return {
    state: body.state,
    detail: isStr(body.detail) ? body.detail : null,
    valid: body.valid,
    epoch: body.epoch,
    depthSeq: body.depthSeq,
    resync: body.resync,
    serverMs: body.serverMs,
    lastUpdateMs: isNum(body.lastUpdateMs) ? body.lastUpdateMs : null,
    changes,
    rejected,
  };
}

/**
 * Sequence check for one updates batch after cursor `after`: changes must continue at after+1 with no hole.
 * Returns the accepted prefix and whether a gap was found (the caller then re-synchronises from a snapshot).
 */
export function checkSequence(changes: DepthChange[], after: number): { ok: DepthChange[]; gapAt: number | null } {
  let expect = after + 1;
  const ok: DepthChange[] = [];
  for (const c of changes) {
    if (c.seq < expect) continue; // already applied (overlap) - exact duplicate by sequence
    if (c.seq !== expect) return { ok, gapAt: expect };
    ok.push(c);
    expect++;
  }
  return { ok, gapAt: null };
}

export const toDepthEvent = (c: DepthChange): DepthLevelEvent => ({ kind: 'depth', t: c.t, side: c.side, price: c.price, size: c.size });

export function toBookEvent(b: GatewayBook): BookSnapshotEvent {
  return { kind: 'book', t: b.lastUpdateMs ?? b.serverMs, bids: b.bids, asks: b.asks };
}

/** Top of the IBKR price-level book as a quote (used for the top-of-book OFI only - never to classify trades). */
export function topOfBook(t: number, bids: Map<number, number>, asks: Map<number, number>): QuoteEvent | null {
  let bid: number | null = null;
  let ask: number | null = null;
  for (const [p, s] of bids) if (s > 0 && (bid === null || p > bid)) bid = p;
  for (const [p, s] of asks) if (s > 0 && (ask === null || p < ask)) ask = p;
  if (bid === null && ask === null) return null;
  return { kind: 'quote', t, bid, ask, bidSize: bid === null ? null : bids.get(bid)!, askSize: ask === null ? null : asks.get(ask)! };
}

/* ------------------------------------------------------------------------------------------------ bars / status */

export function parseCandles(body: unknown, root: OfpRoot, tf: OfpTf): { contract: string | null; bars: BarEvent[]; rejected: number } | null {
  if (!isObj(body) || body.root !== root || !Array.isArray(body.bars) || body.timeframe !== GATEWAY_TF[tf]) return null;
  const contract = isStr(body.contract) ? body.contract : null;
  const step = TF_S[tf];
  const bars: BarEvent[] = [];
  let rejected = 0;
  for (const b of body.bars as unknown[]) {
    if (!isObj(b) || !isInt(b.time) || !isNum(b.open) || !isNum(b.high) || !isNum(b.low) || !isNum(b.close) || !isNum(b.volume) || typeof b.isClosed !== 'boolean') {
      rejected++;
      continue;
    }
    if (!b.isClosed) continue; // forming bar: never presented as a closed bar
    const okOhlc = b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.low > 0 && Number.isInteger(b.volume) && b.volume >= 0;
    if (!okOhlc || b.time % step !== 0) {
      rejected++;
      continue;
    }
    bars.push({ kind: 'bar', t: b.time * 1000, tf, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
  }
  return { contract, bars, rejected };
}

export interface DatabentoRootStatus {
  /** Bridge per-root status (LIVE, DEGRADED, STALE, CONNECTING, RECONNECTING, UNAVAILABLE, AUTH_ERROR, ...). */
  state: string;
  /** LIVE | DELAYED | STALE | OFFLINE | UNAVAILABLE (a quiet market stays LIVE through Databento heartbeats). */
  freshness: string;
  contract: string | null;
  lastEventMs: number | null;
  /** Trade-tape session state (CONNECTED / ...). */
  connection: string | null;
  detail: string | null;
  /** Bridge clock at response time (ms) - the gateway-side clock, used instead of the browser's. */
  serverMs: number | null;
}

/**
 * GET /api/databento/v1/health -> per-root status. Chosen over /api/databento/status because it costs the gateway ONE
 * upstream request (the status route makes three).
 */
export function parseDatabentoHealth(body: unknown, root: OfpRoot): DatabentoRootStatus | null {
  if (!isObj(body) || !isObj(body.instruments)) return null;
  const r = (body.instruments as Record<string, unknown>)[root];
  if (!isObj(r) || r.root !== root || !isStr(r.status)) return null;
  const tape = isObj(body.sessions) && isObj(body.sessions.tape) ? body.sessions.tape : null;
  const reasons = Array.isArray(r.reasons) ? (r.reasons as unknown[]).filter(isStr) : [];
  return {
    state: r.status,
    freshness: isStr(r.freshness) ? r.freshness : 'UNKNOWN',
    contract: isStr(r.contract) ? r.contract : null,
    lastEventMs: isNum(r.lastEventNs) ? Math.floor(r.lastEventNs / 1e6) : null,
    connection: tape && isStr(tape.state) ? tape.state : null,
    detail: reasons.length ? reasons.join(' ') : null,
    serverMs: isNum(body.timeMs) ? body.timeMs : null,
  };
}

/* ------------------------------------------------------------------------------------------------ recorded depth */

export interface HeatColumn {
  t: number;
  /** Fraction of the bucket covered by recorded observations (1 = fully covered). */
  coverage: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface RecordedDepth {
  contract: string | null;
  firstRecordedMs: number | null;
  bucketMs: number;
  from: number;
  to: number;
  columns: HeatColumn[];
}

export function parseHeatmap(body: unknown, root: OfpRoot): RecordedDepth | null {
  if (!isObj(body) || body.root !== root || body.depthType !== 'PRICE_LEVEL' || body.mbo !== false) return null;
  if (!Array.isArray(body.columns ?? []) || !isInt(body.bucketMs) || !isNum(body.from) || !isNum(body.to)) return null;
  const columns: HeatColumn[] = [];
  for (const c of (body.columns ?? []) as unknown[]) {
    if (!Array.isArray(c) || c.length < 4 || !isNum(c[0]) || !isNum(c[1])) continue;
    const bids = parseLevels([...(c[2] as unknown[])].sort((x, y) => (y as number[])[0]! - (x as number[])[0]!), root, true);
    const asks = parseLevels([...(c[3] as unknown[])].sort((x, y) => (x as number[])[0]! - (y as number[])[0]!), root, false);
    if (typeof bids === 'string' || typeof asks === 'string') continue;
    columns.push({ t: c[0], coverage: Math.max(0, Math.min(1, c[1])), bids, asks });
  }
  return {
    contract: isStr(body.contract) ? body.contract : null,
    firstRecordedMs: isNum(body.firstRecordedMs) ? body.firstRecordedMs : null,
    bucketMs: body.bucketMs,
    from: body.from,
    to: body.to,
    columns,
  };
}
