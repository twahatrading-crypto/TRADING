import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { DEFAULT_LIQUIDITY_SETTINGS, LIQUIDITY_TF_SECONDS, liquiditySettingsKey, type LiquiditySettings } from './config';
import { finalizeLiquidityScore, liquidityScoreComponents } from './score';
import type {
  LiquidityGap,
  LiquidityPool,
  LiquiditySide,
  LiquiditySnapshot,
  LiquiditySwing,
  PoolContribution,
  PoolSource,
  PoolState,
  StateChange,
  SweepEvent,
  TestEvent,
} from './types';

/* ============================================================================
 * Liquidity Engine v1 — one instrument, one timeframe. Pure & deterministic.
 * Independent of the S&R engine (no shared code, settings or scores).
 *
 * CLOSED BARS ONLY build structure and events. Unless `lastBarClosed`, the
 * newest candle is treated as FORMING and is used only for:
 *   - current price → distance / distanceAtr / nearest BSL above & SSL below
 *   - `liveProbe`   → "the forming bar is trading beyond this pool right now"
 * A forming bar can NEVER confirm a swing, create/join a pool, add a test,
 * record a sweep, a reclaim or an acceptance, or change a state.
 *
 * Rules (all distances in ATR of this timeframe; ATR = Wilder(atrPeriod)):
 *
 * SWING   high at bar c: high[c] > high[j] for the swingLeft bars before and
 *         high[c] ≥ high[j] for the swingRight bars after; confirmed on the CLOSE
 *         of bar c + swingRight (never earlier). Lows mirror.
 * POOL    every confirmed swing high is a BSL candidate, every swing low an SSL
 *         candidate. tolerance = max(equalTolAtr × ATR, equalMinTicks × tick),
 *         frozen at creation.
 * EQUAL   a new swing joins an untaken pool of the same side (FORMING / ACTIVE /
 *         TESTED) when |price − level| ≤ that pool's tolerance (closest level wins,
 *         ties → older pool). The pool becomes EQH/EQL (source 'equal'); its level
 *         is the highest contributing high (BSL) / lowest contributing low (SSL).
 * QUALIFY A single-swing pool is ACTIVE if the swing's own confirmation already
 *         displaced ≥ qualifyDisplacementAtr (closes away); otherwise FORMING until a
 *         later close displaces that far or an equal high/low joins. FORMING that is
 *         taken first, or not qualified within qualifyWindowBars → INVALIDATED.
 * TEST    ACTIVE/TESTED: a bar whose high comes within testTolAtr of a BSL level
 *         (low within testTolAtr above an SSL level) without going beyond the band
 *         starts a test (one per approach; ends when price moves testSeparationAtr away).
 * SWEEP   a CLOSED bar trades beyond level ± tolerance → liquidity TAKEN (state SWEPT).
 *         kind 'wick' if that bar closed back on the resting side, else 'closeThrough'.
 *         While pending the extreme/penetration are tracked.
 * RECLAIM a close back on the resting side (≤ level for BSL, ≥ level for SSL) within
 *         reclaimWindowBars of the sweep bar (0 = same bar). Information only.
 *         After the window a close back is recorded as 'returned'.
 * ACCEPT  acceptCloses consecutive closes beyond level ± acceptTolAtr, or one close
 *         beyond level ± acceptDisplacementAtr → continuation; pool CONSUMED (terminal).
 * REPEAT  after a sweep resolved back on the resting side, the next bar beyond the
 *         band is a new (repeated) sweep of the same pool.
 * A sweep, a reclaim or acceptance is NEVER a buy/sell signal.
 *
 * Records are append-only: an event's time, kind and decided outcome never
 * change once written (verified by the anti-repaint audit).
 * ========================================================================== */

interface SweepRuntime {
  ev: SweepEvent;
  startIndex: number;
  /** Frame-space extreme. */
  extreme: number;
  acceptRun: number;
}

interface PoolRuntime {
  id: string;
  side: LiquiditySide;
  /** +1 BSL (prices as-is), −1 SSL (prices negated): identical rules for both sides. */
  s: 1 | -1;
  source: PoolSource;
  level: number;
  rangeLow: number;
  rangeHigh: number;
  tolerance: number;
  atr0: number;
  createdAt: number;
  confirmedAt: number;
  confirmedIndex: number;
  contributions: PoolContribution[];
  prominenceAtr: number;
  displacementAtr: number;
  tests: TestEvent[];
  inTest: boolean;
  sweeps: SweepEvent[];
  pending: SweepRuntime | null;
  /** Price is back on the resting side: a new excursion beyond the band is a (repeated) sweep. */
  armed: boolean;
  state: PoolState;
  stateHistory: StateChange[];
  reclaimed: boolean;
  consumedAt: number | null;
  invalidatedAt: number | null;
  lastInteractionIndex: number | null;
}

export interface LiquidityEngineOptions {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  tickSize: number;
  settings?: LiquiditySettings;
}

export interface LiquidityUpdateOptions {
  /** Treat the final candle as closed. Default false (newest = forming). */
  lastBarClosed?: boolean;
  /** Current price for distances; defaults to the newest candle's close. */
  currentPrice?: number | null;
}

const TERMINAL: readonly PoolState[] = ['CONSUMED', 'INVALIDATED'];
const same = (a: Candle, b: Candle) => a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

export class LiquidityTimeframeEngine {
  readonly instrumentId: InstrumentId;
  readonly timeframe: Timeframe;
  readonly settings: LiquiditySettings;
  private readonly tick: number;

  private bars: Candle[] = [];
  private atrs: number[] = [];
  private swings: LiquiditySwing[] = [];
  private pools: PoolRuntime[] = [];
  private gaps: LiquidityGap[] = [];
  private price: number | null = null;
  private forming: Candle | null = null;

  constructor(o: LiquidityEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.timeframe = o.timeframe;
    this.settings = o.settings ?? { ...DEFAULT_LIQUIDITY_SETTINGS };
    this.tick = o.tickSize > 0 ? o.tickSize : 0;
  }

  /** Feed the full history (ascending). New closed bars are processed incrementally; changed history → deterministic rebuild. */
  update(candles: readonly Candle[], o: LiquidityUpdateOptions = {}): void {
    const closed = o.lastBarClosed ? candles.length : Math.max(0, candles.length - 1);
    let ok = closed >= this.bars.length;
    for (let k = 0; ok && k < this.bars.length; k++) if (!same(this.bars[k]!, candles[k]!)) ok = false;
    if (!ok) this.reset();
    for (let k = this.bars.length; k < closed; k++) {
      const c = candles[k]!;
      const prev = this.bars[this.bars.length - 1];
      if (prev && c.time <= prev.time) continue; // duplicate / out-of-order timestamp: never go backwards
      this.process(c);
    }
    this.forming = o.lastBarClosed || candles.length === 0 ? null : candles[candles.length - 1]!;
    this.price = o.currentPrice !== undefined ? o.currentPrice : candles.length ? candles[candles.length - 1]!.close : null;
  }

  private reset(): void {
    this.bars = [];
    this.atrs = [];
    this.swings = [];
    this.pools = [];
    this.gaps = [];
  }

  private process(bar: Candle): void {
    const i = this.bars.length;
    const prev = this.bars[i - 1];
    this.bars.push(bar);
    if (prev) {
      const tf = LIQUIDITY_TF_SECONDS[this.timeframe];
      const delta = bar.time - prev.time;
      if (delta > tf * this.settings.gapToleranceBars) {
        this.gaps.push({ after: prev.time, before: bar.time, missingBars: Math.round(delta / tf) - 1 });
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

    // 1) existing pools react to this closed bar; 2) swings confirmed by this bar's close.
    for (const pool of this.pools) this.step(pool, i);
    this.detectSwings(i);
  }

  /* -------------------------------- swings -------------------------------- */

  private detectSwings(i: number): void {
    const { swingLeft: L, swingRight: R } = this.settings;
    const c = i - R;
    if (c - L < 0) return;
    const b = this.bars;
    const pc = b[c]!;
    const atr = this.atrs[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = c - L; j < c; j++) {
      if (!(pc.high > b[j]!.high)) isHigh = false;
      if (!(pc.low < b[j]!.low)) isLow = false;
    }
    for (let j = c + 1; j <= c + R; j++) {
      if (!(pc.high >= b[j]!.high)) isHigh = false;
      if (!(pc.low <= b[j]!.low)) isLow = false;
    }
    if (isHigh) {
      let legLow = Infinity;
      for (let j = c - L; j < c; j++) legLow = Math.min(legLow, b[j]!.low);
      let minClose = Infinity;
      for (let j = c; j <= i; j++) minClose = Math.min(minClose, b[j]!.close);
      this.onSwing({
        id: `${this.instrumentId}:${this.timeframe}:SH:${pc.time}`,
        kind: 'high',
        index: c,
        time: pc.time,
        price: pc.high,
        confirmedIndex: i,
        confirmedAt: b[i]!.time,
        atr,
        prominenceAtr: (pc.high - legLow) / atr,
        displacementAtr: (pc.high - minClose) / atr,
      });
    }
    if (isLow) {
      let legHigh = -Infinity;
      for (let j = c - L; j < c; j++) legHigh = Math.max(legHigh, b[j]!.high);
      let maxClose = -Infinity;
      for (let j = c; j <= i; j++) maxClose = Math.max(maxClose, b[j]!.close);
      this.onSwing({
        id: `${this.instrumentId}:${this.timeframe}:SL:${pc.time}`,
        kind: 'low',
        index: c,
        time: pc.time,
        price: pc.low,
        confirmedIndex: i,
        confirmedAt: b[i]!.time,
        atr,
        prominenceAtr: (legHigh - pc.low) / atr,
        displacementAtr: (maxClose - pc.low) / atr,
      });
    }
  }

  /* ------------------------------ pools / EQ ------------------------------ */

  private onSwing(sw: LiquiditySwing): void {
    this.swings.push(sw);
    const side: LiquiditySide = sw.kind === 'high' ? 'BSL' : 'SSL';
    const s = side === 'BSL' ? 1 : -1;
    const contribution: PoolContribution = { swingId: sw.id, time: sw.time, price: sw.price, confirmedAt: sw.confirmedAt };

    // Equal highs/lows: join the closest untaken pool within that pool's tolerance.
    let target: PoolRuntime | null = null;
    let best = Infinity;
    for (const p of this.pools) {
      if (p.side !== side || !(p.state === 'FORMING' || p.state === 'ACTIVE' || p.state === 'TESTED')) continue;
      const d = Math.abs(sw.price - p.level);
      if (d <= p.tolerance && d < best) {
        best = d;
        target = p;
      }
    }
    if (target) {
      const p = target;
      p.contributions.push(contribution);
      if (s * sw.price > s * p.level) p.level = sw.price;
      p.rangeLow = Math.min(p.rangeLow, sw.price);
      p.rangeHigh = Math.max(p.rangeHigh, sw.price);
      p.source = 'equal';
      p.prominenceAtr = Math.max(p.prominenceAtr, sw.prominenceAtr);
      p.displacementAtr = Math.max(p.displacementAtr, sw.displacementAtr);
      if (p.state === 'FORMING') this.setState(p, 'ACTIVE', sw.confirmedAt, `equal ${side === 'BSL' ? 'highs' : 'lows'} ×${p.contributions.length}`);
      return;
    }

    const tolerance = Math.max(this.settings.equalTolAtr * sw.atr, this.settings.equalMinTicks * this.tick);
    const qualified = sw.displacementAtr >= this.settings.qualifyDisplacementAtr;
    const state: PoolState = qualified ? 'ACTIVE' : 'FORMING';
    this.pools.push({
      id: `${this.instrumentId}:${this.timeframe}:LQ:${side}:${sw.time}`,
      side,
      s,
      source: 'swing',
      level: sw.price,
      rangeLow: sw.price,
      rangeHigh: sw.price,
      tolerance,
      atr0: sw.atr,
      createdAt: sw.time,
      confirmedAt: sw.confirmedAt,
      confirmedIndex: sw.confirmedIndex,
      contributions: [contribution],
      prominenceAtr: sw.prominenceAtr,
      displacementAtr: sw.displacementAtr,
      tests: [],
      inTest: false,
      sweeps: [],
      pending: null,
      armed: true,
      state,
      stateHistory: [{ from: null, to: state, time: sw.confirmedAt, reason: qualified ? 'swing confirmed with displacement' : 'swing confirmed; awaiting qualification' }],
      reclaimed: false,
      consumedAt: null,
      invalidatedAt: null,
      lastInteractionIndex: null,
    });
  }

  private setState(p: PoolRuntime, to: PoolState, time: number, reason: string): void {
    if (p.state === to) return;
    p.stateHistory.push({ from: p.state, to, time, reason });
    p.state = to;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  private step(p: PoolRuntime, i: number): void {
    if (TERMINAL.includes(p.state) || i <= p.confirmedIndex) return;
    const st = this.settings;
    const bar = this.bars[i]!;
    const s = p.s;
    const hi = s === 1 ? bar.high : -bar.low; // extreme toward (and beyond) the pool
    const cl = s * bar.close;
    const L = s * p.level;
    const beyond = L + p.tolerance;
    const a = p.atr0;

    if (p.state === 'FORMING') {
      if (hi > beyond) {
        p.invalidatedAt = bar.time;
        this.setState(p, 'INVALIDATED', bar.time, 'taken before it qualified as liquidity');
        return;
      }
      const away = (L - cl) / a;
      if (away >= st.qualifyDisplacementAtr) {
        p.displacementAtr = Math.max(p.displacementAtr, away);
        this.setState(p, 'ACTIVE', bar.time, 'qualified: price displaced away');
      } else if (i - p.confirmedIndex > st.qualifyWindowBars) {
        p.invalidatedAt = bar.time;
        this.setState(p, 'INVALIDATED', bar.time, `not qualified within ${st.qualifyWindowBars} bars`);
      }
      return;
    }

    if (p.state === 'ACTIVE' || p.state === 'TESTED') {
      if (hi > beyond) {
        this.startSweep(p, i, hi, cl, L);
        return;
      }
      if (!p.inTest && hi >= L - st.testTolAtr * a) {
        p.inTest = true;
        p.tests.push({ time: bar.time, extreme: bar[s === 1 ? 'high' : 'low'] });
        p.lastInteractionIndex = i;
        this.setState(p, 'TESTED', bar.time, 'price returned to the level without taking it');
      } else if (p.inTest) {
        const t = p.tests[p.tests.length - 1]!;
        if (s * bar[s === 1 ? 'high' : 'low'] > s * t.extreme) t.extreme = bar[s === 1 ? 'high' : 'low'];
        if (hi < L - st.testSeparationAtr * a) p.inTest = false;
      }
      return;
    }

    // SWEPT
    if (p.pending) {
      const r = p.pending;
      const ev = r.ev;
      p.lastInteractionIndex = i;
      if (hi > r.extreme) {
        r.extreme = hi;
        ev.extremePrice = s * hi;
        ev.extremeTime = bar.time;
        ev.penetration = hi - L;
        ev.penetrationAtr = (hi - L) / a;
      }
      r.acceptRun = cl > L + st.acceptTolAtr * a ? r.acceptRun + 1 : 0;
      if (r.acceptRun >= st.acceptCloses || cl > L + st.acceptDisplacementAtr * a) {
        this.accept(p, bar.time);
        return;
      }
      if (cl <= L) this.returnToRestingSide(p, i, bar.time);
      return;
    }
    if (p.armed && hi > beyond) this.startSweep(p, i, hi, cl, L);
  }

  private startSweep(p: PoolRuntime, i: number, hi: number, cl: number, L: number): void {
    const bar = this.bars[i]!;
    const st = this.settings;
    const a = p.atr0;
    const ev: SweepEvent = {
      id: `${p.id}#SW${p.sweeps.length + 1}`,
      poolId: p.id,
      side: p.side,
      sequence: p.sweeps.length + 1,
      time: bar.time,
      level: p.level,
      extremePrice: p.s * hi,
      extremeTime: bar.time,
      penetration: hi - L,
      penetrationAtr: (hi - L) / a,
      sweepClose: bar.close,
      kind: cl > L ? 'closeThrough' : 'wick',
      outcome: 'pending',
      reclaimed: false,
      reclaimTime: null,
      barsToReclaim: null,
      acceptedTime: null,
      resolvedTime: null,
    };
    p.sweeps.push(ev);
    p.pending = { ev, startIndex: i, extreme: hi, acceptRun: cl > L + st.acceptTolAtr * a ? 1 : 0 };
    p.armed = false;
    p.inTest = false;
    p.lastInteractionIndex = i;
    this.setState(p, 'SWEPT', bar.time, ev.sequence === 1 ? 'liquidity taken' : `liquidity taken again (sweep ${ev.sequence})`);
    if (cl > L + st.acceptDisplacementAtr * a) this.accept(p, bar.time);
    else if (cl <= L) this.returnToRestingSide(p, i, bar.time);
  }

  private accept(p: PoolRuntime, time: number): void {
    const ev = p.pending!.ev;
    ev.outcome = 'accepted';
    ev.acceptedTime = time;
    ev.resolvedTime = time;
    p.pending = null;
    p.consumedAt = time;
    this.setState(p, 'CONSUMED', time, 'accepted beyond the level (continuation)');
  }

  private returnToRestingSide(p: PoolRuntime, i: number, time: number): void {
    const r = p.pending!;
    const bars = i - r.startIndex;
    if (bars <= this.settings.reclaimWindowBars) {
      r.ev.outcome = 'reclaimed';
      r.ev.reclaimed = true;
      r.ev.reclaimTime = time;
      r.ev.barsToReclaim = bars;
      p.reclaimed = true;
    } else {
      r.ev.outcome = 'returned';
    }
    r.ev.resolvedTime = time;
    p.pending = null;
    p.armed = true;
  }

  /* -------------------------------- output -------------------------------- */

  snapshot(): LiquiditySnapshot {
    const st = this.settings;
    const n = this.bars.length;
    const last = n - 1;
    const atrNow = n ? this.atrs[last]! : Number.NaN;
    const state = n === 0 ? 'NO_DATA' : n < st.minHistoryBars ? 'INSUFFICIENT_HISTORY' : 'READY';
    const price = this.price;
    const f = this.forming;
    const pools: LiquidityPool[] =
      state !== 'READY'
        ? []
        : this.pools.map((p) => {
            const components = liquidityScoreComponents(
              {
                timeframe: this.timeframe,
                state: p.state,
                contributions: p.contributions.length,
                prominenceAtr: p.prominenceAtr,
                displacementAtr: p.displacementAtr,
                tests: p.tests.length,
                barsSinceConfirmation: last - p.confirmedIndex,
                confluence: 0,
              },
              st,
            );
            const distance = price === null ? null : p.level - price;
            const probeable = p.state === 'ACTIVE' || p.state === 'TESTED' || (p.state === 'SWEPT' && p.armed);
            const fHi = f ? (p.s === 1 ? f.high : -f.low) : null;
            return {
              id: p.id,
              instrumentId: this.instrumentId,
              timeframe: this.timeframe,
              side: p.side,
              source: p.source,
              level: p.level,
              rangeLow: p.rangeLow,
              rangeHigh: p.rangeHigh,
              tolerance: p.tolerance,
              createdAt: p.createdAt,
              confirmedAt: p.confirmedAt,
              confirmedIndex: p.confirmedIndex,
              atrAtConfirmation: p.atr0,
              contributions: p.contributions.map((c) => ({ ...c })),
              tests: p.tests.map((t) => ({ ...t })),
              sweeps: p.sweeps.map((e) => ({ ...e })),
              state: p.state,
              stateHistory: p.stateHistory.map((h) => ({ ...h })),
              reclaimed: p.reclaimed,
              consumedAt: p.consumedAt,
              invalidatedAt: p.invalidatedAt,
              lastInteractionAt: p.lastInteractionIndex === null ? null : this.bars[p.lastInteractionIndex]!.time,
              ageBars: last - p.confirmedIndex,
              distance,
              distanceAtr: distance === null || !(atrNow > 0) ? null : Math.abs(distance) / atrNow,
              liveProbe: probeable && fHi !== null && fHi > p.s * p.level + p.tolerance,
              score: finalizeLiquidityScore(components, p.state),
              confluenceIds: [],
            };
          });
    return {
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      state,
      barsProcessed: n,
      requiredBars: st.minHistoryBars,
      lastClosedTime: n ? this.bars[last]!.time : null,
      currentPrice: price,
      atr: atrNow > 0 ? atrNow : null,
      pools,
      swings: this.swings.map((s) => ({ ...s })),
      gaps: this.gaps.map((g) => ({ ...g })),
      settingsKey: liquiditySettingsKey(st),
    };
  }
}

/** One-shot analysis of a full history (identical to incremental updates). */
export function analyzeLiquidity(o: LiquidityEngineOptions & { candles: readonly Candle[]; lastBarClosed?: boolean; currentPrice?: number | null }): LiquiditySnapshot {
  const e = new LiquidityTimeframeEngine(o);
  e.update(o.candles, { lastBarClosed: o.lastBarClosed, currentPrice: o.currentPrice });
  return e.snapshot();
}
