/**
 * TEST DATA ONLY — deterministic, hand-built order-flow message streams for unit tests and the
 * dev harness. Never imported by production code, never shown as market data. Every stream is
 * obviously synthetic (round prices, round sizes) and the harness is bannered TEST DATA.
 */
import type { Aggressor, BookSide, DepthAction, DepthLevelIn, OrderFlowCapabilities, OrderFlowMsg } from '../types';

export const TEST_INSTRUMENT = 'GC';
export const TEST_TICK = 0.1;
/** Tue 2026-01-06 15:00:00 UTC (CME day session). */
export const TEST_T0 = Date.UTC(2026, 0, 6, 15, 0, 0);

export const FULL_CAPS: OrderFlowCapabilities = {
  depth: 'MBP',
  depthLevels: 10,
  incrementalDepth: true,
  trades: true,
  aggressorSide: true,
  depthReasons: false,
  sequenced: true,
  snapshotOnDemand: true,
};

/** Small builder that keeps per-stream sequence numbers and a clock. */
export class StreamBuilder {
  readonly msgs: OrderFlowMsg[] = [];
  depthSeq = 0;
  tradeSeq = 0;
  t = TEST_T0;
  constructor(
    readonly latencyMs = 3,
    readonly instrumentId = TEST_INSTRUMENT,
  ) {}
  at(ms: number): this {
    this.t = TEST_T0 + ms;
    return this;
  }
  wait(ms: number): this {
    this.t += ms;
    return this;
  }
  private base(seq: number | null) {
    return { instrumentId: this.instrumentId, seq, exchTime: this.t, recvTime: this.t + this.latencyMs };
  }
  snapshot(bids: DepthLevelIn[], asks: DepthLevelIn[]): this {
    this.msgs.push({ ...this.base(this.depthSeq), type: 'snapshot', bids, asks });
    return this;
  }
  depth(side: BookSide, price: number, size: number, action: DepthAction = 'set', seq?: number): this {
    this.depthSeq = seq ?? this.depthSeq + 1;
    this.msgs.push({ ...this.base(this.depthSeq), type: 'depth', side, price, size, action });
    return this;
  }
  trade(price: number, size: number, aggressor: Aggressor, seq?: number): this {
    this.tradeSeq = seq ?? this.tradeSeq + 1;
    this.msgs.push({ ...this.base(this.tradeSeq), type: 'trade', price, size, aggressor });
    return this;
  }
  heartbeat(stream: 'depth' | 'trade'): this {
    this.msgs.push({ ...this.base(null), type: 'heartbeat', stream });
    return this;
  }
}

/** A 10-level book around 2436.0 / 2436.1 (bids 2435.1–2436.0, asks 2436.1–2437.0). */
export function baseBook(bidSize = 80, askSize = 80): { bids: DepthLevelIn[]; asks: DepthLevelIn[] } {
  const bids: DepthLevelIn[] = [];
  const asks: DepthLevelIn[] = [];
  for (let i = 0; i < 10; i++) {
    bids.push({ price: Number((2436.0 - i * 0.1).toFixed(1)), size: bidSize + i * 10 });
    asks.push({ price: Number((2436.1 + i * 0.1).toFixed(1)), size: askSize + i * 10 });
  }
  return { bids, asks };
}

/**
 * A ~2 minute TEST DATA session exercising every detector: stacking, pulling, a large trade,
 * a liquidity hit, a buy sweep through 4 levels, an absorption candidate, UNKNOWN prints and
 * heartbeats. Deterministic.
 */
export function demoSession(): OrderFlowMsg[] {
  const b = new StreamBuilder();
  const book = baseBook();
  b.at(0).snapshot(book.bids, book.asks);
  // Quiet book with heartbeats and small two-way prints.
  for (let s = 1; s <= 20; s++) {
    b.at(s * 1000).heartbeat('depth').trade(s % 2 ? 2436.1 : 2436.0, 2 + (s % 3), s % 2 ? 'BUY' : 'SELL');
    if (s % 5 === 0) b.trade(2436.0, 1, 'UNKNOWN');
  }
  // STACKING: bid 2435.5 grows 130 → 400 within 3 s.
  b.at(21_000).depth('bid', 2435.5, 200, 'add').at(22_000).depth('bid', 2435.5, 300, 'add').at(23_000).depth('bid', 2435.5, 400, 'add');
  // PULLING: ask 2436.5 is raised to 300, then cut to 100 and removed with no prints there.
  b.at(24_000).depth('ask', 2436.5, 300, 'add').at(26_000).depth('ask', 2436.5, 100, 'set').at(27_000).depth('ask', 2436.5, 0, 'delete');
  // LARGE TRADE + LIQUIDITY HIT on the best ask 2436.1 (raised to 120 displayed; 70 executed).
  b.at(29_000).depth('ask', 2436.1, 120, 'add').at(30_000).trade(2436.1, 70, 'BUY').depth('ask', 2436.1, 50, 'set');
  // DEPTH SWEEP: buy prints 2436.1 → 2436.4 within 200 ms, levels consumed.
  b.at(40_000).trade(2436.1, 50, 'BUY').depth('ask', 2436.1, 0, 'delete');
  b.at(40_060).trade(2436.2, 90, 'BUY').depth('ask', 2436.2, 0, 'delete');
  b.at(40_120).trade(2436.3, 100, 'BUY').depth('ask', 2436.3, 0, 'delete');
  b.at(40_180).trade(2436.4, 40, 'BUY').depth('ask', 2436.4, 70, 'set');
  // ABSORPTION CANDIDATE: 5 × 70 buy-aggressor contracts into 2436.4 over 5 s; the ask keeps being replenished and price does not advance.
  for (let k = 0; k < 5; k++) b.at(45_000 + k * 1000).trade(2436.4, 70, 'BUY').depth('ask', 2436.4, 90, 'add');
  for (let s = 51; s <= 120; s++) b.at(s * 1000).heartbeat('depth').trade(2436.3, 3, s % 2 ? 'SELL' : 'BUY');
  return b.msgs;
}

/**
 * TEST DATA ONLY — a longer seeded random-walk session for the dev harness (visual check of the
 * heatmap). Book levels regenerate around a wandering mid; prints hit the touch with a known side,
 * a share of prints is UNKNOWN; heartbeats every second. Never used in production.
 */
export function generatedSession(minutes = 30, seed = 7): OrderFlowMsg[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const b = new StreamBuilder();
  let mid = 24360; // ticks (2436.0)
  const walls = new Map<number, number>(); // persistent resting "walls" (ticks → extra size)
  const levelSize = (t: number) => Math.round(20 + rnd() * 60 + (walls.get(t) ?? 0));
  const book = () => {
    const bids: DepthLevelIn[] = [];
    const asks: DepthLevelIn[] = [];
    for (let i = 0; i < 20; i++) {
      bids.push({ price: (mid - i) / 10, size: levelSize(mid - i) });
      asks.push({ price: (mid + 1 + i) / 10, size: levelSize(mid + 1 + i) });
    }
    return { bids, asks };
  };
  for (let k = 0; k < 6; k++) walls.set(mid + Math.round((rnd() - 0.5) * 60), 150 + Math.round(rnd() * 300));
  const bk = book();
  b.at(0).snapshot(bk.bids, bk.asks);
  const cur = new Map<string, number>();
  for (const l of bk.bids) cur.set(`b${Math.round(l.price * 10)}`, l.size);
  for (const l of bk.asks) cur.set(`a${Math.round(l.price * 10)}`, l.size);
  const setLevel = (side: 'bid' | 'ask', t: number, size: number, action: DepthAction) => {
    cur.set(`${side === 'bid' ? 'b' : 'a'}${t}`, size);
    b.depth(side, t / 10, size, action);
  };
  const steps = minutes * 60 * 4; // 250 ms steps
  for (let i = 1; i <= steps; i++) {
    b.at(i * 250);
    if (i % 4 === 0) b.heartbeat('depth');
    // Mid drift (mean-reverting random walk).
    if (rnd() < 0.08) {
      const dir = rnd() < 0.5 ? -1 : 1;
      mid += dir;
      // Keep the TEST book uncrossed: the level that just became the opposite side's touch is removed.
      if (dir > 0) setLevel('ask', mid, 0, 'delete');
      else setLevel('bid', mid + 1, 0, 'delete');
      setLevel(dir > 0 ? 'bid' : 'ask', dir > 0 ? mid : mid + 1, levelSize(dir > 0 ? mid : mid + 1), 'set');
      setLevel(dir > 0 ? 'ask' : 'bid', dir > 0 ? mid + 20 : mid - 19, levelSize(dir > 0 ? mid + 20 : mid - 19), 'set');
    }
    // Random level refresh.
    for (let k = 0; k < 3; k++) {
      const side = rnd() < 0.5 ? 'bid' : 'ask';
      const t = side === 'bid' ? mid - Math.floor(rnd() * 20) : mid + 1 + Math.floor(rnd() * 20);
      setLevel(side, t, levelSize(t), 'set');
    }
    // Occasional prints at the touch.
    if (rnd() < 0.35) {
      const buy = rnd() < 0.5;
      const size = rnd() < 0.03 ? 40 + Math.round(rnd() * 80) : 1 + Math.round(rnd() * 8);
      b.trade((buy ? mid + 1 : mid) / 10, size, rnd() < 0.1 ? 'UNKNOWN' : buy ? 'BUY' : 'SELL');
    }
    if (rnd() < 0.002) walls.set(mid + Math.round((rnd() - 0.5) * 30), 150 + Math.round(rnd() * 300));
  }
  return b.msgs;
}
