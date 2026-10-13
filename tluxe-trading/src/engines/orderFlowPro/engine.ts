import { HEAT_BUCKET_MS, MAX_ALERTS, MAX_QUOTE_AGE_MS, MAX_TAPE, OFP_TF_MS, OFP_TFS, OFP_TICK, type OfpSession } from './config';
import { classifyQuoteRule, toTick } from './classify';
import { DepthRecorder, type StrongLevel } from './depthRecorder';
import { FootprintBuilder, type FootprintBar } from './footprint';
import { cvdSeries, deltaSeries, OfiTracker, volumeSeries, type SeriesPoint } from './metrics';
import { inWindow, sessionWindow, type SessionWindow } from './nyTime';
import { ProfileAccumulator, type VolumeProfileResult } from './profile';
import { detectReversals, type ReversalSignal } from './reversal';
import type { Aggressor, FeedState, OfpEvent, OfpFrame, OfpRoot, OfpTf, QuoteEvent, SourceStatus, TradeEvent } from './types';

/* ============================================================================
 * Order Flow Pro engine: one instance per root (GC or SI). Pure state machine - no timers, no network, no React.
 * Bounded memory (bars per TF, heat columns, tape, alerts). A contract change clears everything (contracts are
 * never combined). Sequence gaps / reset events invalidate the book until the next snapshot.
 * ========================================================================== */

export interface Alert {
  id: string;
  t: number;
  kind: 'REVERSAL' | 'STRONG_LEVEL' | 'FEED' | 'GAP';
  text: string;
  tone: 'bull' | 'bear' | 'warn' | 'info';
}

export interface SessionStats {
  window: SessionWindow;
  volume: number;
  buy: number;
  sell: number;
  unknown: number;
  unknownShare: number;
  delta: number;
  trades: number;
  profile: VolumeProfileResult;
  lateExcluded: number;
  gaps: number;
  depthEvents: number;
  heatColumns: number;
  ignoredDepthWhileInvalid: number;
}

export interface OfpView {
  root: OfpRoot;
  tf: OfpTf;
  status: SourceStatus;
  bars: FootprintBar[];
  volume: SeriesPoint[];
  delta: SeriesPoint[];
  cvd: SeriesPoint[];
  ofi: SeriesPoint[];
  book: { bids: Array<[number, number]>; asks: Array<[number, number]> };
  bookValid: boolean;
  quote: QuoteEvent | null;
  last: number | null;
  strong: StrongLevel[];
  reversals: ReversalSignal[];
  tape: TradeEvent[];
  alerts: Alert[];
  stats: SessionStats;
  gaps: Array<{ from: number; to: number; reason: string }>;
  recorder: DepthRecorder;
  version: number;
}

export const STRONG_PARAMS = { minRelative: 2.5, minPersistMs: 60_000, lookbackMs: 30 * 60_000 };

const statusKey = (s: SourceStatus) => `${s.feed}|${s.marketDataType}|${s.contract?.localSymbol}`;

export class OfpEngine {
  readonly tick: number;
  private builders: Record<OfpTf, FootprintBuilder>;
  private ofiByTf: Record<OfpTf, Map<number, number>>;
  readonly recorder: DepthRecorder;
  private ofi = new OfiTracker();
  private profiles = new Map<string, ProfileAccumulator>();
  private sessionTotals = new Map<string, { buy: number; sell: number; unknown: number; trades: number }>();
  private quote: QuoteEvent | null = null;
  private last: number | null = null;
  private tape: TradeEvent[] = [];
  private alerts: Alert[] = [];
  private gaps: Array<{ from: number; to: number; reason: string }> = [];
  private seenSignals = new Set<string>();
  private seenStrong = new Set<string>();
  private lastSeq: number | null = null;
  private clock = 0;
  status: SourceStatus;
  version = 0;
  private cache: { key: string; view: OfpView } | null = null;

  constructor(readonly root: OfpRoot, status?: SourceStatus) {
    this.tick = OFP_TICK[root];
    this.builders = Object.fromEntries(OFP_TFS.map((tf) => [tf, new FootprintBuilder(OFP_TF_MS[tf], this.tick)])) as Record<OfpTf, FootprintBuilder>;
    this.ofiByTf = Object.fromEntries(OFP_TFS.map((tf) => [tf, new Map<number, number>()])) as Record<OfpTf, Map<number, number>>;
    this.recorder = new DepthRecorder(this.tick, HEAT_BUCKET_MS);
    this.status = status ?? offlineStatus(root, 'BACKEND_OFFLINE', ['Order Flow Pro backend not reachable']);
  }

  /** Replace the source status. A contract change clears all state; feed transitions are logged as alerts. */
  setStatus(s: SourceStatus, now: number) {
    const prev = this.status;
    if (prev.contract && s.contract && prev.contract.localSymbol !== s.contract.localSymbol) this.reset();
    if (statusKey(prev) !== statusKey(s)) {
      this.pushAlert({ id: `feed:${now}:${s.feed}`, t: now, kind: 'FEED', text: `Feed ${prev.feed} → ${s.feed}${s.marketDataType ? ` (${s.marketDataType})` : ''}`, tone: s.feed === 'LIVE' ? 'info' : 'warn' });
    }
    this.status = s;
    this.version++;
  }

  apply(frame: OfpFrame) {
    if (frame.root !== this.root) return;
    if (this.lastSeq !== null && frame.seq !== this.lastSeq + 1 && frame.events.length) {
      const at = frame.events[0] && 't' in frame.events[0] ? frame.events[0].t : this.clock;
      this.applyEvent({ kind: 'gap', from: this.clock, to: at, reason: `Sequence gap ${this.lastSeq} → ${frame.seq}` });
    }
    for (const ev of frame.events) this.applyEvent(ev);
    if (frame.events.length) this.lastSeq = frame.seq + frame.events.length - 1;
    this.version++;
  }

  private applyEvent(ev: OfpEvent) {
    switch (ev.kind) {
      case 'quote': {
        this.clock = Math.max(this.clock, ev.t);
        this.quote = ev;
        const e = this.ofi.add(ev);
        if (e !== null) for (const tf of OFP_TFS) {
          const k = Math.floor(ev.t / OFP_TF_MS[tf]) * OFP_TF_MS[tf];
          const m = this.ofiByTf[tf];
          m.set(k, (m.get(k) ?? 0) + e);
        }
        break;
      }
      case 'trade':
        this.clock = Math.max(this.clock, ev.t);
        this.addTrade(ev);
        break;
      case 'depth':
        this.clock = Math.max(this.clock, ev.t);
        this.recorder.applyLevel(ev);
        break;
      case 'book':
        this.clock = Math.max(this.clock, ev.t);
        this.recorder.applySnapshot(ev);
        break;
      case 'gap':
        this.recorder.applyGap(ev);
        this.ofi.reset();
        this.gaps.push({ from: ev.from, to: ev.to, reason: ev.reason });
        if (this.gaps.length > 200) this.gaps.shift();
        this.pushAlert({ id: `gap:${ev.from}`, t: ev.to, kind: 'GAP', text: `Data gap: ${ev.reason}`, tone: 'warn' });
        break;
      case 'bar':
        this.builders[ev.tf].addBar(ev);
        break;
    }
  }

  private addTrade(tr: TradeEvent) {
    // Earlier-session print loaded on demand: older slots only; never the tape, never the last price.
    if (tr.history) {
      for (const tf of OFP_TFS) this.builders[tf].addHistoryTrade(tr);
      this.addToSession(tr);
      return;
    }
    // The backend already classified the print. A trade without a method is classified here by the same quote rule.
    let t = tr;
    if (tr.method === 'NONE' && tr.aggressor === 'UNKNOWN' && this.quote) {
      const a: Aggressor = classifyQuoteRule(tr.price, this.quote, tr.t, this.tick, MAX_QUOTE_AGE_MS);
      t = { ...tr, aggressor: a, method: 'QUOTE_RULE', bid: this.quote.bid, ask: this.quote.ask };
    }
    this.last = t.price;
    for (const tf of OFP_TFS) this.builders[tf].addTrade(t);
    this.addToSession(t);
    this.tape.push(t);
    if (this.tape.length > MAX_TAPE) this.tape.splice(0, this.tape.length - MAX_TAPE);
  }

  /** Session profile + totals: plain sums, so the order prints arrive in does not matter. */
  private addToSession(t: TradeEvent) {
    for (const s of ['ETH', 'RTH'] as const) {
      const w = sessionWindow(t.t, s);
      if (!inWindow(t.t, w)) continue;
      const key = `${s}:${w.start}`;
      let acc = this.profiles.get(key);
      if (!acc) {
        this.profiles.set(key, (acc = new ProfileAccumulator()));
        this.sessionTotals.set(key, { buy: 0, sell: 0, unknown: 0, trades: 0 });
        // keep only the two most recent windows per session type
        const keys = [...this.profiles.keys()].filter((k) => k.startsWith(`${s}:`)).sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
        while (keys.length > 2) {
          const k = keys.shift()!;
          this.profiles.delete(k);
          this.sessionTotals.delete(k);
        }
      }
      acc.add(toTick(t.price, this.tick), t.size, t.aggressor);
      const tot = this.sessionTotals.get(key)!;
      tot.trades++;
      if (t.aggressor === 'BUY') tot.buy += t.size;
      else if (t.aggressor === 'SELL') tot.sell += t.size;
      else tot.unknown += t.size;
    }
  }

  private pushAlert(a: Alert) {
    if (this.alerts.some((x) => x.id === a.id)) return;
    this.alerts.push(a);
    if (this.alerts.length > MAX_ALERTS) this.alerts.splice(0, this.alerts.length - MAX_ALERTS);
  }

  /** Advance time (closes bars, integrates the recorded book). `now` = source clock, never the wall clock for DEMO. */
  advance(now: number) {
    this.clock = Math.max(this.clock, now);
    for (const tf of OFP_TFS) this.builders[tf].closeUpTo(now);
    this.recorder.integrate(now);
    this.version++;
  }

  get now() {
    return this.clock;
  }

  view(tf: OfpTf, session: OfpSession): OfpView {
    const key = `${this.version}|${tf}|${session}`;
    if (this.cache?.key === key) return this.cache.view;
    const now = this.clock;
    const win = sessionWindow(now || Date.now(), session);
    const bars = this.builders[tf].list();
    const sessionBars = bars.filter((b) => b.t + b.ms > win.start);
    const cvd = cvdSeries(sessionBars);
    const cvdAt = new Map(cvd.map((p) => [p.t, p.v]));
    const ofiMap = this.ofiByTf[tf];
    const ofi = sessionBars.filter((b) => ofiMap.has(b.t)).map((b) => ({ t: b.t, v: ofiMap.get(b.t)!, partial: false }));
    const classified = this.status.capabilities.aggressor === 'AVAILABLE' || this.status.capabilities.aggressor === 'DEMO';
    const reversals = detectReversals({ bars: sessionBars, cvdAt, ofiAt: ofiMap, tick: this.tick, classified });
    for (const r of reversals)
      if (!this.seenSignals.has(r.id)) {
        this.seenSignals.add(r.id);
        this.pushAlert({ id: `rev:${r.id}`, t: r.knownAt, kind: 'REVERSAL', text: `${r.direction === 'BULLISH' ? 'Bullish' : 'Bearish'} ${r.setup} · evidence ${r.scoreAtSignal}`, tone: r.direction === 'BULLISH' ? 'bull' : 'bear' });
      }
    const strong = this.recorder.strongLevels(now, STRONG_PARAMS);
    for (const s of strong) {
      const id = `${s.side}:${s.tick}`;
      if (!this.seenStrong.has(id)) {
        this.seenStrong.add(id);
        this.pushAlert({ id: `strong:${id}:${now}`, t: now, kind: 'STRONG_LEVEL', text: `Strong ${s.side === 'BID' ? 'bid' : 'ask'} liquidity ${s.price.toFixed(this.root === 'GC' ? 1 : 3)} · ${s.size} (${s.relative.toFixed(1)}× median)`, tone: s.side === 'BID' ? 'bull' : 'bear' });
      }
    }
    const pkey = `${session}:${win.start}`;
    const profile = (this.profiles.get(pkey) ?? new ProfileAccumulator()).result();
    const tot = this.sessionTotals.get(pkey) ?? { buy: 0, sell: 0, unknown: 0, trades: 0 };
    const vol = tot.buy + tot.sell + tot.unknown;
    const view: OfpView = {
      root: this.root,
      tf,
      status: this.status,
      bars,
      volume: volumeSeries(sessionBars),
      delta: deltaSeries(sessionBars),
      cvd,
      ofi,
      book: this.recorder.currentBook(),
      bookValid: this.recorder.valid,
      quote: this.quote,
      last: this.last,
      strong,
      reversals,
      tape: this.tape.slice(-60).reverse(),
      alerts: [...this.alerts].reverse(),
      stats: {
        window: win,
        volume: vol,
        buy: tot.buy,
        sell: tot.sell,
        unknown: tot.unknown,
        unknownShare: vol ? tot.unknown / vol : 0,
        delta: tot.buy - tot.sell,
        trades: tot.trades,
        profile,
        lateExcluded: this.builders[tf].lateExcluded,
        gaps: this.gaps.length,
        depthEvents: this.recorder.events,
        heatColumns: this.recorder.columnCount,
        ignoredDepthWhileInvalid: this.recorder.ignoredWhileInvalid,
      },
      gaps: this.gaps,
      recorder: this.recorder,
      version: this.version,
    };
    this.cache = { key, view };
    return view;
  }

  /** Record (as an alert) that the stream was rebuilt from a fresh snapshot - called right after reset(). */
  noteResync(reason: string) {
    const t = this.status.lastEventMs ?? this.clock;
    this.pushAlert({ id: `resync:${t}:${this.version}`, t, kind: 'GAP', text: reason, tone: 'warn' });
    this.version++;
  }

  reset() {
    for (const tf of OFP_TFS) {
      this.builders[tf].clear();
      this.ofiByTf[tf].clear();
    }
    this.recorder.clear();
    this.ofi.reset();
    this.profiles.clear();
    this.sessionTotals.clear();
    this.quote = null;
    this.last = null;
    this.tape = [];
    this.gaps = [];
    this.seenSignals.clear();
    this.seenStrong.clear();
    this.lastSeq = null;
    this.cache = null;
    this.version++;
  }
}

export function offlineStatus(root: OfpRoot, feed: FeedState, diagnostics: string[]): SourceStatus {
  return {
    root,
    feed,
    marketDataType: null,
    contract: null,
    capabilities: { depth: 'UNVERIFIED', trades: 'UNVERIFIED', aggressor: 'UNVERIFIED', historicalBars: 'UNVERIFIED' },
    depthRows: 0,
    lastEventMs: null,
    latencyMs: null,
    diagnostics,
  };
}

/** Only these states may be labelled LIVE in the UI. DEMO is never LIVE. */
export const isLiveFeed = (s: SourceStatus) => s.feed === 'LIVE' && s.marketDataType === 'REALTIME';
