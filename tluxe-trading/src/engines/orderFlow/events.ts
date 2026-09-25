import type { OrderFlowEngineSettings } from './config';
import type { Aggressor, BookSide, DepthAction, OrderFlowCapabilities, OrderFlowEvent, OrderFlowEventType } from './types';

/* ============================================================================
 * ORDER-FLOW EVENT DETECTORS — deterministic, evidence-only. They describe what the book and the
 * prints did; they never assert intent ("institutions", "spoofing", "iceberg" are never claimed).
 *
 * LARGE TRADE     one print with size ≥ largeTradeSize. Side = the provider's aggressor (UNKNOWN kept).
 *
 * LIQUIDITY HIT   prints into a displayed level: BUY-aggressor prints hit the ASK at their price,
 *                 SELL-aggressor prints hit the BID; UNKNOWN prints are located by price (≥ best ask →
 *                 ask, ≤ best bid → bid, inside the spread → not a hit). Emitted when the level showed
 *                 ≥ hitMinDepth at the first print and the prints at that level within hitWindowMs
 *                 executed ≥ hitFraction of that displayed size. Evidence: displayed, executed, ratio.
 *
 * DEPTH SWEEP     a run of CLASSIFIED aggressive prints of one side, prices moving monotonically in
 *                 the aggressor's direction (BUY: up, SELL: down), through ≥ sweepLevels DISTINCT
 *                 prices, all within sweepWindowMs of the run's first print. UNKNOWN prints never join
 *                 or break a run (their side is unknown). Emitted when the run ends. Evidence: start /
 *                 end price, levels, volume, duration, first / last sequence. (Not the candle-based
 *                 "liquidity sweep" of the strategy engines — a different concept.)
 *
 * STACKING        displayed size at one price rises, within stackWindowMs, by ≥ stackMinSize from its
 *                 size at the window start AND to ≥ stackRatio × that size; only increases count
 *                 (execute-coded changes never do). One event per price and side per window.
 *
 * PULLING         displayed size at one price falls, within pullWindowMs, by ≥ pullMinSize and by ≥
 *                 pullRatio of its PEAK size in the window, counting ONLY the part not explained by
 *                 executions: with reason-coded depth, execute-coded decreases are excluded; without
 *                 it, prints at that price in the window are subtracted (method "depth-minus-prints").
 *                 With neither reasons nor prints the detector is DISABLED and says so.
 *
 * ABSORPTION CANDIDATE  within absorbWindowMs, CLASSIFIED aggressive volume into one price ≥
 *                 absorbMinVolume, the aggressor side's prints progressed ≤ absorbMaxTicks beyond that
 *                 price, and the opposing level still displays ≥ absorbMinRemaining. Evidence: volume,
 *                 progress, remaining, replenished (increases at that level in the window). A candidate
 *                 only — never a statement about who is behind it.
 * ========================================================================== */

interface TradeRec {
  time: number;
  tick: number;
  size: number;
  aggressor: Aggressor;
  seq: number | null;
}
interface ChangeRec {
  time: number;
  prev: number;
  next: number;
  action: DepthAction;
}

export interface DetectorContext {
  price(tick: number): string;
  priceNum(tick: number): number;
  size(side: BookSide, tick: number): number;
  bestBid(): number | null;
  bestAsk(): number | null;
}

export class EventDetectors {
  readonly events: OrderFlowEvent[] = [];
  /** Detectors the provider's data cannot support (reported, never guessed). */
  readonly limitations: string[] = [];
  private trades: TradeRec[] = [];
  private changes = new Map<string, ChangeRec[]>();
  private hits = new Map<string, { start: number; displayed: number; executed: number; firstSeq: number | null; emitted: boolean }>();
  private run: { dir: 'BUY' | 'SELL'; start: number; last: number; startTick: number; lastTick: number; ticks: Set<number>; volume: number; firstSeq: number | null; lastSeq: number | null } | null = null;
  private cooldown = new Map<string, number>();
  private readonly pullingEnabled: boolean;

  constructor(
    private readonly s: OrderFlowEngineSettings,
    private readonly caps: OrderFlowCapabilities,
    private readonly ctx: DetectorContext,
  ) {
    this.pullingEnabled = caps.depthReasons || caps.trades;
    if (!this.pullingEnabled) this.limitations.push('PULLING disabled: the provider neither codes cancel vs execute nor supplies trade prints, so a cancellation cannot be told from an execution.');
    else if (!caps.depthReasons) this.limitations.push('PULLING uses depth minus prints at the same price (the provider does not code cancel vs execute).');
    if (!caps.aggressorSide) this.limitations.push('DEPTH SWEEP and ABSORPTION CANDIDATE need exchange aggressor side — unavailable from this provider.');
  }

  private emit(type: OrderFlowEventType, time: number, tick: number, size: number, side: Aggressor | BookSide, seq: number | null, evidence: OrderFlowEvent['evidence'], detail: string): void {
    this.events.push({ id: `${type}:${side}:${tick}:${time}:${seq ?? 'na'}`, type, time, price: this.ctx.priceNum(tick), size, side, evidence, detail });
    if (this.events.length > this.s.maxEvents) this.events.splice(0, this.events.length - this.s.maxEvents);
  }
  private cooled(key: string, time: number, window: number): boolean {
    const last = this.cooldown.get(key);
    if (last !== undefined && time - last < window) return false;
    this.cooldown.set(key, time);
    return true;
  }
  private maxWindow(): number {
    return Math.max(this.s.absorbWindowMs, this.s.pullWindowMs, this.s.stackWindowMs, this.s.hitWindowMs, this.s.sweepWindowMs);
  }

  /** Time moved on (any message): close windows that can no longer grow. */
  advance(time: number): void {
    if (this.run && time - this.run.start > this.s.sweepWindowMs) this.closeRun();
    const cut = time - this.maxWindow();
    if (this.trades.length && this.trades[0]!.time < cut) this.trades = this.trades.filter((t) => t.time >= cut);
    for (const [k, h] of this.hits) if (time - h.start > this.s.hitWindowMs) this.hits.delete(k);
  }

  onTrade(time: number, tick: number, size: number, aggressor: Aggressor, seq: number | null): void {
    this.advance(time);
    const s = this.s;
    const p = this.ctx.price(tick);
    // LARGE TRADE
    if (size >= s.largeTradeSize) this.emit('LARGE_TRADE', time, tick, size, aggressor, seq, { size, threshold: s.largeTradeSize, aggressor }, `${size} contracts at ${p} (${aggressor === 'UNKNOWN' ? 'aggressor unknown' : `${aggressor.toLowerCase()} aggressor`})`);
    // LIQUIDITY HIT
    const bb = this.ctx.bestBid();
    const ba = this.ctx.bestAsk();
    const side: BookSide | null = aggressor === 'BUY' ? 'ask' : aggressor === 'SELL' ? 'bid' : ba !== null && tick >= ba ? 'ask' : bb !== null && tick <= bb ? 'bid' : null;
    if (side) {
      const key = `${side}:${tick}`;
      let h = this.hits.get(key);
      if (!h) {
        h = { start: time, displayed: this.ctx.size(side, tick), executed: 0, firstSeq: seq, emitted: false };
        this.hits.set(key, h);
      }
      h.executed += size;
      if (!h.emitted && h.displayed >= s.hitMinDepth && h.executed >= s.hitFraction * h.displayed) {
        h.emitted = true;
        this.emit('LIQUIDITY_HIT', time, tick, h.executed, side, seq, { displayed: h.displayed, executed: h.executed, ratio: Number((h.executed / h.displayed).toFixed(3)), windowMs: time - h.start, firstSeq: h.firstSeq }, `${h.executed} executed into ${h.displayed} displayed on the ${side} at ${p} (${Math.round((100 * h.executed) / h.displayed)}%)`);
      }
    }
    this.trades.push({ time, tick, size, aggressor, seq });
    if (aggressor === 'UNKNOWN') return;
    // DEPTH SWEEP (classified prints only)
    const r = this.run;
    const extends_ = r && r.dir === aggressor && time - r.start <= s.sweepWindowMs && (aggressor === 'BUY' ? tick >= r.lastTick : tick <= r.lastTick);
    if (r && extends_) {
      r.last = time;
      r.lastTick = tick;
      r.ticks.add(tick);
      r.volume += size;
      r.lastSeq = seq;
    } else {
      if (r) this.closeRun();
      this.run = { dir: aggressor, start: time, last: time, startTick: tick, lastTick: tick, ticks: new Set([tick]), volume: size, firstSeq: seq, lastSeq: seq };
    }
    // ABSORPTION CANDIDATE
    const into = this.trades.filter((t) => t.aggressor === aggressor && t.tick === tick && time - t.time <= s.absorbWindowMs);
    const vol = into.reduce((a, t) => a + t.size, 0);
    if (vol >= s.absorbMinVolume) {
      const sameSide = this.trades.filter((t) => t.aggressor === aggressor && time - t.time <= s.absorbWindowMs);
      const progress = Math.max(0, ...sameSide.map((t) => (aggressor === 'BUY' ? t.tick - tick : tick - t.tick)));
      const opp: BookSide = aggressor === 'BUY' ? 'ask' : 'bid';
      const remaining = this.ctx.size(opp, tick);
      const replenished = (this.changes.get(`${opp}:${tick}`) ?? []).filter((c) => time - c.time <= s.absorbWindowMs && c.next > c.prev && c.action !== 'execute').reduce((a, c) => a + (c.next - c.prev), 0);
      if (progress <= s.absorbMaxTicks && remaining >= s.absorbMinRemaining && this.cooled(`ABS:${aggressor}:${tick}`, time, s.absorbWindowMs))
        this.emit('ABSORPTION_CANDIDATE', time, tick, vol, aggressor, seq, { aggressiveVolume: vol, progressTicks: progress, remainingDisplayed: remaining, replenished, windowMs: s.absorbWindowMs }, `${vol} ${aggressor.toLowerCase()}-aggressor contracts into ${p}; price progressed ${progress} tick(s); ${remaining} still displayed (replenished ${replenished})`);
    }
  }

  private closeRun(): void {
    const r = this.run;
    this.run = null;
    if (!r || r.ticks.size < this.s.sweepLevels) return;
    const a = this.ctx.price(r.startTick);
    const b = this.ctx.price(r.lastTick);
    this.emit('DEPTH_SWEEP', r.last, r.lastTick, r.volume, r.dir, r.lastSeq, { startPrice: this.ctx.priceNum(r.startTick), endPrice: this.ctx.priceNum(r.lastTick), levels: r.ticks.size, volume: r.volume, durationMs: r.last - r.start, firstSeq: r.firstSeq, lastSeq: r.lastSeq }, `${r.dir.toLowerCase()}-aggressor prints ${a} → ${b} through ${r.ticks.size} levels, ${r.volume} contracts in ${r.last - r.start} ms`);
  }

  onDepth(time: number, side: BookSide, tick: number, prev: number, next: number, action: DepthAction, seq: number | null): void {
    this.advance(time);
    const s = this.s;
    const key = `${side}:${tick}`;
    const list = (this.changes.get(key) ?? []).filter((c) => time - c.time <= Math.max(s.stackWindowMs, s.pullWindowMs, s.absorbWindowMs));
    list.push({ time, prev, next, action });
    this.changes.set(key, list);
    const p = this.ctx.price(tick);
    // STACKING
    const stackWin = list.filter((c) => time - c.time <= s.stackWindowMs);
    const startSize = stackWin[0]!.prev;
    const added = stackWin.reduce((a, c) => a + (c.next > c.prev && c.action !== 'execute' ? c.next - c.prev : 0), 0);
    if (next > prev && action !== 'execute' && next - startSize >= s.stackMinSize && next >= s.stackRatio * Math.max(startSize, 1) && this.cooled(`STK:${key}`, time, s.stackWindowMs))
      this.emit('STACKING', time, tick, next - startSize, side, seq, { sizeBefore: startSize, sizeAfter: next, added, windowMs: s.stackWindowMs }, `${side} at ${p} grew ${startSize} → ${next} within ${s.stackWindowMs / 1000}s`);
    // PULLING
    if (!this.pullingEnabled || !(next < prev)) return;
    const pullWin = list.filter((c) => time - c.time <= s.pullWindowMs);
    // Measured from the level's PEAK displayed size within the window.
    const pStart = Math.max(...pullWin.map((c) => Math.max(c.prev, c.next)));
    let decreased = 0;
    let executed = 0;
    for (const c of pullWin) {
      if (c.next >= c.prev) continue;
      if (c.action === 'execute') executed += c.prev - c.next;
      else decreased += c.prev - c.next;
    }
    let method = 'provider cancel / execute codes';
    if (!this.caps.depthReasons) {
      method = 'depth minus prints';
      const printed = this.trades.filter((t) => t.tick === tick && time - t.time <= s.pullWindowMs).reduce((a, t) => a + t.size, 0);
      executed = Math.min(decreased, printed);
      decreased -= executed;
    }
    if (decreased >= s.pullMinSize && decreased >= s.pullRatio * pStart && this.cooled(`PUL:${key}`, time, s.pullWindowMs))
      this.emit('PULLING', time, tick, decreased, side, seq, { sizeBefore: pStart, sizeAfter: next, unexplainedDecrease: decreased, executed, windowMs: s.pullWindowMs, method }, `${side} at ${p} fell ${pStart} → ${next}; ${decreased} not explained by executions (${method})`);
  }
}
