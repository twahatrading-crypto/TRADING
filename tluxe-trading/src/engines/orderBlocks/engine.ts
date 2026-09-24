import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { DEFAULT_OB_SETTINGS, OB_TF_SECONDS, obSettingsKey, type OBSettings } from './config';
import { finalizeOBScore, obScoreComponents } from './score';
import type { DisplacementEvidence, OBSnapshot, OBState, OBStateChange, OBSwing, OBType, OrderBlock, StructureBreak } from './types';

/* ============================================================================
 * Order Block Engine v1 — one instrument, one timeframe. Pure & deterministic.
 * Independent of the S&R and Liquidity engines (no shared code or settings).
 *
 * CLOSED BARS ONLY build structure. Unless `lastBarClosed`, the newest candle is
 * FORMING and only sets the current price (distance). It can never confirm a
 * swing, a break, an order block, a test, a mitigation or an invalidation.
 *
 * Per closed bar i, in this order:
 *   1. lifecycle of existing blocks (confirmed on an EARLIER bar)
 *   2. structure breaks against swings confirmed on an EARLIER bar
 *   3. swings confirmed by this bar's close (usable from bar i + 1)
 *
 * SWING      high at c: high[c] > the swingLeft highs before and ≥ the swingRight highs after;
 *            confirmed on the close of c + swingRight. Lows mirror.
 * BREAK      a CLOSE above the most recent confirmed, unbroken swing high by more than
 *            breakTolAtr × ATR (bearish: below the most recent swing low). Older unbroken
 *            swing highs below that close are marked broken too (no extra event).
 *            CHOCH if it breaks against the prevailing trend (the direction of the last
 *            break); otherwise BOS. The first break of the history is a BOS. A wick alone
 *            never breaks structure.
 * ORIGIN     bullish: the LAST bearish (close < open) candle within originLookback bars
 *            before the break bar whose low is ≤ every low from it up to the break
 *            (the displacement launched from it and never traded back below it).
 *            'cluster' mode extends it back over consecutive bearish candles. Bearish mirrors.
 * DISPLACE   the leg from the origin extreme to the break close must be ≥ minLegAtr × ATR
 *            AND contain a candle body ≥ minBodyAtr × ATR (ATR of the break bar).
 *            A break without displacement, or displacement without a break, creates NO block.
 * BOUNDS     wickBody (default): bullish low = origin low, high = origin body top (max(open, close));
 *            bearish high = origin high, low = origin body bottom. fullRange: full candle range.
 *            Frozen at confirmation (the break bar) — never changed later.
 * IMBALANCE  a bullish fair-value gap in the leg: low[k+1] > high[k−1] for some bar k in it (bearish mirror).
 *
 * LIFECYCLE (bars after the confirmation bar; bullish shown, bearish mirrors):
 *   test         a bar's LOW enters the zone (≤ high); one test per visit (ends when a low is back above the zone)
 *   mitigation%  deepest wick penetration from the facing edge ÷ zone height (monotonic, capped 100)
 *   FRESH        untouched, ≤ freshBars since confirmation → ACTIVE after that
 *   TESTED       entered, mitigation% < mitigationPct
 *   MITIGATED    mitigation% ≥ mitigationPct (e.g. a wick through the whole zone that closes back inside)
 *   INVALIDATED  a CLOSE below the zone low by more than invalidTolAtr × ATR (terminal; wins over the
 *                same bar's test/mitigation, which are still recorded)
 *   EXPIRED      expiryBars since confirmation (terminal; 0 = disabled)
 * Records are append-only: identity, origin, bounds, break and displacement never change.
 * ========================================================================== */

interface BlockRuntime {
  b: OrderBlock;
  /** +1 bullish, −1 bearish (frame negation: identical rules for both). */
  s: 1 | -1;
  inTest: boolean;
}

export interface OBEngineOptions {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  tickSize: number;
  settings?: OBSettings;
}

const TERMINAL: readonly OBState[] = ['INVALIDATED', 'EXPIRED'];
const same = (a: Candle, b: Candle) => a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

export class OrderBlockTimeframeEngine {
  readonly instrumentId: InstrumentId;
  readonly timeframe: Timeframe;
  readonly settings: OBSettings;
  private readonly tick: number;
  private bars: Candle[] = [];
  private atrs: number[] = [];
  private swings: (OBSwing & { broken: boolean })[] = [];
  private breaks: StructureBreak[] = [];
  private blocks: BlockRuntime[] = [];
  private gaps: { after: number; before: number; missingBars: number }[] = [];
  private trend: 'up' | 'down' | null = null;
  private rejected = 0;
  private price: number | null = null;
  /** Closed input candles already consumed (incl. rejected ones), for incremental updates. */
  private inputs: Candle[] = [];

  constructor(o: OBEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.timeframe = o.timeframe;
    this.settings = o.settings ?? { ...DEFAULT_OB_SETTINGS };
    this.tick = o.tickSize > 0 ? o.tickSize : 0;
  }

  update(candles: readonly Candle[], o: { lastBarClosed?: boolean; currentPrice?: number | null } = {}): void {
    const closed = o.lastBarClosed ? candles.length : Math.max(0, candles.length - 1);
    // Incremental only if every closed input already consumed is unchanged; otherwise rebuild deterministically.
    let ok = closed >= this.inputs.length;
    for (let j = 0; ok && j < this.inputs.length; j++) if (!same(this.inputs[j]!, candles[j]!)) ok = false;
    if (!ok) this.reset();
    for (let j = this.inputs.length; j < closed; j++) {
      const c = candles[j]!;
      this.inputs.push(c);
      const prev = this.bars[this.bars.length - 1];
      if (prev && c.time <= prev.time) this.rejected += 1; // duplicate / out-of-order timestamp: rejected, never go backwards
      else this.process(c);
    }
    this.price = o.currentPrice !== undefined ? o.currentPrice : candles.length ? candles[candles.length - 1]!.close : null;
  }

  private reset(): void {
    this.bars = [];
    this.atrs = [];
    this.swings = [];
    this.breaks = [];
    this.blocks = [];
    this.gaps = [];
    this.trend = null;
    this.rejected = 0;
    this.inputs = [];
  }

  private process(bar: Candle): void {
    const i = this.bars.length;
    const prev = this.bars[i - 1];
    this.bars.push(bar);
    if (prev) {
      const tf = OB_TF_SECONDS[this.timeframe];
      const d = bar.time - prev.time;
      if (d > tf * this.settings.gapToleranceBars) {
        this.gaps.push({ after: prev.time, before: bar.time, missingBars: Math.round(d / tf) - 1 });
        if (this.gaps.length > 100) this.gaps.shift();
      }
    }
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    const p = this.settings.atrPeriod;
    let atr = Number.NaN;
    if (i === p - 1) {
      let sum = tr;
      for (let k = 1; k < p; k++) {
        const b = this.bars[i - k]!;
        const pb = this.bars[i - k - 1];
        sum += pb ? Math.max(b.high - b.low, Math.abs(b.high - pb.close), Math.abs(b.low - pb.close)) : b.high - b.low;
      }
      atr = sum / p;
    } else if (i >= p) atr = (this.atrs[i - 1]! * (p - 1) + tr) / p;
    this.atrs.push(atr);
    if (!(atr > 0)) return;

    for (const r of this.blocks) this.lifecycle(r, i);
    this.detectBreak(i, 'up');
    this.detectBreak(i, 'down');
    this.detectSwings(i);
  }

  /* -------------------------------- swings -------------------------------- */

  private detectSwings(i: number): void {
    const { swingLeft: L, swingRight: R } = this.settings;
    const c = i - R;
    if (c - L < 0) return;
    const b = this.bars;
    const pc = b[c]!;
    let hi = true;
    let lo = true;
    for (let j = c - L; j < c; j++) {
      if (!(pc.high > b[j]!.high)) hi = false;
      if (!(pc.low < b[j]!.low)) lo = false;
    }
    for (let j = c + 1; j <= c + R; j++) {
      if (!(pc.high >= b[j]!.high)) hi = false;
      if (!(pc.low <= b[j]!.low)) lo = false;
    }
    const base = { index: c, time: pc.time, confirmedIndex: i, confirmedAt: b[i]!.time, broken: false };
    if (hi) this.swings.push({ ...base, id: `${this.instrumentId}:${this.timeframe}:OSH:${pc.time}`, kind: 'high', price: pc.high });
    if (lo) this.swings.push({ ...base, id: `${this.instrumentId}:${this.timeframe}:OSL:${pc.time}`, kind: 'low', price: pc.low });
  }

  /* ------------------------------ structure ------------------------------- */

  private detectBreak(i: number, dir: 'up' | 'down'): void {
    const bar = this.bars[i]!;
    const atr = this.atrs[i]!;
    const kind = dir === 'up' ? 'high' : 'low';
    // Most recent confirmed (on an earlier bar), unbroken swing of that kind.
    let target: (OBSwing & { broken: boolean }) | null = null;
    for (let k = this.swings.length - 1; k >= 0; k--) {
      const sw = this.swings[k]!;
      if (sw.kind === kind && !sw.broken && sw.confirmedIndex < i) {
        target = sw;
        break;
      }
    }
    if (!target) return;
    const s = dir === 'up' ? 1 : -1;
    const tol = this.settings.breakTolAtr * atr;
    if (!(s * bar.close > s * target.price + tol)) return;
    // Mark it and every older unbroken swing of that kind the close has cleared.
    for (const sw of this.swings) if (sw.kind === kind && !sw.broken && sw.confirmedIndex < i && s * bar.close > s * sw.price + tol) sw.broken = true;
    const breakKind = this.trend !== null && this.trend !== dir ? 'CHOCH' : 'BOS';
    this.trend = dir;
    const brk: StructureBreak = {
      id: `${this.instrumentId}:${this.timeframe}:${breakKind}:${dir === 'up' ? 'U' : 'D'}:${bar.time}`,
      direction: dir,
      kind: breakKind,
      swingId: target.id,
      level: target.price,
      time: bar.time,
      index: i,
      close: bar.close,
      breakDistance: s * (bar.close - target.price),
      orderBlockId: null,
      noBlockReason: null,
    };
    this.breaks.push(brk);
    this.tryBlock(brk, i);
  }

  /* ----------------------------- order blocks ----------------------------- */

  private tryBlock(brk: StructureBreak, i: number): void {
    const st = this.settings;
    const b = this.bars;
    const type: OBType = brk.direction === 'up' ? 'bullish' : 'bearish';
    const s: 1 | -1 = type === 'bullish' ? 1 : -1;
    const opposite = (c: Candle) => (s === 1 ? c.close < c.open : c.close > c.open);
    // Frame extreme toward the origin side: bullish lows (s=1) / bearish highs (as −high).
    const ext = (c: Candle) => (s === 1 ? c.low : -c.high);

    let origin = -1;
    for (let k = i - 1; k >= Math.max(0, i - st.originLookback); k--) {
      if (!opposite(b[k]!)) continue;
      let holds = true;
      for (let j = k + 1; j <= i && holds; j++) if (ext(b[j]!) < ext(b[k]!)) holds = false;
      if (holds) {
        origin = k;
        break;
      }
    }
    if (origin < 0) {
      brk.noBlockReason = 'no qualifying origin candle before the displacement';
      return;
    }
    let first = origin;
    if (st.originMode === 'cluster') while (first - 1 >= 0 && opposite(b[first - 1]!) && i - (first - 1) <= st.originLookback) first -= 1;

    const atr = this.atrs[i]!;
    const o = b[origin]!;
    const legSize = s === 1 ? b[i]!.close - Math.min(...b.slice(first, origin + 1).map((c) => c.low)) : Math.max(...b.slice(first, origin + 1).map((c) => c.high)) - b[i]!.close;
    let maxBody = 0;
    for (let j = origin + 1; j <= i; j++) maxBody = Math.max(maxBody, Math.abs(b[j]!.close - b[j]!.open));
    const displacement: DisplacementEvidence = { legSize, legAtr: legSize / atr, maxBody, maxBodyAtr: maxBody / atr, bars: i - origin, atr };
    if (displacement.legAtr < st.minLegAtr || displacement.maxBodyAtr < st.minBodyAtr) {
      brk.noBlockReason = `insufficient displacement (leg ${displacement.legAtr.toFixed(2)} ATR, max body ${displacement.maxBodyAtr.toFixed(2)} ATR)`;
      return;
    }
    const id = `${this.instrumentId}:${this.timeframe}:OB:${type === 'bullish' ? 'BULL' : 'BEAR'}:${o.time}`;
    if (this.blocks.some((r) => r.b.id === id)) {
      brk.noBlockReason = 'origin already produced a block';
      return;
    }
    const cl = b.slice(first, origin + 1);
    let low: number;
    let high: number;
    if (st.boundaryMode === 'fullRange') {
      low = Math.min(...cl.map((c) => c.low));
      high = Math.max(...cl.map((c) => c.high));
    } else if (type === 'bullish') {
      low = Math.min(...cl.map((c) => c.low));
      high = Math.max(...cl.map((c) => Math.max(c.open, c.close)));
    } else {
      high = Math.max(...cl.map((c) => c.high));
      low = Math.min(...cl.map((c) => Math.min(c.open, c.close)));
    }
    if (high - low < this.tick) {
      brk.noBlockReason = 'zone narrower than one tick';
      return;
    }
    let imbalance = false;
    for (let k = origin + 1; k < i && !imbalance; k++) {
      const a = b[k - 1]!;
      const c = b[k + 1]!;
      if (s === 1 ? c.low > a.high : c.high < a.low) imbalance = true;
    }
    const block: OrderBlock = {
      id,
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      type,
      low,
      high,
      mid: (low + high) / 2,
      boundaryMode: st.boundaryMode,
      originTime: o.time,
      originIndex: origin,
      originOpen: o.open,
      originHigh: o.high,
      originLow: o.low,
      originClose: o.close,
      originCandles: origin - first + 1,
      createdAt: o.time,
      confirmedAt: b[i]!.time,
      confirmedIndex: i,
      breakId: brk.id,
      breakKind: brk.kind,
      brokenLevel: brk.level,
      breakDistance: brk.breakDistance,
      displacement,
      hasImbalance: imbalance,
      atrAtConfirmation: atr,
      state: 'FRESH',
      stateHistory: [{ from: null, to: 'FRESH', time: b[i]!.time, reason: `${brk.kind} ${brk.direction} with displacement ${displacement.legAtr.toFixed(2)} ATR` }],
      tests: [],
      firstTestAt: null,
      lastTestAt: null,
      mitigationPct: 0,
      mitigatedAt: null,
      invalidatedAt: null,
      expiredAt: null,
      lastInteractionAt: null,
      ageBars: 0,
      distance: null,
      distanceAtr: null,
      score: finalizeOBScore({ timeframe: 0, displacement: 0, structure: 0, origin: 0, freshness: 0, mitigation: 0, imbalance: 0, confluence: 0 }),
      confluenceIds: [],
    };
    this.blocks.push({ b: block, s, inTest: false });
    brk.orderBlockId = id;
  }

  private setState(ob: OrderBlock, to: OBState, time: number, reason: string): void {
    if (ob.state === to) return;
    const ch: OBStateChange = { from: ob.state, to, time, reason };
    ob.stateHistory.push(ch);
    ob.state = to;
  }

  private lifecycle(r: BlockRuntime, i: number): void {
    const ob = r.b;
    if (TERMINAL.includes(ob.state) || i <= ob.confirmedIndex) return;
    const st = this.settings;
    const bar = this.bars[i]!;
    const s = r.s;
    const top = s === 1 ? ob.high : -ob.low; // facing edge (frame)
    const bottom = s === 1 ? ob.low : -ob.high; // far edge (frame)
    const height = top - bottom;
    const toward = s === 1 ? bar.low : -bar.high;
    const cl = s * bar.close;

    // Test + mitigation (wicks).
    if (toward <= top) {
      const pct = Math.min(100, Math.max(0, (100 * (top - toward)) / height));
      if (!r.inTest) {
        r.inTest = true;
        ob.tests.push({ time: bar.time, depthPct: Math.round(pct * 10) / 10 });
        if (ob.firstTestAt === null) ob.firstTestAt = bar.time;
        ob.lastTestAt = bar.time;
      } else {
        const t = ob.tests[ob.tests.length - 1]!;
        t.depthPct = Math.max(t.depthPct, Math.round(pct * 10) / 10);
      }
      ob.lastInteractionAt = bar.time;
      if (pct > ob.mitigationPct) ob.mitigationPct = Math.round(pct * 10) / 10;
    } else if (r.inTest) r.inTest = false;

    // Invalidation: a CLOSE beyond the far edge (wins over the same bar's test/mitigation).
    if (cl < bottom - st.invalidTolAtr * this.atrs[i]!) {
      ob.invalidatedAt = bar.time;
      this.setState(ob, 'INVALIDATED', bar.time, 'closed beyond the far edge');
      return;
    }
    if (ob.mitigatedAt === null && ob.mitigationPct >= st.mitigationPct) {
      ob.mitigatedAt = bar.time;
      this.setState(ob, 'MITIGATED', bar.time, `penetration reached ${ob.mitigationPct}% of the zone`);
    } else if (ob.state === 'FRESH' || ob.state === 'ACTIVE') {
      if (ob.tests.length > 0) this.setState(ob, 'TESTED', bar.time, 'price re-entered the zone');
      else if (ob.state === 'FRESH' && i - ob.confirmedIndex > st.freshBars) this.setState(ob, 'ACTIVE', bar.time, `untouched for ${st.freshBars} bars`);
    }
    if (st.expiryBars > 0 && i - ob.confirmedIndex >= st.expiryBars) {
      ob.expiredAt = bar.time;
      this.setState(ob, 'EXPIRED', bar.time, `older than ${st.expiryBars} bars`);
    }
  }

  /* -------------------------------- output -------------------------------- */

  snapshot(): OBSnapshot {
    const st = this.settings;
    const n = this.bars.length;
    const last = n - 1;
    const atrNow = n ? this.atrs[last]! : Number.NaN;
    const state = n === 0 ? 'NO_DATA' : n < st.minHistoryBars ? 'INSUFFICIENT_HISTORY' : 'READY';
    const price = this.price;
    const blocks: OrderBlock[] =
      state !== 'READY'
        ? []
        : this.blocks.map(({ b }) => {
            const ageBars = last - b.confirmedIndex;
            const range = b.originHigh - b.originLow;
            const components = obScoreComponents(
              {
                timeframe: this.timeframe,
                state: b.state,
                legAtr: b.displacement.legAtr,
                breakKind: b.breakKind,
                originBodyRatio: range > 0 ? Math.abs(b.originClose - b.originOpen) / range : 0,
                ageBars,
                tests: b.tests.length,
                mitigationPct: b.mitigationPct,
                hasImbalance: b.hasImbalance,
                confluence: 0,
              },
              st,
            );
            const distance = price === null ? null : b.mid - price;
            const inside = price !== null && price >= b.low && price <= b.high;
            return {
              ...b,
              displacement: { ...b.displacement },
              stateHistory: b.stateHistory.map((h) => ({ ...h })),
              tests: b.tests.map((t) => ({ ...t })),
              ageBars,
              distance,
              distanceAtr: distance === null || !(atrNow > 0) ? null : inside ? 0 : Math.abs(distance) / atrNow,
              score: finalizeOBScore(components),
              confluenceIds: [],
            };
          });
    return {
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      state,
      barsProcessed: n,
      requiredBars: st.minHistoryBars,
      rejectedBars: this.rejected,
      lastClosedTime: n ? this.bars[last]!.time : null,
      currentPrice: price,
      atr: atrNow > 0 ? atrNow : null,
      trend: this.trend,
      blocks,
      breaks: this.breaks.map((x) => ({ ...x })),
      swings: this.swings.map(({ broken: _b, ...x }) => ({ ...x })),
      gaps: this.gaps.map((g) => ({ ...g })),
      settingsKey: obSettingsKey(st),
    };
  }
}

export function analyzeOrderBlocks(o: OBEngineOptions & { candles: readonly Candle[]; lastBarClosed?: boolean; currentPrice?: number | null }): OBSnapshot {
  const e = new OrderBlockTimeframeEngine(o);
  e.update(o.candles, { lastBarClosed: o.lastBarClosed, currentPrice: o.currentPrice });
  return e.snapshot();
}
