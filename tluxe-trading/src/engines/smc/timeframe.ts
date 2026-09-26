import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { DEFAULT_LIQUIDITY_SETTINGS } from '../liquidity/config';
import { LiquidityTimeframeEngine } from '../liquidity/engine';
import { DEFAULT_OB_SETTINGS } from '../orderBlocks/config';
import { OrderBlockTimeframeEngine } from '../orderBlocks/engine';
import { liquidityViews, orderBlockViews, sweepViews } from './adapters';
import { DEFAULT_SMC_SETTINGS, SMC_TF_SECONDS, type SmcSettings } from './config';
import { rangeLocation } from './range';
import { buildSequences } from './sequence';
import type {
  FvgState,
  SmcBreak,
  SmcDealingRange,
  SmcDirection,
  SmcDisplacement,
  SmcEvent,
  SmcEventType,
  SmcFvg,
  SmcInducement,
  SmcStructureState,
  SmcSwing,
  SmcTimeframeSnapshot,
  SwingLabel,
} from './types';

/* ============================================================================
 * SMC TIMEFRAME ENGINE — one timeframe, its OWN closed candles only (never aligned to another TF).
 * A deterministic left fold over closed bars: the result after bar i depends only on bars 0..i,
 * so incremental processing equals a clean recomputation at every knowledge time (audited).
 *
 * ATR       Wilder ATR(atrPeriod). Detection on bar i normalises by ATR of bar i−1 ("prior ATR",
 *           known before the bar); swings use the ATR of their confirming bar.
 *
 * SWING     bar j is a swing high when high[j] > each of the swingLeft previous highs and
 *           high[j] ≥ each of the swingRight next highs, and high[j] − min(low of j−L … j+R) ≥
 *           swingMinAtr × ATR. It is CONFIRMED on the close of bar j+R (never earlier). Lows mirror.
 *           Label vs the previous confirmed swing of the same kind: |Δ| ≤ equalTolAtr × ATR → EQH / EQL,
 *           higher → HH / HL, lower → LH / LL.
 *
 * BREAK     reference high = the most recent confirmed swing high not yet closed through (lows mirror).
 *           Bullish break: CLOSE − reference high > 0 and ≥ breakMinAtr × prior ATR. A wick beyond the
 *           level without such a close is NOT a break. Kind: against an established bearish trend →
 *           CHOCH; with a bullish trend → BOS; with no trend yet → BOS (initial, establishes trend).
 *           Each swing can be broken once; history is never rewritten.
 *
 * STATE     UNDEFINED  fewer than 2 swing highs or 2 swing lows, or no break yet
 *           RANGING    no break for rangeBars bars, or trend up but latest swings LH + LL (down mirror)
 *           BULLISH / BEARISH  otherwise, from the break-based trend.
 *
 * DISPLACEMENT  run = consecutive bars closing in one direction with body ≥ dispRunMinBodyPct of range.
 *           Qualifies (once per run) when a bar in it has body ≥ dispBodyAtr × prior ATR and
 *           body ≥ dispBodyPct of its range ('single'), or the run has ≥ dispRunBars bars and a net move
 *           (last close − first open) ≥ dispRunAtr × prior ATR ('run').
 *
 * FVG       3 candles c1 c2 c3 (c3 = bar i): bullish when low(c3) > high(c1): [high(c1), low(c3)];
 *           bearish when high(c3) < low(c1): [high(c3), low(c1)]. Size ≥ max(fvgMinAtr × prior ATR, tick).
 *           Boundaries frozen. On later bars: fill % = deepest wick penetration from the near edge;
 *           CLOSE beyond the far edge → INVALIDATED; fill 100 % → FILLED; fill > 0 → PARTIALLY FILLED;
 *           untouched: FRESH (≤ fvgFreshBars) then ACTIVE; EXPIRED after fvgExpiryBars.
 *
 * DEALING RANGE  created by each break. Bullish: low = lowest low from the broken swing's bar to the
 *           break bar; high = highest high since that low (extends with new highs). A CLOSE below the low
 *           invalidates it. Valid only while it spans ≥ rangeMinAtr × ATR. Bearish mirrors.
 *
 * INDUCEMENT CANDIDATE  in a valid bullish range, the FIRST swing low confirmed after the break bar and
 *           above the range low. It is TAKEN when a later bar trades below it while closing above the
 *           range low (range intact); a close through the range low first makes it VOID. Bearish mirrors.
 *
 * Order Blocks and Liquidity come from the UNCHANGED engines (own read-only instances, see adapters).
 * ========================================================================== */

export interface SmcTfOptions {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  tickSize: number;
  settings?: SmcSettings;
}

interface RunState {
  dir: SmcDirection;
  start: number;
  qualified: boolean;
  maxBody: number;
  maxBodyPct: number;
  minBodyPct: number;
}

const same = (a: Candle | undefined, b: Candle | undefined) => !!a && !!b && a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
const TERMINAL: readonly FvgState[] = ['FILLED', 'INVALIDATED', 'EXPIRED'];
const r2 = (x: number) => Math.round(x * 100) / 100;

export class SmcTimeframeEngine {
  readonly instrumentId: InstrumentId;
  readonly timeframe: Timeframe;
  readonly settings: SmcSettings;
  private readonly tick: number;
  private readonly tf: number;
  private readonly ob: OrderBlockTimeframeEngine;
  private readonly lq: LiquidityTimeframeEngine;

  private inputs: Candle[] = [];
  private bars: Candle[] = [];
  private atr: number[] = [];
  private rejected = 0;
  private gaps: { after: number; before: number; missingBars: number }[] = [];
  private swings: SmcSwing[] = [];
  private highCount = 0;
  private lowCount = 0;
  private lastHigh: SmcSwing | null = null;
  private lastLow: SmcSwing | null = null;
  private refHigh: SmcSwing | null = null;
  private refLow: SmcSwing | null = null;
  private trend: SmcDirection | null = null;
  private lastBreakIndex = -1;
  private breaks: SmcBreak[] = [];
  private displacements: SmcDisplacement[] = [];
  private run: RunState | null = null;
  private fvgs: SmcFvg[] = [];
  private open: SmcFvg[] = [];
  private range: SmcDealingRange | null = null;
  private rangeBreakIndex = -1;
  private inducements: SmcInducement[] = [];
  private state: SmcStructureState = 'UNDEFINED';
  private stateEvidence = 'No confirmed structure yet.';
  private events: SmcEvent[] = [];
  private price: number | null = null;

  constructor(o: SmcTfOptions) {
    this.instrumentId = o.instrumentId;
    this.timeframe = o.timeframe;
    this.settings = o.settings ?? { ...DEFAULT_SMC_SETTINGS };
    this.tick = o.tickSize > 0 ? o.tickSize : 0;
    this.tf = SMC_TF_SECONDS[o.timeframe];
    this.ob = new OrderBlockTimeframeEngine({ instrumentId: o.instrumentId, timeframe: o.timeframe, tickSize: o.tickSize, settings: { ...DEFAULT_OB_SETTINGS } });
    this.lq = new LiquidityTimeframeEngine({ instrumentId: o.instrumentId, timeframe: o.timeframe, tickSize: o.tickSize, settings: { ...DEFAULT_LIQUIDITY_SETTINGS } });
  }

  /**
   * Feed CLOSED candles (ascending). Incremental when every consumed candle is unchanged; otherwise
   * (broker revision / history rewrite) the timeframe is rebuilt deterministically and the revised
   * bar times are returned so the caller can log DATA REVISED.
   */
  update(closed: readonly Candle[], currentPrice?: number | null): { rebuilt: boolean; revised: number[] } {
    let ok = closed.length >= this.inputs.length;
    for (let j = 0; ok && j < this.inputs.length; j++) if (this.inputs[j] !== closed[j] && !same(this.inputs[j], closed[j])) ok = false;
    let revised: number[] = [];
    if (!ok) {
      const next = new Map(closed.map((c) => [c.time, c]));
      revised = this.inputs.filter((c) => {
        const n = next.get(c.time);
        return !!n && !same(n, c);
      }).map((c) => c.time);
      this.reset();
    }
    for (let j = this.inputs.length; j < closed.length; j++) {
      const c = closed[j]!;
      this.inputs.push(c);
      const prev = this.bars[this.bars.length - 1];
      if (prev && c.time <= prev.time) this.rejected += 1; // duplicate / out-of-order: never processed
      else this.process(c);
    }
    this.price = currentPrice !== undefined && currentPrice !== null ? currentPrice : this.bars.length ? this.bars[this.bars.length - 1]!.close : null;
    // The unchanged OB / Liquidity engines keep their own incremental state (and rebuild themselves on revisions).
    this.ob.update(this.bars, { lastBarClosed: true, currentPrice: this.price });
    this.lq.update(this.bars, { lastBarClosed: true, currentPrice: this.price });
    return { rebuilt: !ok, revised };
  }

  private reset(): void {
    this.inputs = [];
    this.bars = [];
    this.atr = [];
    this.rejected = 0;
    this.gaps = [];
    this.swings = [];
    this.highCount = 0;
    this.lowCount = 0;
    this.lastHigh = this.lastLow = this.refHigh = this.refLow = null;
    this.trend = null;
    this.lastBreakIndex = -1;
    this.breaks = [];
    this.displacements = [];
    this.run = null;
    this.fvgs = [];
    this.open = [];
    this.range = null;
    this.rangeBreakIndex = -1;
    this.inducements = [];
    this.state = 'UNDEFINED';
    this.stateEvidence = 'No confirmed structure yet.';
    this.events = [];
  }

  /* ------------------------------ helpers ------------------------------ */

  private id(kind: string, t: number, extra = ''): string {
    return `${this.instrumentId}:${this.timeframe}:${kind}:${t}${extra}`;
  }
  private emit(type: SmcEventType, time: number, objectId: string, price: number | null, message: string): void {
    this.events.push({ id: `${this.instrumentId}:${this.timeframe}:${type}:${objectId}`, time, instrumentId: this.instrumentId, timeframe: this.timeframe, type, price, message });
    if (this.events.length > this.settings.maxEvents) this.events.splice(0, this.events.length - this.settings.maxEvents);
  }
  private trim<T>(arr: T[]): void {
    if (arr.length > this.settings.maxObjects) arr.splice(0, arr.length - this.settings.maxObjects);
  }
  private fmt(p: number): string {
    const dec = this.tick > 0 ? Math.max(0, Math.ceil(-Math.log10(this.tick) - 1e-9)) : 5;
    return p.toFixed(dec);
  }

  /* ------------------------------ fold step ----------------------------- */

  private process(bar: Candle): void {
    const s = this.settings;
    const i = this.bars.length;
    const prev = this.bars[i - 1];
    this.bars.push(bar);
    if (prev && bar.time - prev.time > this.tf * 1.5) {
      this.gaps.push({ after: prev.time, before: bar.time, missingBars: Math.round((bar.time - prev.time) / this.tf) - 1 });
      if (this.gaps.length > 100) this.gaps.shift();
    }
    // Wilder ATR (same definition as the other TLUXE candle engines).
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    const p = s.atrPeriod;
    let atr = Number.NaN;
    if (i === p - 1) {
      let sum = tr;
      for (let k = 1; k < p; k++) {
        const b = this.bars[i - k]!;
        const pb = this.bars[i - k - 1];
        sum += pb ? Math.max(b.high - b.low, Math.abs(b.high - pb.close), Math.abs(b.low - pb.close)) : b.high - b.low;
      }
      atr = sum / p;
    } else if (i >= p) atr = (this.atr[i - 1]! * (p - 1) + tr) / p;
    this.atr.push(atr);
    const ap = i > 0 ? this.atr[i - 1]! : Number.NaN;
    const kt = bar.time + this.tf;

    this.updateFvgs(i, bar, kt);
    this.updateInducements(bar, kt, ap);
    this.updateRange(bar, kt);
    if (Number.isFinite(ap) && ap > 0) {
      this.displacement(i, bar, kt, ap);
      this.checkBreaks(i, bar, kt, ap);
      this.createFvg(i, bar, kt, ap);
    }
    if (Number.isFinite(atr) && atr > 0) this.confirmSwings(i, kt, atr);
    this.recomputeState(i, bar, kt);
  }

  /* ------------------------------ displacement --------------------------- */

  private displacement(i: number, bar: Candle, kt: number, ap: number): void {
    const s = this.settings;
    const dir: SmcDirection | null = bar.close > bar.open ? 'bullish' : bar.close < bar.open ? 'bearish' : null;
    const range = bar.high - bar.low;
    const body = Math.abs(bar.close - bar.open);
    const pct = range > 0 ? body / range : 0;
    const ok = dir !== null && pct >= s.dispRunMinBodyPct;
    if (!ok) {
      this.run = null;
      return;
    }
    if (!this.run || this.run.dir !== dir) this.run = { dir, start: i, qualified: false, maxBody: 0, maxBodyPct: 0, minBodyPct: 1 };
    const run = this.run;
    if (body > run.maxBody) {
      run.maxBody = body;
      run.maxBodyPct = pct;
    }
    run.minBodyPct = Math.min(run.minBodyPct, pct);
    if (run.qualified) return;
    const first = this.bars[run.start]!;
    const sign = dir === 'bullish' ? 1 : -1;
    const net = sign * (bar.close - first.open);
    const barsN = i - run.start + 1;
    const single = body >= s.dispBodyAtr * ap && pct >= s.dispBodyPct;
    const multi = barsN >= s.dispRunBars && net >= s.dispRunAtr * ap;
    if (!single && !multi) return;
    run.qualified = true;
    const d: SmcDisplacement = {
      id: this.id('DISP', first.time, `:${dir}`),
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      originTime: first.time,
      confirmedAt: bar.time,
      validFrom: kt,
      direction: dir,
      rule: single ? 'single' : 'run',
      startTime: first.time,
      confirmedIndex: i,
      bars: barsN,
      netMove: net,
      netMoveAtr: net / ap,
      maxBody: run.maxBody,
      maxBodyAtr: run.maxBody / ap,
      maxBodyPct: run.maxBodyPct,
      minBodyPct: run.minBodyPct,
      atr: ap,
      breakId: null,
      evidence: single
        ? `body ${r2(body / ap)} ATR (≥ ${s.dispBodyAtr}) and ${Math.round(pct * 100)}% of range (≥ ${Math.round(s.dispBodyPct * 100)}%)`
        : `${barsN} consecutive ${dir} closes (≥ ${s.dispRunBars}, each body ≥ ${Math.round(s.dispRunMinBodyPct * 100)}%), net ${r2(net / ap)} ATR (≥ ${s.dispRunAtr})`,
    };
    this.displacements.push(d);
    this.trim(this.displacements);
    this.emit('DISPLACEMENT', kt, d.id, bar.close, `${dir === 'bullish' ? 'Bullish' : 'Bearish'} displacement: ${d.evidence}`);
  }

  /* -------------------------------- breaks -------------------------------- */

  private checkBreaks(i: number, bar: Candle, kt: number, ap: number): void {
    const s = this.settings;
    const up = this.refHigh;
    if (up && bar.close - up.price > 0 && bar.close - up.price >= s.breakMinAtr * ap) {
      this.applyBreak(i, bar, kt, ap, up, 'bullish');
      return;
    }
    const dn = this.refLow;
    if (dn && dn.price - bar.close > 0 && dn.price - bar.close >= s.breakMinAtr * ap) this.applyBreak(i, bar, kt, ap, dn, 'bearish');
  }

  private applyBreak(i: number, bar: Candle, kt: number, ap: number, sw: SmcSwing, dir: SmcDirection): void {
    const s = this.settings;
    const initial = this.trend === null;
    const kind: 'BOS' | 'CHOCH' = !initial && this.trend !== dir ? 'CHOCH' : 'BOS';
    const dist = dir === 'bullish' ? bar.close - sw.price : sw.price - bar.close;
    let disp: SmcDisplacement | null = null;
    for (let k = this.displacements.length - 1; k >= 0; k--) {
      const d = this.displacements[k]!;
      if (d.confirmedIndex < i - s.dispBreakWindow) break;
      if (d.direction === dir) {
        disp = d;
        break;
      }
    }
    const br: SmcBreak = {
      id: this.id(kind, bar.time, `:${dir}`),
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      originTime: sw.originTime,
      confirmedAt: bar.time,
      validFrom: kt,
      kind,
      direction: dir,
      swingId: sw.id,
      swingLabel: sw.label,
      level: sw.price,
      breakIndex: i,
      close: bar.close,
      breakDistance: dist,
      breakAtr: dist / ap,
      prevState: this.state,
      initial,
      displacementId: disp?.id ?? null,
      state: 'CONFIRMED',
      evidence: `close ${this.fmt(bar.close)} ${dir === 'bullish' ? 'above' : 'below'} ${sw.label ?? 'swing'} ${this.fmt(sw.price)} by ${r2(dist / ap)} ATR (≥ ${s.breakMinAtr}); ${initial ? 'first break — establishes the trend' : kind === 'CHOCH' ? `against the prior ${this.trend} trend` : `continues the ${dir} trend`}${disp ? `; with displacement (${disp.evidence})` : '; no displacement'}`,
    };
    if (disp && disp.breakId === null) disp.breakId = br.id;
    sw.state = 'BROKEN';
    sw.brokenAt = bar.time;
    if (dir === 'bullish') this.refHigh = null;
    else this.refLow = null;
    this.trend = dir;
    this.lastBreakIndex = i;
    this.breaks.push(br);
    this.trim(this.breaks);
    this.emit(kind === 'CHOCH' ? 'CHOCH CONFIRMED' : 'BOS CONFIRMED', kt, br.id, bar.close, `${dir === 'bullish' ? 'Bullish' : 'Bearish'} ${kind}${initial ? ' (initial)' : ''}: ${br.evidence}`);
    this.newRange(i, bar, kt, ap, sw, br);
  }

  /* ----------------------------- dealing range ---------------------------- */

  private newRange(i: number, bar: Candle, kt: number, ap: number, sw: SmcSwing, br: SmcBreak): void {
    // Void the previous range's untaken inducement (its range no longer applies).
    for (const x of this.inducements) if (x.state === 'UNTAKEN') x.state = 'VOID';
    const bull = br.direction === 'bullish';
    let ext = bull ? Infinity : -Infinity;
    let extIdx = sw.originIndex;
    for (let k = sw.originIndex; k <= i; k++) {
      const b = this.bars[k]!;
      if (bull ? b.low < ext : b.high > ext) {
        ext = bull ? b.low : b.high;
        extIdx = k;
      }
    }
    let far = bull ? -Infinity : Infinity;
    let farIdx = extIdx;
    for (let k = extIdx; k <= i; k++) {
      const b = this.bars[k]!;
      if (bull ? b.high > far : b.low < far) {
        far = bull ? b.high : b.low;
        farIdx = k;
      }
    }
    const high = bull ? far : ext;
    const low = bull ? ext : far;
    this.range = {
      id: this.id('DR', bar.time, `:${br.direction}`),
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      originTime: this.bars[extIdx]!.time,
      confirmedAt: bar.time,
      validFrom: kt,
      direction: br.direction,
      high,
      low,
      eq: (high + low) / 2,
      highTime: this.bars[bull ? farIdx : extIdx]!.time,
      lowTime: this.bars[bull ? extIdx : farIdx]!.time,
      anchorBreakId: br.id,
      sizeAtr: (high - low) / ap,
      state: 'VALID',
      invalidatedAt: null,
      evidence: `${br.kind} ${br.direction}: ${bull ? 'low' : 'high'} = ${bull ? 'lowest low' : 'highest high'} from the broken swing to the break (${this.fmt(ext)}); ${bull ? 'high' : 'low'} = ${bull ? 'highest high' : 'lowest low'} since (${this.fmt(far)})`,
    };
    this.rangeBreakIndex = i;
    this.emit('DEALING RANGE CHANGED', kt, this.range.id, null, `New ${br.direction} dealing range ${this.fmt(low)} – ${this.fmt(high)} (EQ ${this.fmt((high + low) / 2)}) from the ${br.kind}.`);
  }

  private updateRange(bar: Candle, kt: number): void {
    const r = this.range;
    if (!r || r.state !== 'VALID') return;
    if (r.direction === 'bullish') {
      if (bar.close < r.low) {
        r.state = 'INVALIDATED';
        r.invalidatedAt = bar.time;
        this.emit('DEALING RANGE CHANGED', kt, `${r.id}:invalidated`, bar.close, `Bullish dealing range invalidated: close ${this.fmt(bar.close)} below its low ${this.fmt(r.low)}.`);
        return;
      }
      if (bar.high > r.high) {
        r.high = bar.high;
        r.highTime = bar.time;
        r.eq = (r.high + r.low) / 2;
      }
    } else {
      if (bar.close > r.high) {
        r.state = 'INVALIDATED';
        r.invalidatedAt = bar.time;
        this.emit('DEALING RANGE CHANGED', kt, `${r.id}:invalidated`, bar.close, `Bearish dealing range invalidated: close ${this.fmt(bar.close)} above its high ${this.fmt(r.high)}.`);
        return;
      }
      if (bar.low < r.low) {
        r.low = bar.low;
        r.lowTime = bar.time;
        r.eq = (r.high + r.low) / 2;
      }
    }
  }

  /* ------------------------------ inducement ------------------------------ */

  private updateInducements(bar: Candle, kt: number, ap: number): void {
    const r = this.range;
    for (const x of this.inducements) {
      if (x.state !== 'UNTAKEN') continue;
      if (!r || r.id !== x.rangeId || r.state !== 'VALID') {
        x.state = 'VOID';
        continue;
      }
      const bull = x.direction === 'bullish';
      const beyond = bull ? bar.low < x.price : bar.high > x.price;
      if (!beyond) continue;
      const intact = bull ? bar.close > r.low : bar.close < r.high;
      if (!intact) {
        x.state = 'VOID';
        continue;
      }
      x.state = 'TAKEN';
      x.takenAt = bar.time;
      x.penetrationAtr = Number.isFinite(ap) && ap > 0 ? (bull ? x.price - bar.low : bar.high - x.price) / ap : null;
      x.zoneAtTake = rangeLocation(r, bull ? bar.low : bar.high, this.settings).zone;
      x.evidence += `; taken ${new Date(bar.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC by ${x.penetrationAtr === null ? '—' : r2(x.penetrationAtr)} ATR, close kept the range (${x.zoneAtTake.replace('_', ' ')})`;
      this.emit('INDUCEMENT CANDIDATE', kt, x.id, x.price, `${bull ? 'Bullish' : 'Bearish'} inducement candidate taken at ${this.fmt(x.price)} (${x.zoneAtTake.replace('_', ' ')}); range still valid.`);
    }
  }

  private identifyInducement(sw: SmcSwing): void {
    const r = this.range;
    if (!r || r.state !== 'VALID' || sw.confirmedIndex <= this.rangeBreakIndex) return;
    if (this.inducements.some((x) => x.rangeId === r.id)) return;
    const bull = r.direction === 'bullish';
    if (bull ? sw.kind !== 'low' || sw.price <= r.low : sw.kind !== 'high' || sw.price >= r.high) return;
    this.inducements.push({
      id: this.id('IDM', sw.originTime, `:${r.direction}`),
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      originTime: sw.originTime,
      confirmedAt: sw.confirmedAt,
      validFrom: sw.validFrom,
      direction: r.direction,
      price: sw.price,
      swingId: sw.id,
      rangeId: r.id,
      state: 'UNTAKEN',
      takenAt: null,
      penetrationAtr: null,
      zoneAtTake: null,
      evidence: `first swing ${sw.kind} (${this.fmt(sw.price)}) confirmed inside the ${r.direction} dealing range after its break`,
    });
    this.trim(this.inducements);
  }

  /* ---------------------------------- FVG --------------------------------- */

  private createFvg(i: number, bar: Candle, kt: number, ap: number): void {
    if (i < 2) return;
    const c1 = this.bars[i - 2]!;
    const c2 = this.bars[i - 1]!;
    const min = Math.max(this.settings.fvgMinAtr * ap, this.tick);
    let dir: SmcDirection | null = null;
    let lower = 0;
    let upper = 0;
    if (bar.low > c1.high && bar.low - c1.high >= min) {
      dir = 'bullish';
      lower = c1.high;
      upper = bar.low;
    } else if (bar.high < c1.low && c1.low - bar.high >= min) {
      dir = 'bearish';
      lower = bar.high;
      upper = c1.low;
    }
    if (!dir) return;
    const size = upper - lower;
    const f: SmcFvg = {
      id: this.id('FVG', c2.time, `:${dir}`),
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      originTime: c2.time,
      confirmedAt: bar.time,
      validFrom: kt,
      direction: dir,
      upper,
      lower,
      mid: (upper + lower) / 2,
      size,
      sizeAtr: size / ap,
      createdIndex: i,
      state: 'FRESH',
      fillPct: 0,
      firstTouchAt: null,
      filledAt: null,
      invalidatedAt: null,
      expiredAt: null,
      ageBars: 0,
      history: [{ to: 'FRESH', time: bar.time }],
      evidence: dir === 'bullish' ? `low of candle 3 (${this.fmt(upper)}) above high of candle 1 (${this.fmt(lower)}); ${r2(size / ap)} ATR` : `high of candle 3 (${this.fmt(lower)}) below low of candle 1 (${this.fmt(upper)}); ${r2(size / ap)} ATR`,
    };
    this.fvgs.push(f);
    this.open.push(f);
    this.trim(this.fvgs);
    this.emit('FVG CREATED', kt, f.id, f.mid, `${dir === 'bullish' ? 'Bullish' : 'Bearish'} FVG ${this.fmt(lower)} – ${this.fmt(upper)} (${r2(size / ap)} ATR).`);
  }

  private setFvg(f: SmcFvg, to: FvgState, t: number): void {
    if (f.state === to) return;
    f.state = to;
    f.history.push({ to, time: t });
  }

  private updateFvgs(i: number, bar: Candle, kt: number): void {
    const s = this.settings;
    let w = 0;
    for (const f of this.open) {
      if (f.createdIndex >= i) {
        this.open[w++] = f;
        continue;
      }
      f.ageBars = i - f.createdIndex;
      const bull = f.direction === 'bullish';
      const depth = bull ? f.upper - bar.low : bar.high - f.lower;
      const pct = Math.max(0, Math.min(100, (depth / f.size) * 100));
      if (pct > f.fillPct) f.fillPct = pct;
      if (f.fillPct > 0 && f.firstTouchAt === null) f.firstTouchAt = bar.time;
      if (bull ? bar.close < f.lower : bar.close > f.upper) {
        this.setFvg(f, 'INVALIDATED', bar.time);
        f.invalidatedAt = bar.time;
        this.emit('FVG INVALIDATED', kt, f.id, bar.close, `${bull ? 'Bullish' : 'Bearish'} FVG ${this.fmt(f.lower)} – ${this.fmt(f.upper)} invalidated: close ${this.fmt(bar.close)} beyond its far edge.`);
      } else if (f.fillPct >= 100) {
        this.setFvg(f, 'FILLED', bar.time);
        f.filledAt = bar.time;
        this.emit('FVG FILLED', kt, f.id, f.mid, `${bull ? 'Bullish' : 'Bearish'} FVG ${this.fmt(f.lower)} – ${this.fmt(f.upper)} fully filled.`);
      } else if (f.fillPct > 0) {
        if (f.state !== 'PARTIALLY_FILLED') this.emit('FVG PARTIALLY FILLED', kt, f.id, f.mid, `${bull ? 'Bullish' : 'Bearish'} FVG ${this.fmt(f.lower)} – ${this.fmt(f.upper)} partially filled (${Math.round(f.fillPct)}%).`);
        this.setFvg(f, 'PARTIALLY_FILLED', bar.time);
      } else if (f.ageBars > s.fvgFreshBars) this.setFvg(f, 'ACTIVE', bar.time);
      if (!TERMINAL.includes(f.state) && s.fvgExpiryBars > 0 && f.ageBars >= s.fvgExpiryBars) {
        this.setFvg(f, 'EXPIRED', bar.time);
        f.expiredAt = bar.time;
      }
      if (!TERMINAL.includes(f.state)) this.open[w++] = f;
    }
    this.open.length = w;
  }

  /* --------------------------------- swings -------------------------------- */

  private confirmSwings(i: number, kt: number, atr: number): void {
    const { swingLeft: L, swingRight: R } = this.settings;
    const j = i - R;
    if (j - L < 0) return;
    const b = this.bars[j]!;
    let isHigh = true;
    let isLow = true;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = j - L; k <= i; k++) {
      const x = this.bars[k]!;
      lo = Math.min(lo, x.low);
      hi = Math.max(hi, x.high);
      if (k === j) continue;
      if (k < j) {
        if (x.high >= b.high) isHigh = false;
        if (x.low <= b.low) isLow = false;
      } else {
        if (x.high > b.high) isHigh = false;
        if (x.low < b.low) isLow = false;
      }
    }
    const min = this.settings.swingMinAtr * atr;
    if (isHigh && b.high - lo >= min) this.addSwing('high', j, i, kt, atr, (b.high - lo) / atr);
    if (isLow && hi - b.low >= min) this.addSwing('low', j, i, kt, atr, (hi - b.low) / atr);
  }

  private addSwing(kind: 'high' | 'low', j: number, i: number, kt: number, atr: number, prominenceAtr: number): void {
    const b = this.bars[j]!;
    const price = kind === 'high' ? b.high : b.low;
    const prev = kind === 'high' ? this.lastHigh : this.lastLow;
    const tol = this.settings.equalTolAtr * atr;
    let label: SwingLabel | null = null;
    if (prev) {
      const d = price - prev.price;
      label = Math.abs(d) <= tol ? (kind === 'high' ? 'EQH' : 'EQL') : d > 0 ? (kind === 'high' ? 'HH' : 'HL') : kind === 'high' ? 'LH' : 'LL';
    }
    const sw: SmcSwing = {
      id: this.id(kind === 'high' ? 'SH' : 'SL', b.time),
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      originTime: b.time,
      confirmedAt: this.bars[i]!.time,
      validFrom: kt,
      kind,
      price,
      originIndex: j,
      confirmedIndex: i,
      label,
      prevPrice: prev?.price ?? null,
      atr,
      prominenceAtr,
      state: 'ACTIVE',
      brokenAt: null,
      evidence: `${kind === 'high' ? 'high' : 'low'} ${this.fmt(price)} beyond ${this.settings.swingLeft} bars left and ${this.settings.swingRight} closed bars right; prominence ${r2(prominenceAtr)} ATR${prev ? `; vs previous ${this.fmt(prev.price)} → ${label}` : ''}`,
    };
    this.swings.push(sw);
    this.trim(this.swings);
    if (kind === 'high') {
      this.lastHigh = sw;
      this.refHigh = sw;
      this.highCount += 1;
    } else {
      this.lastLow = sw;
      this.refLow = sw;
      this.lowCount += 1;
    }
    this.emit('SWING CONFIRMED', kt, sw.id, price, `Swing ${kind} ${this.fmt(price)}${label ? ` (${label})` : ''} confirmed.`);
    this.identifyInducement(sw);
  }

  /* ---------------------------------- state -------------------------------- */

  private recomputeState(i: number, bar: Candle, kt: number): void {
    let st: SmcStructureState;
    let ev: string;
    const labels = `${this.lastHigh?.label ?? '—'} + ${this.lastLow?.label ?? '—'}`;
    if (this.highCount < 2 || this.lowCount < 2) {
      st = 'UNDEFINED';
      ev = `Needs ≥ 2 confirmed swing highs and lows (have ${this.highCount} / ${this.lowCount}).`;
    } else if (this.trend === null) {
      st = 'UNDEFINED';
      ev = 'No structural break (close through a swing) yet.';
    } else if (i - this.lastBreakIndex > this.settings.rangeBars) {
      st = 'RANGING';
      ev = `No structural break for ${i - this.lastBreakIndex} bars (> ${this.settings.rangeBars}); last swings ${labels}.`;
    } else if (this.trend === 'bullish') {
      const against = this.lastHigh?.label === 'LH' && this.lastLow?.label === 'LL';
      st = against ? 'RANGING' : 'BULLISH';
      ev = against ? `Bullish break-trend but latest swings ${labels} — no CHOCH close yet.` : `Bullish since the last break; last swings ${labels}.`;
    } else {
      const against = this.lastHigh?.label === 'HH' && this.lastLow?.label === 'HL';
      st = against ? 'RANGING' : 'BEARISH';
      ev = against ? `Bearish break-trend but latest swings ${labels} — no CHOCH close yet.` : `Bearish since the last break; last swings ${labels}.`;
    }
    if (st !== this.state) this.emit('STRUCTURE CHANGED', kt, `${bar.time}`, bar.close, `Structure ${this.state} → ${st}: ${ev}`);
    this.state = st;
    this.stateEvidence = ev;
  }

  /* --------------------------------- snapshot ------------------------------ */

  snapshot(): SmcTimeframeSnapshot {
    const s = this.settings;
    const n = this.bars.length;
    const last = this.bars[n - 1] ?? null;
    const atr = n ? this.atr[n - 1]! : Number.NaN;
    const atrOk = Number.isFinite(atr) && atr > 0;
    const obSnap = this.ob.snapshot();
    const lqSnap = this.lq.snapshot();
    const breaks = this.breaks.map((b) => ({ ...b }));
    const orderBlocks = orderBlockViews(obSnap);
    const liquidity = liquidityViews(lqSnap);
    const sweeps = sweepViews(lqSnap, breaks, s.seqLookbackBars * this.tf);
    const fvgs = this.fvgs.map((f) => ({ ...f, history: [...f.history] }));
    const displacements = this.displacements.map((d) => ({ ...d }));
    const range: SmcDealingRange | null = this.range ? { ...this.range } : null;
    let rangeUnavailable: string | null = null;
    if (!range) rangeUnavailable = 'DEALING RANGE UNAVAILABLE — no structural break yet.';
    else if (range.state !== 'VALID') rangeUnavailable = 'DEALING RANGE UNAVAILABLE — the last range was invalidated by a close through its extreme.';
    else if (!atrOk) rangeUnavailable = 'DEALING RANGE UNAVAILABLE — ATR not available.';
    else {
      range.sizeAtr = (range.high - range.low) / atr;
      if (range.sizeAtr < s.rangeMinAtr) rangeUnavailable = `DEALING RANGE UNAVAILABLE — range spans ${r2(range.sizeAtr)} ATR (< ${s.rangeMinAtr}).`;
    }
    const location = !rangeUnavailable && range && this.price !== null ? rangeLocation(range, this.price, s) : null;
    const kt = last ? last.time + this.tf : null;
    const dataState = n === 0 ? 'NO_DATA' : n < s.minHistoryBars ? 'INSUFFICIENT_DATA' : 'READY';
    // Events from the reused engines (their output, not re-detected): OB mitigation, liquidity sweeps.
    const derived: SmcEvent[] = [];
    for (const b of orderBlocks)
      if (b.mitigatedAt !== null)
        derived.push({ id: `${this.instrumentId}:${this.timeframe}:OB MITIGATED:${b.id}`, time: b.mitigatedAt + this.tf, instrumentId: this.instrumentId, timeframe: this.timeframe, type: 'OB MITIGATED', price: b.mid, message: `${b.direction === 'bullish' ? 'Bullish' : 'Bearish'} OB ${this.fmt(b.low)} – ${this.fmt(b.high)} mitigated (${Math.round(b.mitigationPct)}%).` });
    for (const w of sweeps)
      derived.push({ id: `${this.instrumentId}:${this.timeframe}:LIQUIDITY SWEPT:${w.id}`, time: w.time + this.tf, instrumentId: this.instrumentId, timeframe: this.timeframe, type: 'LIQUIDITY SWEPT', price: w.level, message: `${w.side} ${this.fmt(w.level)} swept (${w.kind === 'wick' ? 'wick' : 'close through'}, ${r2(w.penetrationAtr)} ATR).` });
    const events = [...this.events, ...derived].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const base = {
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      dataState,
      barsProcessed: n,
      requiredBars: s.minHistoryBars,
      rejectedBars: this.rejected,
      lastClosedTime: last?.time ?? null,
      knowledgeTime: kt,
      atr: atrOk ? atr : null,
      price: this.price,
      state: this.state,
      trend: this.trend,
      stateEvidence: this.stateEvidence,
      lastBreakAt: this.lastBreakIndex >= 0 ? this.bars[this.lastBreakIndex]!.time : null,
      swings: this.swings.map((x) => ({ ...x })),
      lastHigh: this.lastHigh ? { ...this.lastHigh } : null,
      lastLow: this.lastLow ? { ...this.lastLow } : null,
      refHigh: this.refHigh ? { ...this.refHigh } : null,
      refLow: this.refLow ? { ...this.refLow } : null,
      breaks,
      displacements,
      fvgs,
      range,
      location,
      rangeUnavailable,
      inducements: this.inducements.map((x) => ({ ...x })),
      orderBlocks,
      liquidity,
      sweeps,
      events,
      gaps: this.gaps.map((g) => ({ ...g })),
    } satisfies Omit<SmcTimeframeSnapshot, 'sequences'>;
    return { ...base, sequences: buildSequences(base, kt, s.seqLookbackBars * this.tf) };
  }
}
