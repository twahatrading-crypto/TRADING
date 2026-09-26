import type { FootprintSettings } from './config';
import type { FPCandle, FPEvent, FPImbalance, FPRow, FPStack, FPTimeframe } from './types';

/*
 * FOOTPRINT ANALYSIS of ONE candle (pure). Formulas — every label keeps the numbers that produced it:
 *
 *   row            = floor(round(price / tick) / rowTicks)   (row price = lower edge)
 *   Delta(row)     = Ask(row) − Bid(row)                   Ask = aggressive BUY, Bid = aggressive SELL
 *   Candle delta   = Σ Ask − Σ Bid ; Delta % = delta / (Σ Ask + Σ Bid) × 100 ; UNKNOWN volume is never in Bid / Ask
 *   Candle POC     = row with the highest executed volume (bid + ask + unknown); tie → nearer the candle
 *                    middle, then the lower row
 *   BUY imbalance  (diagonal)   Ask(p) ≥ ratio × Bid(p − 1 row)  and Ask(p) ≥ minVolume
 *   SELL imbalance (diagonal)   Bid(p) ≥ ratio × Ask(p + 1 row)  and Bid(p) ≥ minVolume
 *                  (horizontal) compares the same row. The compared row must lie inside the candle's range
 *                  (a missing row inside the range counts 0 → ratio shown as ∞); rows at the edge have no
 *                  diagonal partner and are never labelled.
 *   STACKED        ≥ stackedLevels consecutive rows with the same-side imbalance
 *   ABSORPTION CANDIDATE (high)  Ask in the top absorbRows rows ≥ absorbShare × candle Ask, ≥ minVolume, and the
 *                  close is ≥ absorbRetraceRows rows below the high (aggressive buying without continuation).
 *                  Low: mirror with Bid. Evidence only — never a claim about intent.
 *   UNFINISHED AUCTION CANDIDATE (high / low)  the extreme row traded on BOTH sides (Bid > 0 and Ask > 0) and
 *                  has no UNKNOWN volume. Inferred from the aggregated footprint, not directly observed.
 */

export interface Cell {
  bid: number;
  ask: number;
  unknown: number;
}
export interface CandleData {
  id: string;
  tf: FPTimeframe;
  contract: string;
  time: number;
  endMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  cells: Map<number, Cell>;
  bid: number;
  ask: number;
  unknown: number;
  trades: number;
  run: number;
  maxDelta: number;
  minDelta: number;
  largeTrades: number;
  closed: boolean;
  gap: boolean;
  interrupted: boolean;
  late: number;
}

export interface CandleAnalysis {
  candle: FPCandle;
  imbalances: FPImbalance[];
  stacks: FPStack[];
  candidates: FPEvent[];
}

const decimalsOf = (x: number) => {
  const s = String(x);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};
export const rowIndex = (price: number, tick: number, rowTicks: number) => Math.floor(Math.round(price / tick) / rowTicks);
export const rowPrice = (idx: number, tick: number, rowTicks: number) => Number((idx * rowTicks * tick).toFixed(Math.max(decimalsOf(tick), 0)));

export function analyzeCandle(c: CandleData, s: FootprintSettings, tick: number): CandleAnalysis {
  const rt = s.rowTicks;
  const idxs = [...c.cells.keys()].sort((a, b) => a - b);
  const lo = idxs[0]!;
  const hi = idxs[idxs.length - 1]!;
  const cell = (i: number): Cell => c.cells.get(i) ?? { bid: 0, ask: 0, unknown: 0 };
  const closeTime = Math.floor(c.endMs / 1000);
  const buy = new Map<number, number | null>();
  const sell = new Map<number, number | null>();
  const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
  for (const i of idxs) {
    const x = cell(i);
    const diag = s.imbalanceMode === 'diagonal';
    const below = diag ? i - 1 : i;
    const above = diag ? i + 1 : i;
    if (x.ask >= s.minVolume && below >= lo) {
      const b = cell(below).bid;
      if (b === 0 || x.ask >= s.imbalanceRatio * b) buy.set(i, ratio(x.ask, b));
    }
    if (x.bid >= s.minVolume && above <= hi) {
      const a = cell(above).ask;
      if (a === 0 || x.bid >= s.imbalanceRatio * a) sell.set(i, ratio(x.bid, a));
    }
  }
  // Stacks (ascending consecutive rows).
  const stacks: FPStack[] = [];
  const stackedRows = { BUY: new Set<number>(), SELL: new Set<number>() };
  for (const [side, m] of [['BUY', buy], ['SELL', sell]] as const) {
    const rows = [...m.keys()].sort((a, b) => a - b);
    let start = 0;
    for (let k = 1; k <= rows.length; k++) {
      if (k < rows.length && rows[k] === rows[k - 1]! + 1) continue;
      const run = rows.slice(start, k);
      if (run.length >= s.stackedLevels) {
        run.forEach((r) => stackedRows[side].add(r));
        const low = rowPrice(run[0]!, tick, rt);
        const high = rowPrice(run[run.length - 1]!, tick, rt);
        stacks.push({ id: `${c.id}:STACK:${side}:${low}`, candleId: c.id, tf: c.tf, time: closeTime, side, low, high, levels: run.length, ratios: run.map((r) => m.get(r) ?? null), state: 'ACTIVE', testedAt: null, consumedAt: null });
      }
      start = k;
    }
  }
  const imbalances: FPImbalance[] = [];
  for (const [side, m] of [['BUY', buy], ['SELL', sell]] as const)
    for (const [i, r] of m) {
      const diag = s.imbalanceMode === 'diagonal';
      const cmp = side === 'BUY' ? (diag ? i - 1 : i) : diag ? i + 1 : i;
      const p = rowPrice(i, tick, rt);
      imbalances.push({ id: `${c.id}:IMB:${side}:${p}`, candleId: c.id, tf: c.tf, time: closeTime, price: p, side, ask: side === 'BUY' ? cell(i).ask : cell(cmp).ask, bid: side === 'BUY' ? cell(cmp).bid : cell(i).bid, comparedPrice: rowPrice(cmp, tick, rt), ratio: r, stacked: stackedRows[side].has(i), state: 'ACTIVE', testedAt: null, consumedAt: null });
    }
  imbalances.sort((a, b) => a.price - b.price || (a.side < b.side ? -1 : 1));

  // POC.
  const mid = (lo + hi) / 2;
  let poc = lo;
  let pocV = -1;
  for (const i of idxs) {
    const x = cell(i);
    const v = x.bid + x.ask + x.unknown;
    if (v > pocV || (v === pocV && Math.abs(i - mid) < Math.abs(poc - mid))) {
      poc = i;
      pocV = v;
    }
  }
  const rows: FPRow[] = idxs
    .slice()
    .reverse()
    .map((i) => {
      const x = cell(i);
      return { price: rowPrice(i, tick, rt), bid: x.bid, ask: x.ask, unknown: x.unknown, total: x.bid + x.ask + x.unknown, delta: x.ask - x.bid, buyImb: buy.has(i), sellImb: sell.has(i), buyRatio: buy.get(i) ?? null, sellRatio: sell.get(i) ?? null };
    });

  // Single-candle candidates (closed candles only — a developing candle has not finished its auction).
  const candidates: FPEvent[] = [];
  if (c.closed && hi > lo) {
    const closeIdx = rowIndex(c.close, tick, rt);
    const f = (p: number) => rowPrice(p, tick, rt);
    let askTop = 0;
    let bidBot = 0;
    for (let k = 0; k < s.absorbRows; k++) {
      askTop += cell(hi - k).ask;
      bidBot += cell(lo + k).bid;
    }
    if (c.ask > 0 && askTop >= s.minVolume && askTop >= s.absorbShare * c.ask && hi - closeIdx >= s.absorbRetraceRows)
      candidates.push({ id: `${c.id}:ABS:HIGH`, type: 'ABSORPTION CANDIDATE', tf: c.tf, time: closeTime, price: f(hi), volume: askTop, delta: c.ask - c.bid, candleId: c.id, evidence: `High: Ask ${askTop} in top ${s.absorbRows} rows = ${Math.round((askTop / c.ask) * 100)}% of candle Ask ${c.ask}; close ${hi - closeIdx} rows below the high (no continuation)` });
    if (c.bid > 0 && bidBot >= s.minVolume && bidBot >= s.absorbShare * c.bid && closeIdx - lo >= s.absorbRetraceRows)
      candidates.push({ id: `${c.id}:ABS:LOW`, type: 'ABSORPTION CANDIDATE', tf: c.tf, time: closeTime, price: f(lo), volume: bidBot, delta: c.ask - c.bid, candleId: c.id, evidence: `Low: Bid ${bidBot} in bottom ${s.absorbRows} rows = ${Math.round((bidBot / c.bid) * 100)}% of candle Bid ${c.bid}; close ${closeIdx - lo} rows above the low (no continuation)` });
    const top = cell(hi);
    const bot = cell(lo);
    if (top.unknown === 0 && top.bid > 0 && top.ask > 0)
      candidates.push({ id: `${c.id}:UA:HIGH`, type: 'UNFINISHED AUCTION CANDIDATE', tf: c.tf, time: closeTime, price: f(hi), volume: top.bid + top.ask, delta: top.ask - top.bid, candleId: c.id, evidence: `High row traded on both sides: ${top.bid} × ${top.ask} (a finished auction would show 0 on one side)` });
    if (bot.unknown === 0 && bot.bid > 0 && bot.ask > 0)
      candidates.push({ id: `${c.id}:UA:LOW`, type: 'UNFINISHED AUCTION CANDIDATE', tf: c.tf, time: closeTime, price: f(lo), volume: bot.bid + bot.ask, delta: bot.ask - bot.bid, candleId: c.id, evidence: `Low row traded on both sides: ${bot.bid} × ${bot.ask} (a finished auction would show 0 on one side)` });
  }
  const classified = c.bid + c.ask;
  const candle: FPCandle = {
    id: c.id,
    tf: c.tf,
    contract: c.contract,
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.bid + c.ask + c.unknown,
    bid: c.bid,
    ask: c.ask,
    unknown: c.unknown,
    delta: c.ask - c.bid,
    deltaPct: classified > 0 ? ((c.ask - c.bid) / classified) * 100 : null,
    poc: rowPrice(poc, tick, rt),
    pocVolume: pocV,
    maxDelta: c.maxDelta,
    minDelta: c.minDelta,
    trades: c.trades,
    largeTrades: c.largeTrades,
    rows,
    buyImbalances: buy.size,
    sellImbalances: sell.size,
    stackedBuy: stacks.filter((x) => x.side === 'BUY').length,
    stackedSell: stacks.filter((x) => x.side === 'SELL').length,
    absorption: candidates.filter((x) => x.type === 'ABSORPTION CANDIDATE').length,
    exhaustion: 0,
    closed: c.closed,
    gap: c.gap,
    interrupted: c.interrupted,
    late: c.late,
  };
  return { candle, imbalances, stacks, candidates };
}

/*
 * EXHAUSTION CANDIDATE (needs the previous closed candle of the same timeframe):
 *   high: the candle makes a higher high than the previous candle, has ≥ 5 traded rows, volume TAPERS over the
 *         three highest traded rows (V(high − 2) > V(high − 1) > V(high)) and V(high) ≤ exhaustRel × candle POC volume.
 *   low:  mirror. Candidate only — not a reversal claim.
 */
export function exhaustion(cur: CandleAnalysis, prev: FPCandle | null, s: FootprintSettings): FPEvent[] {
  const c = cur.candle;
  const asc = [...c.rows].sort((a, b) => a.price - b.price);
  if (!prev || !c.closed || asc.length < 5) return [];
  const v = (k: number) => asc[k]!.total;
  const n = asc.length - 1;
  const t = c.time + TF_LEN[c.tf];
  const pct = (x: number) => Math.round((x / Math.max(1, c.pocVolume)) * 100);
  const out: FPEvent[] = [];
  if (c.high > prev.high && v(n - 2) > v(n - 1) && v(n - 1) > v(n) && v(n) <= s.exhaustRel * c.pocVolume)
    out.push({ id: `${c.id}:EXH:HIGH`, type: 'EXHAUSTION CANDIDATE', tf: c.tf, time: t, price: asc[n]!.price, volume: v(n), delta: c.delta, candleId: c.id, evidence: `New high vs previous candle; volume tapers into the high ${v(n - 2)} → ${v(n - 1)} → ${v(n)} (${pct(v(n))}% of POC volume ${c.pocVolume})` });
  if (c.low < prev.low && v(2) > v(1) && v(1) > v(0) && v(0) <= s.exhaustRel * c.pocVolume)
    out.push({ id: `${c.id}:EXH:LOW`, type: 'EXHAUSTION CANDIDATE', tf: c.tf, time: t, price: asc[0]!.price, volume: v(0), delta: c.delta, candleId: c.id, evidence: `New low vs previous candle; volume tapers into the low ${v(2)} → ${v(1)} → ${v(0)} (${pct(v(0))}% of POC volume ${c.pocVolume})` });
  return out;
}
const TF_LEN: Record<FPTimeframe, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600 };
