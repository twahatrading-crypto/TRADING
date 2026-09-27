/**
 * TEST DATA ONLY — an in-memory stand-in for the LOCAL Databento bridge HTTP API, used by automated tests.
 * It never talks to Databento, is never imported by production code, and there is no setting that enables it.
 */
import type { DbBar, DbBookResponse, DbCandlesResponse, DbFeedResponse, DbFrame, DbFrameInstrument, DbHealth, DbInstrumentStatus, DbRoot, DbTrade, DbTradesResponse } from '../protocol';

export const NS = 1_000_000;

export function status(root: DbRoot, o: Partial<DbInstrumentStatus> & { bookState?: DbInstrumentStatus['book']['state'] } = {}): DbInstrumentStatus {
  const { bookState, ...rest } = o;
  return {
    root,
    provider: 'Databento',
    dataset: 'GLBX.MDP3',
    subscribed: `${root}.v.0`,
    stypeIn: 'continuous',
    contract: root === 'GC' ? 'GCZ6' : 'SIZ6',
    instrumentId: root === 'GC' ? 42001 : 42002,
    status: 'LIVE',
    freshness: 'LIVE',
    reasons: [],
    book: { state: bookState ?? 'VALID', epoch: 1, reason: null, orders: 3, bidLevels: 2, askLevels: 1, counts: { outOfOrder: 0, maybeBadBook: 0, anomalies: 0, malformed: 0 }, best: [2400.0, 2400.1] },
    tape: { replaying: false, lagMs: 5, contract: root === 'GC' ? 'GCZ6' : 'SIZ6', counts: { accepted: 0, duplicates: 0, unknownSide: 0 }, volume: {}, retained: 0, lastIndex: 0 },
    candles: { bars: 0, lastClosed: null },
    lastEventNs: 1_790_000_000_000 * NS,
    lastRecvNs: 1_790_000_000_001 * NS,
    lastEventAgeMs: 20,
    counts: { tapeGaps: 0, mboDuplicates: 0 },
    roll: null,
    ...rest,
  };
}

export class FakeBridge {
  cursor = 0;
  frames: DbFrame[] = [];
  startedAtMs = 1;
  maxFrames = 1000;
  statuses: Record<DbRoot, DbInstrumentStatus> = { GC: status('GC'), SI: status('SI') };
  tape: Record<DbRoot, DbTrade[]> = { GC: [], SI: [] };
  bars: Record<DbRoot, DbBar[]> = { GC: [], SI: [] };
  books: Record<DbRoot, { epoch: number; bids: [number, number, number][]; asks: [number, number, number][] } | null> = { GC: null, SI: null };
  index: Record<DbRoot, number> = { GC: 0, SI: 0 };
  calls: string[] = [];
  down = false;

  trade(root: DbRoot, price: number, size: number, aggressor: DbTrade['aggressor'], tsMs: number, contract?: string): DbTrade {
    const i = ++this.index[root];
    const t: DbTrade = { i, tsEventNs: tsMs * NS, tsRecvNs: (tsMs + 1) * NS, price, size, side: aggressor === 'BUY' ? 'B' : aggressor === 'SELL' ? 'A' : 'N', aggressor, sequence: i, key: `${root}-${i}`, contract: contract ?? this.statuses[root].contract ?? '' };
    this.tape[root].push(t);
    return t;
  }

  frame(parts: Partial<Record<DbRoot, Partial<DbFrameInstrument>>>): DbFrame {
    this.cursor += 1;
    const instruments: DbFrame['instruments'] = {};
    for (const root of ['GC', 'SI'] as DbRoot[]) {
      const p = parts[root] ?? {};
      instruments[root] = { contract: this.statuses[root].contract, instrumentId: this.statuses[root].instrumentId, status: this.statuses[root], ...p };
    }
    const f = { cursor: this.cursor, timeMs: 1_790_000_000_000 + this.cursor * 250, instruments };
    this.frames.push(f);
    if (this.frames.length > this.maxFrames) this.frames.shift();
    return f;
  }

  private guard(name: string) {
    this.calls.push(name);
    if (this.down) throw new TypeError('fetch failed');
  }

  health = async (): Promise<DbHealth> => {
    this.guard('health');
    return {
      provider: 'Databento',
      dataset: 'GLBX.MDP3',
      contractMode: 'auto',
      sessions: {
        book: { state: 'CONNECTED', connectedAtMs: 1, reconnects: 0, resyncs: 0, lastMessageMs: 1, lastError: null, reconnectStorm: false },
        tape: { state: 'CONNECTED', connectedAtMs: 1, reconnects: 0, resyncs: 0, lastMessageMs: 1, lastError: null, reconnectStorm: false },
      },
      instruments: this.statuses,
      rolls: [],
      metrics: { cursor: this.cursor, ingestRatePerSec: 0, queueDepth: 0, maxQueueDepth: 0, ingestLagMs: 5 },
      retention: { maxTrades: 100000, maxFrames: this.maxFrames, publishMs: 250, replayHours: 24 },
      timeMs: 1,
      bridge: { version: '1.0.0', startedAtMs: this.startedAtMs, heartbeatAtMs: 1 },
    };
  };
  feed = async (cursor: number, roots: DbRoot[]): Promise<DbFeedResponse> => {
    this.guard('feed');
    const oldest = this.frames[0]?.cursor ?? this.cursor + 1;
    if (cursor < oldest - 1 || cursor > this.cursor) return { cursor: this.cursor, reset: true, frames: [] };
    return { cursor: this.cursor, reset: false, frames: this.frames.filter((f) => f.cursor > cursor).map((f) => ({ ...f, instruments: Object.fromEntries(Object.entries(f.instruments).filter(([k]) => roots.includes(k as DbRoot))) })) };
  };
  book = async (root: DbRoot): Promise<DbBookResponse> => {
    this.guard('book');
    const b = this.books[root];
    const st = this.statuses[root];
    return { root, contract: st.contract, instrumentId: st.instrumentId, cursor: this.cursor, state: st.book.state, epoch: b?.epoch ?? 0, book: b && st.book.state === 'VALID' ? { bids: b.bids, asks: b.asks } : null, lastEventNs: st.lastEventNs, lastRecvNs: st.lastRecvNs };
  };
  trades = async (root: DbRoot, after: number, limit = 20000): Promise<DbTradesResponse> => {
    this.guard('trades');
    const all = this.tape[root];
    const first = all[0]?.i ?? this.index[root] + 1;
    return { root, contract: this.statuses[root].contract, trades: all.filter((t) => t.i > after).slice(0, limit), complete: after + 1 >= first || after >= this.index[root], lastIndex: this.index[root], cursor: this.cursor };
  };
  candles = async (root: DbRoot, tf: string): Promise<DbCandlesResponse> => {
    this.guard(`candles:${tf}`);
    const sec = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 }[tf] ?? 60;
    const out: DbBar[] = [];
    for (const b of this.bars[root]) {
      const t = b.time - (b.time % sec);
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, b.high);
        last.low = Math.min(last.low, b.low);
        last.close = b.close;
        last.volume += b.volume;
      } else out.push({ ...b, time: t });
    }
    return { root, contract: this.statuses[root].contract, instrumentId: this.statuses[root].instrumentId, timeframe: tf, bars: out, source: 'databento', schema: 'ohlcv-1m', cursor: this.cursor };
  };
}
