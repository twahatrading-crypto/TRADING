import type { InstrumentId } from '../../types/instruments';
import { addDays, getZonedParts, zonedTimeToUtc } from '../../utils/time';
import { analyzeCandle, exhaustion, rowIndex, type CandleAnalysis, type CandleData } from './analysis';
import {
  DEFAULT_FP_SETTINGS,
  FP_DEDUPE_MEMORY,
  FP_DEGRADED_WINDOW_MS,
  FP_MAX_CANDLES,
  FP_MAX_EVENTS,
  FP_MAX_LEVELS,
  FP_SESSION_START_HOUR,
  FP_SESSION_TZ,
  FP_TF_SECONDS,
  FP_TIMEFRAMES,
  settingsKey,
  type FootprintSettings,
} from './config';
import {
  NO_FOOTPRINT_CAPS,
  type FPCandle,
  type FPEvent,
  type FPFeedStatus,
  type FPImbalance,
  type FPIntegrity,
  type FPStack,
  type FPTimeframe,
  type FPTradeMsg,
  type FootprintCapabilities,
  type FootprintMsg,
  type FootprintSnapshot,
} from './types';

/*
 * VOLUME FOOTPRINT ENGINE (pure, React-free, incremental). Pipeline per message:
 *   ingest → integrity (duplicates / sequence / late / disconnect / contract) → classification (as the
 *   provider declared it) → aggregation into M1 · M5 · M15 · M30 · H1 footprint candles → detection at
 *   candle close.
 *
 * Knowledge: messages are processed in RECEIVE order; replay to T = the messages received by T.
 * Candles close on the EXCHANGE clock: a trade or heartbeat whose exchange time is ≥ the candle end.
 * A closed candle is FINAL: its rows, totals and detections never change afterwards.
 *
 * Integrity rules (nothing is ever repaired with invented trades):
 *   duplicate     same trade id (or, without ids, same sequence number) → dropped, counted
 *   sequence gap  seq > last + 1 → counted (missing = seq − last − 1); the candle is flagged GAP
 *   out-of-order  seq < last (or exchange time going back on an unsequenced feed) → counted; applied only
 *                 while its M1 candle is still open
 *   late          exchange time inside an already-closed M1 candle → EXCLUDED (never repaints history), logged
 *   disconnect    open candles are flagged INTERRUPTED; reconnect is logged
 *   contract      a new contract starts a NEW footprint history (contracts are never combined)
 * Classification: BUY / SELL only when the provider declares an aggressor source (EXCHANGE / CLASSIFIED)
 * and the trade carries that side; everything else is UNKNOWN (kept separate, never split).
 */

export interface FPEngineOptions {
  instrumentId: InstrumentId;
  tickSize: number;
  settings?: FootprintSettings;
}

interface TfState {
  closed: CandleAnalysis[];
  cur: CandleData | null;
  imbalances: FPImbalance[];
  stacks: FPStack[];
  events: FPEvent[];
}

export function sessionStartOf(ms: number): number {
  const p = getZonedParts(ms, FP_SESSION_TZ);
  let s = zonedTimeToUtc(p, FP_SESSION_START_HOUR, 0, FP_SESSION_TZ);
  if (s > ms) s = zonedTimeToUtc(addDays(p, -1), FP_SESSION_START_HOUR, 0, FP_SESSION_TZ);
  return s;
}

const push = <T>(arr: T[], x: T, max: number) => {
  arr.push(x);
  if (arr.length > max) arr.splice(0, arr.length - max);
};

export class FootprintEngine {
  readonly instrumentId: InstrumentId;
  readonly tick: number;
  readonly settings: FootprintSettings;
  caps: FootprintCapabilities = NO_FOOTPRINT_CAPS;
  private feed: FPFeedStatus = 'CONNECTING';
  private contract: string | null = null;
  private previousContracts: string[] = [];
  private tf: Record<FPTimeframe, TfState> = FootprintEngine.emptyTfs();
  private integrityEvents: FPEvent[] = [];
  private seen = new Set<string>();
  private seenQ: string[] = [];
  private lastSeq: number | null = null;
  private lastExch: number | null = null;
  private lastRecv: number | null = null;
  private latency: number | null = null;
  private closedUntil = -Infinity;
  private problemAt: number | null = null;
  private counts = { accepted: 0, duplicates: 0, outOfOrder: 0, late: 0, gaps: 0, missing: 0, disconnects: 0, reconnects: 0, contractChanges: 0, statusSeq: 0 };
  private cvd = 0;
  private unknownVol = 0;
  private sessionStart: number | null = null;
  private sessionDelta = 0;
  private lastPrice: number | null = null;
  private curCache = new Map<FPTimeframe, { key: string; a: CandleAnalysis }>();
  /** Messages processed (diagnostics). */
  processed = 0;

  constructor(o: FPEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.tick = o.tickSize;
    this.settings = { ...(o.settings ?? DEFAULT_FP_SETTINGS) };
  }
  private static emptyTfs(): Record<FPTimeframe, TfState> {
    const o = {} as Record<FPTimeframe, TfState>;
    for (const tf of FP_TIMEFRAMES) o[tf] = { closed: [], cur: null, imbalances: [], stacks: [], events: [] };
    return o;
  }

  processAll(ms: readonly FootprintMsg[]): void {
    for (const m of ms) this.process(m);
  }

  process(m: FootprintMsg): void {
    if (m.instrumentId !== this.instrumentId) return;
    this.processed += 1;
    if (this.lastRecv === null || m.recvTime > this.lastRecv) this.lastRecv = m.recvTime;
    switch (m.type) {
      case 'caps':
        this.caps = { ...m.caps };
        return;
      case 'status':
        return this.status(m.status, m.recvTime, m.detail);
      case 'heartbeat':
        this.advance(m.exchTime);
        if (this.lastExch === null || m.exchTime > this.lastExch) this.lastExch = m.exchTime;
        return;
      case 'trade':
        return this.trade(m);
    }
  }

  private integrityEvent(e: Omit<FPEvent, 'tf' | 'candleId'>): void {
    push(this.integrityEvents, { ...e, tf: null, candleId: null }, FP_MAX_EVENTS);
  }

  private status(s: FPFeedStatus, recv: number, detail: string | null): void {
    const n = ++this.counts.statusSeq;
    if (s === 'DISCONNECTED' && this.feed !== 'DISCONNECTED') {
      this.counts.disconnects += 1;
      this.problemAt = this.lastExch ?? recv;
      for (const tf of FP_TIMEFRAMES) if (this.tf[tf].cur) this.tf[tf].cur!.interrupted = true;
      this.integrityEvent({ id: `STATUS:${n}:DISCONNECTED`, type: 'FEED DISCONNECTED', time: Math.floor(recv / 1000), price: null, volume: null, delta: null, evidence: `Trade feed disconnected${detail ? ` (${detail})` : ''}. Open candles flagged INTERRUPTED; missing trades are never filled.` });
    }
    if (s === 'RECONNECTED' || (s === 'LIVE' && this.feed === 'DISCONNECTED')) {
      this.counts.reconnects += 1;
      this.integrityEvent({ id: `STATUS:${n}:RECONNECTED`, type: 'FEED RECONNECTED', time: Math.floor(recv / 1000), price: null, volume: null, delta: null, evidence: `Trade feed reconnected${detail ? ` (${detail})` : ''}.` });
      this.feed = 'LIVE';
      return;
    }
    this.feed = s;
  }

  private resetContract(next: string, t: FPTradeMsg): void {
    const old = this.contract;
    if (old) {
      this.previousContracts.push(old);
      this.counts.contractChanges += 1;
      this.integrityEvent({ id: `CONTRACT:${old}:${next}:${t.recvTime}`, type: 'CONTRACT CHANGED', time: Math.floor(t.exchTime / 1000), price: null, volume: null, delta: null, evidence: `Contract changed ${old} → ${next}. A new footprint history starts; ${old} and ${next} are never combined.` });
    }
    this.contract = next;
    this.tf = FootprintEngine.emptyTfs();
    this.curCache.clear();
    this.lastSeq = null;
    this.closedUntil = -Infinity;
    this.cvd = 0;
    this.unknownVol = 0;
    this.sessionStart = null;
    this.sessionDelta = 0;
    this.seen.clear();
    this.seenQ = [];
  }

  private remember(key: string): void {
    this.seen.add(key);
    this.seenQ.push(key);
    if (this.seenQ.length > FP_DEDUPE_MEMORY) this.seen.delete(this.seenQ.shift()!);
  }

  private trade(t: FPTradeMsg): void {
    if (!this.caps.trades || !(t.size > 0) || !Number.isFinite(t.price)) return;
    if (this.contract !== t.contract) this.resetContract(t.contract, t);
    const key = t.tradeId !== null ? `id:${t.tradeId}` : t.seq !== null ? `seq:${t.seq}` : null;
    if (key && this.seen.has(key)) {
      this.counts.duplicates += 1;
      return;
    }
    if (key) this.remember(key);
    const exchSec = Math.floor(t.exchTime / 1000);
    if (t.seq !== null) {
      if (this.lastSeq !== null && t.seq > this.lastSeq + 1) {
        const missing = t.seq - this.lastSeq - 1;
        this.counts.gaps += 1;
        this.counts.missing += missing;
        this.problemAt = t.exchTime;
        this.markGap = true;
        this.integrityEvent({ id: `GAP:${this.contract}:${this.lastSeq}:${t.seq}`, type: 'SEQUENCE GAP', time: exchSec, price: t.price, volume: null, delta: null, evidence: `Trade sequence ${this.lastSeq} → ${t.seq}: ${missing} trade(s) missing. Not filled — candle flagged GAP.` });
      } else if (this.lastSeq !== null && t.seq < this.lastSeq) this.counts.outOfOrder += 1;
      if (this.lastSeq === null || t.seq > this.lastSeq) this.lastSeq = t.seq;
    } else if (this.lastExch !== null && t.exchTime < this.lastExch) this.counts.outOfOrder += 1;

    const m1Open = this.tf.M1.cur ? this.tf.M1.cur.time * 1000 : -Infinity;
    if (t.exchTime < this.closedUntil || t.exchTime < m1Open) {
      this.counts.late += 1;
      this.problemAt = this.lastExch ?? t.exchTime;
      const m1 = this.tf.M1.cur;
      if (m1) m1.late += 1;
      this.integrityEvent({ id: `LATE:${this.contract}:${key ?? `${t.exchTime}:${this.counts.late}`}`, type: 'LATE TRADE EXCLUDED', time: exchSec, price: t.price, volume: t.size, delta: null, evidence: `Trade ${t.size} @ ${t.price} arrived after its M1 candle had closed (or before the open M1 candle) — excluded so closed footprints never repaint.` });
      return;
    }

    this.advance(t.exchTime);
    const side = this.caps.aggressor !== 'NONE' && t.aggressor !== 'UNKNOWN' ? t.aggressor : 'UNKNOWN';
    const d = side === 'BUY' ? t.size : side === 'SELL' ? -t.size : 0;
    const idx = rowIndex(t.price, this.tick, this.settings.rowTicks);
    const large = t.size >= this.settings.largeTrade;
    for (const tf of FP_TIMEFRAMES) {
      const st = this.tf[tf];
      const sec = FP_TF_SECONDS[tf];
      const open = Math.floor(exchSec / sec) * sec;
      let c = st.cur;
      if (!c) {
        c = { id: `${this.contract}:${tf}:${open}`, tf, contract: this.contract!, time: open, endMs: (open + sec) * 1000, open: t.price, high: t.price, low: t.price, close: t.price, cells: new Map(), bid: 0, ask: 0, unknown: 0, trades: 0, run: 0, maxDelta: 0, minDelta: 0, largeTrades: 0, closed: false, gap: false, interrupted: false, late: 0 };
        st.cur = c;
      }
      if (t.price > c.high) c.high = t.price;
      if (t.price < c.low) c.low = t.price;
      c.close = t.price;
      let cell = c.cells.get(idx);
      if (!cell) c.cells.set(idx, (cell = { bid: 0, ask: 0, unknown: 0 }));
      if (side === 'BUY') {
        cell.ask += t.size;
        c.ask += t.size;
      } else if (side === 'SELL') {
        cell.bid += t.size;
        c.bid += t.size;
      } else {
        cell.unknown += t.size;
        c.unknown += t.size;
      }
      c.run += d;
      if (c.run > c.maxDelta) c.maxDelta = c.run;
      if (c.run < c.minDelta) c.minDelta = c.run;
      c.trades += 1;
      if (large) c.largeTrades += 1;
      if (this.markGap) c.gap = true;
    }
    this.markGap = false;
    this.counts.accepted += 1;
    this.lastPrice = t.price;
    this.cvd += d;
    if (side === 'UNKNOWN') this.unknownVol += t.size;
    const ss = sessionStartOf(t.exchTime);
    if (ss !== this.sessionStart) {
      this.sessionStart = ss;
      this.sessionDelta = 0;
    }
    this.sessionDelta += d;
    if (this.lastExch === null || t.exchTime > this.lastExch) this.lastExch = t.exchTime;
    this.latency = t.recvTime - t.exchTime;
    if (large)
      this.integrityEvent({ id: `LT:${this.contract}:${key ?? `${t.exchTime}:${this.counts.accepted}`}`, type: 'LARGE TRADE', time: exchSec, price: t.price, volume: t.size, delta: side === 'UNKNOWN' ? null : d, evidence: `Single ${side === 'UNKNOWN' ? 'UNCLASSIFIED' : side === 'BUY' ? 'aggressive BUY (at ask)' : 'aggressive SELL (at bid)'} trade of ${t.size} ≥ threshold ${this.settings.largeTrade}` });
  }
  private markGap = false;

  /** Close every candle whose end is at or before the exchange time. */
  private advance(exchMs: number): void {
    for (const tf of FP_TIMEFRAMES) {
      const c = this.tf[tf].cur;
      if (c && c.endMs <= exchMs) this.close(tf);
    }
  }

  private close(tf: FPTimeframe): void {
    const st = this.tf[tf];
    const c = st.cur!;
    c.closed = true;
    st.cur = null;
    this.curCache.delete(tf);
    if (tf === 'M1' && c.endMs > this.closedUntil) this.closedUntil = c.endMs;
    const a = analyzeCandle(c, this.settings, this.tick);
    const prev = st.closed[st.closed.length - 1]?.candle ?? null;
    const exh = exhaustion(a, prev, this.settings);
    a.candle.exhaustion = exh.length;
    const k = a.candle;
    // Forward-only lifecycle of earlier stacks / imbalances (evidence numbers never change).
    for (const x of [...st.stacks, ...st.imbalances]) {
      if (x.state === 'CONSUMED') continue;
      const low = 'low' in x ? x.low : x.price;
      const high = 'high' in x ? x.high : x.price;
      const t = k.time + FP_TF_SECONDS[tf];
      if (x.side === 'BUY' ? k.close < low : k.close > high) {
        x.state = 'CONSUMED';
        x.consumedAt = t;
      } else if (x.state === 'ACTIVE' && (x.side === 'BUY' ? k.low <= high : k.high >= low)) {
        x.state = 'TESTED';
        x.testedAt = t;
      }
    }
    const events: FPEvent[] = [];
    for (const s of a.stacks)
      events.push({ id: s.id, type: s.side === 'BUY' ? 'STACKED BUY IMBALANCE' : 'STACKED SELL IMBALANCE', tf, time: s.time, price: s.side === 'BUY' ? s.low : s.high, volume: null, delta: k.delta, candleId: k.id, evidence: `${s.levels} consecutive ${s.side} imbalance rows ${s.low}–${s.high} (ratios ${s.ratios.map((r) => (r === null ? '∞' : r.toFixed(1))).join(' / ')} ≥ ${Math.round(this.settings.imbalanceRatio * 100)}%)` });
    events.push(...a.candidates, ...exh, ...this.divergence(st, k));
    for (const e of events) push(st.events, e, FP_MAX_EVENTS);
    for (const s of a.stacks) push(st.stacks, s, FP_MAX_LEVELS);
    for (const i of a.imbalances) push(st.imbalances, i, FP_MAX_LEVELS);
    push(st.closed, a, FP_MAX_CANDLES[tf]);
  }

  /*
   * DELTA DIVERGENCE CANDIDATE (same timeframe, closed candles only):
   *   high: the candle's high exceeds every high of the previous `divergenceLookback` candles, its delta is ≤ 0
   *         and below the delta of the candle that held the previous highest high (delta weakens).
   *   low:  mirror (new low, delta ≥ 0 and above the delta of the previous lowest-low candle).
   */
  private divergence(st: TfState, k: FPCandle): FPEvent[] {
    const L = this.settings.divergenceLookback;
    const prev = st.closed.slice(-L).map((a) => a.candle);
    if (prev.length < L || k.bid + k.ask === 0) return [];
    const out: FPEvent[] = [];
    const t = k.time + FP_TF_SECONDS[k.tf];
    const hiRef = prev.reduce((m, c) => (c.high >= m.high ? c : m));
    const loRef = prev.reduce((m, c) => (c.low <= m.low ? c : m));
    if (k.high > hiRef.high && k.delta <= 0 && k.delta < hiRef.delta)
      out.push({ id: `${k.id}:DIV:HIGH`, type: 'DELTA DIVERGENCE CANDIDATE', tf: k.tf, time: t, price: k.high, volume: k.volume, delta: k.delta, candleId: k.id, evidence: `New ${L}-candle high ${k.high} > ${hiRef.high} while delta weakened: ${k.delta} vs ${hiRef.delta} at the previous high` });
    if (k.low < loRef.low && k.delta >= 0 && k.delta > loRef.delta)
      out.push({ id: `${k.id}:DIV:LOW`, type: 'DELTA DIVERGENCE CANDIDATE', tf: k.tf, time: t, price: k.low, volume: k.volume, delta: k.delta, candleId: k.id, evidence: `New ${L}-candle low ${k.low} < ${loRef.low} while delta strengthened: ${k.delta} vs ${loRef.delta} at the previous low` });
    return out;
  }

  /* ------------------------------- queries ------------------------------- */

  private curAnalysis(tf: FPTimeframe): CandleAnalysis | null {
    const c = this.tf[tf].cur;
    if (!c) return null;
    const key = `${c.id}:${c.trades}:${c.late}:${c.gap}:${c.interrupted}`;
    const hit = this.curCache.get(tf);
    if (hit && hit.key === key) return hit.a;
    const a = analyzeCandle(c, this.settings, this.tick);
    this.curCache.set(tf, { key, a });
    return a;
  }
  /** Closed candles (bounded) + the developing candle last. Closed entries are stable objects. */
  candles(tf: FPTimeframe): FPCandle[] {
    const out = this.tf[tf].closed.map((a) => a.candle);
    const cur = this.curAnalysis(tf);
    if (cur) out.push(cur.candle);
    return out;
  }
  closedCount(tf: FPTimeframe): number {
    return this.tf[tf].closed.length;
  }
  imbalances(tf: FPTimeframe): readonly FPImbalance[] {
    return this.tf[tf].imbalances;
  }
  stacks(tf: FPTimeframe): readonly FPStack[] {
    return this.tf[tf].stacks;
  }
  /** Candle events of `tf` merged with instrument-level (integrity / large trade) events, oldest first. */
  events(tf: FPTimeframe): FPEvent[] {
    return [...this.tf[tf].events, ...this.integrityEvents].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  integrity(): FPIntegrity {
    const c = this.counts;
    const reasons: string[] = [];
    let state: FPIntegrity['state'] = 'GOOD';
    if (!this.caps.trades) reasons.push('Provider does not supply individual exchange trades.');
    if (this.feed === 'DISCONNECTED') reasons.push('Trade feed disconnected.');
    if (this.feed === 'DATA_UNAVAILABLE') reasons.push('Provider reports trade data unavailable.');
    if (c.accepted === 0) reasons.push('No trades received yet.');
    if (reasons.length) state = 'UNAVAILABLE';
    else {
      if (this.problemAt !== null && this.lastExch !== null && this.lastExch - this.problemAt <= FP_DEGRADED_WINDOW_MS) reasons.push('Gap / late trade / disconnect in the last 30 minutes.');
      if (!this.caps.sequenced) reasons.push('Feed is not sequenced — missing trades cannot be detected.');
      if (!this.caps.exchangeTimestamps) reasons.push('No exchange timestamps — receive time used.');
      if (reasons.length) state = 'DEGRADED';
    }
    return { state, reasons, accepted: c.accepted, duplicates: c.duplicates, outOfOrder: c.outOfOrder, late: c.late, gaps: c.gaps, missing: c.missing, disconnects: c.disconnects, reconnects: c.reconnects, contractChanges: c.contractChanges, lastSeq: this.lastSeq, lastExchTime: this.lastExch, lastRecvTime: this.lastRecv, latencyMs: this.latency, feed: this.feed };
  }

  snapshot(): FootprintSnapshot {
    const integrity = this.integrity();
    let status: FootprintSnapshot['status'] = 'ACTIVE';
    let statusReason: string | null = null;
    if (!this.caps.trades) {
      status = 'UNAVAILABLE';
      statusReason = 'Missing capability: individual exchange trades (time & sales).';
    } else if (this.counts.accepted === 0) {
      status = 'UNAVAILABLE';
      statusReason = 'No exchange trades received yet.';
    } else if (this.caps.aggressor === 'NONE') {
      status = 'UNCLASSIFIED';
      statusReason = 'Missing capability: aggressor side. Bid × Ask cannot be built — all volume stays UNKNOWN.';
    }
    return {
      instrumentId: this.instrumentId,
      contract: this.contract,
      previousContracts: [...this.previousContracts],
      caps: { ...this.caps },
      status,
      statusReason,
      knowledgeTime: this.lastRecv,
      lastPrice: this.lastPrice,
      integrity,
      cvd: this.cvd,
      cvdAvailability: this.caps.aggressor === 'NONE' || this.counts.accepted === 0 ? 'UNAVAILABLE' : this.unknownVol > 0 ? 'PARTIAL' : 'FULL',
      sessionStart: this.sessionStart === null ? null : Math.floor(this.sessionStart / 1000),
      sessionDelta: this.sessionDelta,
      unknownVolume: this.unknownVol,
      settingsKey: settingsKey(this.settings),
      mtf: FP_TIMEFRAMES.map((tf) => ({ tf, candles: this.tf[tf].closed.length + (this.tf[tf].cur ? 1 : 0), current: this.curAnalysis(tf)?.candle ?? null, lastClosed: this.tf[tf].closed[this.tf[tf].closed.length - 1]?.candle ?? null })),
    };
  }

  /** Full deterministic state (parity / anti-repaint audits). */
  fullState() {
    const byTf: Record<string, unknown> = {};
    for (const tf of FP_TIMEFRAMES) byTf[tf] = { candles: this.candles(tf), imbalances: this.tf[tf].imbalances, stacks: this.tf[tf].stacks, events: this.tf[tf].events };
    return { snapshot: this.snapshot(), integrityEvents: this.integrityEvents, byTf };
  }
}
