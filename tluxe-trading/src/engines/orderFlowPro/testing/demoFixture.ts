import { MAX_QUOTE_AGE_MS, OFP_TICK } from '../config';
import { classifyQuoteRule, fromTick, toTick } from '../classify';
import type { ContractInfo, OfpEvent, OfpFrame, OfpRoot, SourceStatus } from '../types';

/* ============================================================================
 * DEMO FIXTURE - synthetic, seeded, deterministic order-flow events for VISUAL TESTING and UNIT TESTS ONLY.
 * NOT MARKET DATA. The status it produces is feed 'DEMO' (never LIVE), contract 'DEMO-…' (verified: false) and
 * every capability 'DEMO'. Nothing in production imports this file (only the dev harness and tests).
 * ========================================================================== */

export const DEMO_LABEL = 'DEMO FIXTURE — SYNTHETIC EVENTS, NOT MARKET DATA';

/** mulberry32 */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START: Record<OfpRoot, number> = { GC: 4195.4, SI: 49.85 };

export function demoContract(root: OfpRoot): ContractInfo {
  return { root, localSymbol: `DEMO-${root}Z6`, conId: null, expiry: '20261229', exchange: 'COMEX', tradingClass: root, multiplier: root === 'GC' ? '100' : '5000', verified: false };
}

export function demoStatus(root: OfpRoot, lastEventMs: number | null): SourceStatus {
  return {
    root,
    feed: 'DEMO',
    marketDataType: null,
    contract: demoContract(root),
    capabilities: { depth: 'DEMO', trades: 'DEMO', aggressor: 'DEMO', historicalBars: 'DEMO' },
    depthRows: 10,
    lastEventMs,
    latencyMs: null,
    diagnostics: [DEMO_LABEL, 'Aggressor side in this fixture is quote-rule INFERRED exactly as for IBKR prints; inside-spread prints are UNKNOWN.'],
  };
}

interface Wall {
  tick: number;
  side: 'BID' | 'ASK';
  size: number;
  until: number;
}

/**
 * One-second step generator. `step()` returns that second's events: depth level changes, a quote, prints
 * (classified by the same quote rule the backend uses) and, rarely, a scripted gap + resync.
 */
export class DemoStream {
  readonly tick: number;
  private r: () => number;
  private mid: number;
  private drift = 0;
  private book: { BID: Map<number, number>; ASK: Map<number, number> } = { BID: new Map(), ASK: new Map() };
  private walls: Wall[] = [];
  private started = false;
  private seq = 1;
  t: number;

  constructor(readonly root: OfpRoot, t0: number, seed = 7, readonly rows = 10, private readonly gapEverySteps = 0) {
    this.tick = OFP_TICK[root];
    this.r = rng(seed + (root === 'GC' ? 0 : 1000));
    this.mid = toTick(START[root], this.tick);
    this.t = t0;
  }

  private sizeAt(k: number, side: 'BID' | 'ASK') {
    const w = this.walls.find((x) => x.tick === k && x.side === side);
    if (w) return w.size;
    // stable per-price base + slow wobble: deterministic, no Math.random
    const h = Math.abs(Math.sin(k * 12.9898 + (side === 'ASK' ? 78.233 : 0)) * 43758.5453) % 1;
    return Math.max(1, Math.round(3 + h * 14 + this.r() * 4));
  }

  private targetBook(spread: number) {
    const bid = new Map<number, number>();
    const ask = new Map<number, number>();
    for (let i = 0; i < this.rows; i++) {
      bid.set(this.mid - i, this.sizeAt(this.mid - i, 'BID'));
      ask.set(this.mid + spread + i, this.sizeAt(this.mid + spread + i, 'ASK'));
    }
    return { BID: bid, ASK: ask };
  }

  frame(events: OfpEvent[]): OfpFrame {
    const f: OfpFrame = { root: this.root, seq: this.seq, events };
    this.seq += events.length;
    return f;
  }

  step(): OfpEvent[] {
    const ev: OfpEvent[] = [];
    const r = this.r;
    this.t += 1000;
    const t = this.t;

    if (this.gapEverySteps > 0 && this.started && Math.round(t / 1000) % this.gapEverySteps === 0) {
      ev.push({ kind: 'gap', from: t - 1000, to: t + 44_000, reason: 'DEMO: scripted disconnect (tests gap handling)' });
      this.t += 45_000;
      this.started = false;
      return ev;
    }

    // walls: occasionally add a large resting order a few ticks away, expire / pull old ones
    this.walls = this.walls.filter((w) => w.until > t && !(w.side === 'BID' ? w.tick > this.mid : w.tick <= this.mid));
    if (r() < 0.03 && this.walls.length < 8) {
      const side = r() < 0.5 ? 'BID' : 'ASK';
      const off = 2 + Math.floor(r() * 8);
      this.walls.push({ side, tick: side === 'BID' ? this.mid - off : this.mid + off, size: 45 + Math.floor(r() * 110), until: t + (10 + r() * 50) * 60_000 });
    }

    // price: random walk with regime drift; walls slow / repel the walk (visible absorption + reversals)
    if (r() < 0.01) this.drift = (r() - 0.5) * 0.3;
    const wallAbove = this.walls.some((w) => w.side === 'ASK' && w.tick - this.mid <= 2);
    const wallBelow = this.walls.some((w) => w.side === 'BID' && this.mid - w.tick <= 1);
    let p = 0.5 + this.drift - (wallAbove ? 0.18 : 0) + (wallBelow ? 0.18 : 0);
    p = Math.min(0.85, Math.max(0.15, p));
    const u = r();
    const move = u < 0.38 ? (r() < p ? 1 : -1) : u < 0.42 ? (r() < p ? 3 : -3) : 0;
    // walls get eaten when price trades through them
    if (move > 0) this.walls = this.walls.filter((w) => !(w.side === 'ASK' && w.tick <= this.mid + move));
    if (move < 0) this.walls = this.walls.filter((w) => !(w.side === 'BID' && w.tick > this.mid + move));
    this.mid += move;

    const spread = r() < 0.06 ? 2 : 1;
    const target = this.targetBook(spread);
    if (!this.started) {
      ev.push({ kind: 'book', t, bids: [...target.BID].map(([k, s]) => [fromTick(k, this.tick), s]), asks: [...target.ASK].map(([k, s]) => [fromTick(k, this.tick), s]) });
      this.started = true;
    } else {
      for (const side of ['BID', 'ASK'] as const) {
        const old = this.book[side];
        const nw = target[side];
        for (const [k, s] of nw) if (old.get(k) !== s) ev.push({ kind: 'depth', t: t + 1, side, price: fromTick(k, this.tick), size: s });
        for (const k of old.keys()) if (!nw.has(k)) ev.push({ kind: 'depth', t: t + 1, side, price: fromTick(k, this.tick), size: 0 });
      }
    }
    this.book = target;

    const bidT = this.mid;
    const askT = this.mid + spread;
    const quote = { kind: 'quote' as const, t: t + 2, bid: fromTick(bidT, this.tick), ask: fromTick(askT, this.tick), bidSize: target.BID.get(bidT) ?? null, askSize: target.ASK.get(askT) ?? null };
    ev.push(quote);

    // prints: buy-side heavier when moving up, sell-side when moving down; inside-spread prints only when spread = 2
    const n = Math.floor(r() * (move !== 0 ? 9 : 4));
    for (let i = 0; i < n; i++) {
      const buy = r() < (move > 0 ? 0.7 : move < 0 ? 0.3 : 0.5);
      const inside = spread === 2 && r() < 0.5;
      const k = inside ? bidT + 1 : buy ? askT : bidT;
      const price = fromTick(k, this.tick);
      const size = 1 + Math.floor(r() * r() * 12);
      const tt = t + 3 + i;
      const aggressor = classifyQuoteRule(price, quote, tt, this.tick, MAX_QUOTE_AGE_MS);
      ev.push({ kind: 'trade', t: tt, price, size, aggressor, method: 'QUOTE_RULE', bid: quote.bid, ask: quote.ask });
    }
    return ev;
  }
}

/** Build `seconds` of fixture history ending at t0 + seconds*1000, as frames of one step each. */
export function demoHistory(root: OfpRoot, t0: number, seconds: number, seed = 7, gapEverySteps = 0): { stream: DemoStream; frames: OfpFrame[] } {
  const stream = new DemoStream(root, t0, seed, 10, gapEverySteps);
  const frames: OfpFrame[] = [];
  for (let i = 0; i < seconds; i++) {
    const evs = stream.step();
    if (evs.length) frames.push(stream.frame(evs));
  }
  return { stream, frames };
}
