import type { InstrumentId } from '../../types/instruments';
import type { Candle } from '../../types/market';
import { DEFAULT_OB_SETTINGS } from '../orderBlocks/config';
import { OrderBlockTimeframeEngine } from '../orderBlocks/engine';
import type { OrderBlock } from '../orderBlocks/types';
import { DEFAULT_HLR_SETTINGS, HLR_TF_ORDER, HLR_TF_SECONDS, HLR_TIMEFRAMES, hlrSettingsKey, type HLRSettings } from './config';
import { finalizeHLRScore, hlrScoreComponents } from './score';
import { Series } from './structure';
import type {
  EntryStatus,
  EntryZone,
  H4Context,
  HLRBreak,
  HLREvent,
  HLRSnapshot,
  HLRSwing,
  HLRTfStatus,
  HLRTimeframe,
  KeyLevel,
  Setup,
  SetupState,
  ZoneSource,
} from './types';
import { TERMINAL_STATES } from './types';

/* ============================================================================
 * High / Low Reversal Engine v1 — one instrument, five timeframes. Pure, deterministic.
 * Its own engine, state machine and score. It reads the Order Blocks v1 engine's public
 * output (its own read-only instances with Order Blocks' default settings) for entry zones;
 * it never changes S&R, Liquidity or Order Blocks.
 *
 * CLOSED BARS ONLY. Bars from all timeframes are processed in the order they became
 * knowable (close time); bars that close at the same instant go H4 → H1 → M15 → M5 → M1.
 * A stage can therefore only use information that existed when it happened.
 *
 * BUY (important H1 low). SELL mirrors every rule exactly (frame negation, s = −1).
 *  H4       context only (BULLISH / BEARISH / NEUTRAL / INSUFFICIENT DATA from the last two
 *           confirmed H4 swing highs and lows). It never creates or blocks a setup; a BUY
 *           under a BEARISH H4 (or SELL under BULLISH) is flagged counter-trend.
 *  H1       an H1 swing low (3 left / 3 right) is IMPORTANT when it is below each of the
 *           previous h1DominanceBars lows and price moved ≥ h1MinProminenceAtr × H1 ATR away
 *           from it (prior window + confirmation bars). Price and identity freeze at
 *           confirmation. A later swing within equalTolAtr × ATR = equal low (merged).
 *           Each important level starts one setup: WATCHING_LEVEL.
 *  M15      (bars opening after the level was confirmed)
 *           TOUCHED          low within touchTolAtr × level ATR, not below the level
 *           LIQUIDITY_TAKEN  low below the level (sweep bar; extreme tracked until reclaim)
 *           SWEPT            a close back above the level, not yet by the reclaim margin
 *           RECLAIMED        a close ≥ level + reclaimMarginAtr × M15 ATR within reclaimWindowBars
 *           FAILED_RECLAIM   no reclaim within the window
 *           INVALIDATED      penetration > maxPenetrationAtr × level ATR, or a close ≥ acceptCloseAtr
 *                            × level ATR below the level (acceptance / breakout)
 *  M5       (bars closing at or after the reclaim) a bullish CHOCH/BOS CLOSE through the most
 *           recent confirmed M5 swing high, with displacement: sweep extreme → break close
 *           ≥ minDisplacementAtr × M5 ATR and one body ≥ minDisplacementBodyAtr × M5 ATR.
 *           An M5 close below the sweep extreme = INVALIDATED; no confirmation within
 *           m5WindowBars = EXPIRED. → M5_CONFIRMED.
 *  ZONE     defined at the confirmation close, from data known then, inside the leg
 *           (sweep extreme … break close): Order Blocks v1 bullish blocks on M5 / M1
 *           (live, origin at/after the sweep bar) and own M1 fair-value gaps (unfilled).
 *           Preference: OB overlapping an FVG (OB+FVG) › OB › FVG; ties → nearest to price.
 *           None → no entry (stays M5_CONFIRMED, then EXPIRED). → M1_PULLBACK_PENDING.
 *  M1       (bars opening at/after the confirmation close)
 *           ENTRY_READY  low enters the zone (≤ zone high) and the bar closes ≥ zone low
 *           INVALIDATED  a close below the zone low (checked first)
 *           MISSED       TP1 reached before any pullback into the zone
 *           EXPIRED      no pullback within m1PullbackWindowBars
 *           TRIGGERED    after ENTRY_READY, an M1 close back above the zone high
 *                        (INVALIDATED on a close below the zone low; EXPIRED after m1TriggerWindowBars)
 *  RISK     entry = zone midpoint · stop = sweep extreme − slBufferAtr × M5 ATR · TP1 = highest
 *           M5 high of the leg (sweep → confirmation) · TP2 = nearest untaken important H1 high
 *           beyond TP1 (none → null). R:R = reward ÷ (entry − stop).
 * States only move forward; nothing is ever rewritten. ENTRY_READY is reached only when every
 * gate (level, sweep, reclaim, M5 confirmation with displacement, zone, pullback) exists.
 * The score is descriptive and is never consulted by the state machine.
 * ========================================================================== */

export type HLRInput = Partial<Record<HLRTimeframe, readonly Candle[]>>;

export interface HLREngineOptions {
  instrumentId: InstrumentId;
  tickSize: number;
  settings?: HLRSettings;
}

interface LevelRt {
  l: KeyLevel;
  confirmIndex: number;
}
interface SetupRt {
  s: Setup;
  sign: 1 | -1;
  lvl: LevelRt;
}
type FBar = { o: number; h: number; l: number; c: number };

const OPEN: readonly SetupState[] = ['WATCHING_LEVEL', 'LIQUIDITY_TAKEN', 'RECLAIMED', 'M5_CONFIRMATION_PENDING', 'M5_CONFIRMED', 'M1_PULLBACK_PENDING', 'ENTRY_READY'];
const same = (a: Candle | undefined, b: Candle | null) => !!a && !!b && a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
const frame = (sign: 1 | -1, c: Candle): FBar => (sign === 1 ? { o: c.open, h: c.high, l: c.low, c: c.close } : { o: -c.open, h: -c.low, l: -c.high, c: -c.close });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function entryStatusOf(state: SetupState): EntryStatus {
  switch (state) {
    case 'WATCHING_LEVEL':
      return 'WAIT';
    case 'LIQUIDITY_TAKEN':
    case 'RECLAIMED':
    case 'M5_CONFIRMATION_PENDING':
    case 'M5_CONFIRMED':
      return 'SETUP_FORMING';
    case 'M1_PULLBACK_PENDING':
      return 'PULLBACK_WAIT';
    case 'ENTRY_READY':
      return 'ENTRY_READY';
    case 'TRIGGERED':
      return 'TRIGGERED';
    case 'MISSED':
      return 'MISSED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'INVALIDATED';
  }
}

/** Every mandatory gate for ENTRY_READY, from the setup's own recorded evidence. */
export function entryGates(s: Setup): { level: boolean; sweep: boolean; reclaim: boolean; m5: boolean; zone: boolean; pullback: boolean } {
  return {
    level: s.level > 0 && s.levelConfirmedAt > 0,
    sweep: !!s.sweep && s.sweep.time >= s.levelConfirmedAt,
    reclaim: !!s.reclaim && !!s.sweep && s.reclaim.knownAt >= s.sweep.knownAt,
    m5: !!s.m5 && !!s.reclaim && s.m5.knownAt >= s.reclaim.knownAt,
    zone: !!s.zone && !!s.m5 && s.zone.definedAt === s.m5.knownAt,
    pullback: !!s.entry && !!s.m5 && s.entry.time >= s.m5.knownAt,
  };
}

const stageTfOf = (state: SetupState): HLRTimeframe | null =>
  state === 'WATCHING_LEVEL' ? 'H1' : state === 'LIQUIDITY_TAKEN' ? 'M15' : state === 'RECLAIMED' || state === 'M5_CONFIRMATION_PENDING' ? 'M5' : OPEN.includes(state) || state === 'TRIGGERED' ? 'M1' : null;

export class HighLowReversalEngine {
  readonly instrumentId: InstrumentId;
  readonly settings: HLRSettings;
  private readonly tick: number;
  private series!: Record<HLRTimeframe, Series>;
  private accepted!: Record<HLRTimeframe, Candle[]>;
  private processed!: Record<HLRTimeframe, number>;
  private consumed!: Record<HLRTimeframe, number>;
  private firstInput!: Record<HLRTimeframe, Candle | null>;
  private lastInput!: Record<HLRTimeframe, Candle | null>;
  private rejected!: Record<HLRTimeframe, number>;
  private lastKey: [number, number] | null = null;
  private levels: LevelRt[] = [];
  private setups: SetupRt[] = [];
  private events: HLREvent[] = [];
  private obM5!: OrderBlockTimeframeEngine;
  private obM1!: OrderBlockTimeframeEngine;
  private price: number | null = null;

  constructor(o: HLREngineOptions) {
    this.instrumentId = o.instrumentId;
    this.settings = o.settings ?? { ...DEFAULT_HLR_SETTINGS };
    this.tick = o.tickSize > 0 ? o.tickSize : 0;
    this.reset();
  }

  private reset(): void {
    const st = this.settings;
    const mk = <T>(f: (tf: HLRTimeframe) => T) => Object.fromEntries(HLR_TIMEFRAMES.map((tf) => [tf, f(tf)])) as Record<HLRTimeframe, T>;
    this.series = {
      H4: new Series(HLR_TF_SECONDS.H4, st.h4SwingLeft, st.h4SwingRight, st.atrPeriod),
      H1: new Series(HLR_TF_SECONDS.H1, st.h1SwingLeft, st.h1SwingRight, st.atrPeriod),
      M15: new Series(HLR_TF_SECONDS.M15, 3, 3, st.atrPeriod),
      M5: new Series(HLR_TF_SECONDS.M5, st.m5SwingLeft, st.m5SwingRight, st.atrPeriod),
      M1: new Series(HLR_TF_SECONDS.M1, 3, 3, st.atrPeriod),
    };
    this.accepted = mk(() => []);
    this.processed = mk(() => 0);
    this.consumed = mk(() => 0);
    this.firstInput = mk(() => null);
    this.lastInput = mk(() => null);
    this.rejected = mk(() => 0);
    this.lastKey = null;
    this.levels = [];
    this.setups = [];
    this.events = [];
    this.obM5 = new OrderBlockTimeframeEngine({ instrumentId: this.instrumentId, timeframe: 'M5', tickSize: this.tick, settings: { ...DEFAULT_OB_SETTINGS } });
    this.obM1 = new OrderBlockTimeframeEngine({ instrumentId: this.instrumentId, timeframe: 'M1', tickSize: this.tick, settings: { ...DEFAULT_OB_SETTINGS } });
  }

  /**
   * Feed CLOSED candles per timeframe (each ascending). Incremental when the input
   * extends what was consumed and nothing new is older than what was processed;
   * otherwise the engine rebuilds from scratch (identical result by construction).
   */
  update(input: HLRInput, o: { currentPrice?: number | null } = {}): void {
    if (!this.ingest(input)) {
      this.reset();
      this.ingest(input);
    }
    this.run();
    const m1 = this.accepted.M1;
    this.price = o.currentPrice !== undefined ? o.currentPrice : m1.length ? m1[m1.length - 1]!.close : null;
  }

  private ingest(input: HLRInput): boolean {
    for (const tf of HLR_TIMEFRAMES) {
      const arr = input[tf] ?? [];
      const n = this.consumed[tf];
      if (n > arr.length || (n > 0 && (!same(arr[0], this.firstInput[tf]) || !same(arr[n - 1], this.lastInput[tf])))) return false;
    }
    for (const tf of HLR_TIMEFRAMES) {
      const arr = input[tf] ?? [];
      const acc = this.accepted[tf];
      for (let j = this.consumed[tf]; j < arr.length; j++) {
        const c = arr[j]!;
        const prev = acc[acc.length - 1];
        if (prev && c.time <= prev.time) this.rejected[tf] += 1;
        else acc.push(c);
      }
      if (arr.length) {
        this.firstInput[tf] = arr[0]!;
        this.lastInput[tf] = arr[arr.length - 1]!;
      }
      this.consumed[tf] = arr.length;
      const next = acc[this.processed[tf]];
      if (next && this.lastKey) {
        const k: [number, number] = [next.time + HLR_TF_SECONDS[tf], HLR_TF_ORDER[tf]];
        if (k[0] < this.lastKey[0] || (k[0] === this.lastKey[0] && k[1] < this.lastKey[1])) return false;
      }
    }
    return true;
  }

  private run(): void {
    for (;;) {
      let best: HLRTimeframe | null = null;
      let bk = Infinity;
      for (const tf of HLR_TIMEFRAMES) {
        const b = this.accepted[tf][this.processed[tf]];
        if (!b) continue;
        const k = b.time + HLR_TF_SECONDS[tf];
        if (k < bk) {
          bk = k;
          best = tf;
        }
      }
      if (!best) return;
      const bar = this.accepted[best][this.processed[best]]!;
      this.processed[best] += 1;
      this.lastKey = [bk, HLR_TF_ORDER[best]];
      this.process(best, bar);
    }
  }

  private process(tf: HLRTimeframe, bar: Candle): void {
    const r = this.series[tf].push(bar);
    if (tf === 'H1') this.onH1(r.swings);
    else if (tf === 'M15') this.onM15(bar);
    else if (tf === 'M5') this.onM5(bar, r.breaks);
    else if (tf === 'M1') this.onM1(bar);
  }

  /* ------------------------------- context -------------------------------- */

  h4Context(): H4Context {
    const ser = this.series.H4;
    const highs = ser.lastSwings('high', 3);
    const lows = ser.lastSwings('low', 3);
    const last = <T>(a: T[], k: number) => a[a.length - k] ?? null;
    const base = {
      lastSwingHigh: last(highs, 1),
      prevSwingHigh: last(highs, 2),
      lastSwingLow: last(lows, 1),
      prevSwingLow: last(lows, 2),
      lastBreak: ser.breaks[ser.breaks.length - 1] ?? null,
      barsProcessed: ser.length,
    };
    if (ser.length < this.settings.minBars.H4 || highs.length < 2 || lows.length < 2)
      return { ...base, state: 'INSUFFICIENT_DATA', structure: 'Not enough confirmed H4 swings', highs: null, lows: null, strength: 0 };
    const h = highs[highs.length - 1]!.price > highs[highs.length - 2]!.price ? 'HH' : 'LH';
    const l = lows[lows.length - 1]!.price > lows[lows.length - 2]!.price ? 'HL' : 'LL';
    const state = h === 'HH' && l === 'HL' ? 'BULLISH' : h === 'LH' && l === 'LL' ? 'BEARISH' : 'NEUTRAL';
    let agree = 0;
    let total = 0;
    for (const arr of [highs, lows])
      for (let k = 1; k < arr.length; k++) {
        total += 1;
        const up = arr[k]!.price > arr[k - 1]!.price;
        if ((state === 'BULLISH' && up) || (state === 'BEARISH' && !up)) agree += 1;
      }
    const names = { HH: 'Higher Highs', LH: 'Lower Highs', HL: 'Higher Lows', LL: 'Lower Lows' };
    return { ...base, state, structure: `${names[h]} + ${names[l]}`, highs: h, lows: l, strength: state === 'NEUTRAL' ? 0 : Math.round((100 * agree) / total) };
  }

  /* ---------------------------------- H1 ---------------------------------- */

  private onH1(swings: HLRSwing[]): void {
    const st = this.settings;
    const ser = this.series.H1;
    const i = ser.length - 1;
    const atr = ser.atr();
    const bar = ser.bars[i]!;
    const m15 = this.series.M15;
    const m15Covers = m15.length > 0 && m15.bars[m15.length - 1]!.time >= bar.time;
    for (const rt of this.setups) {
      if (rt.s.state !== 'WATCHING_LEVEL' || i <= rt.lvl.confirmIndex) continue;
      rt.lvl.l.ageBars = i - rt.lvl.confirmIndex;
      // Traded beyond while no M15 history covers this hour: the sweep can never be verified.
      if (!m15Covers && frame(rt.sign, bar).l < rt.sign * rt.s.level) {
        rt.lvl.l.status = 'BROKEN';
        this.setState(rt, 'INVALIDATED', ser.knownAt(i), 'H1 traded beyond the level before M15 history was available — sweep not verifiable');
      } else if (rt.lvl.l.ageBars >= st.levelExpiryBars) this.setState(rt, 'EXPIRED', ser.knownAt(i), `level not swept within ${st.levelExpiryBars} H1 bars`);
    }
    if (!atr) return;
    for (const sw of swings) {
      const sign: 1 | -1 = sw.kind === 'low' ? 1 : -1;
      const eq = this.levels.find((L) => L.l.side === sw.kind && L.l.time < sw.time && this.setupOf(L).s.state === 'WATCHING_LEVEL' && Math.abs(L.l.price - sw.price) <= st.equalTolAtr * L.l.atr);
      if (eq) {
        eq.l.equals.push(sw);
        this.setupOf(eq).s.levelEquals = eq.l.equals.length;
        continue;
      }
      const c = i - st.h1SwingRight;
      const D = st.h1DominanceBars;
      if (c - D < 0) continue;
      const fp = sign * sw.price;
      let dom = 0;
      while (c - dom - 1 >= 0 && dom < 240) {
        const fb = frame(sign, ser.bars[c - dom - 1]!);
        if (!(fb.l > fp)) break;
        dom += 1;
      }
      if (dom < D) continue;
      let far = -Infinity;
      for (let k = c - D; k <= i; k++) far = Math.max(far, frame(sign, ser.bars[k]!).h);
      const prominence = far - fp;
      if (prominence / atr < st.h1MinProminenceAtr) continue;
      const side = sw.kind;
      const id = `${this.instrumentId}:HLR:LVL:${side === 'high' ? 'HIGH' : 'LOW'}:${sw.time}`;
      const level: KeyLevel = {
        id,
        side,
        direction: side === 'low' ? 'BUY' : 'SELL',
        price: sw.price,
        time: sw.time,
        confirmedAt: sw.confirmedAt,
        atr,
        prominence,
        prominenceAtr: prominence / atr,
        dominanceBars: dom,
        significance: Math.round(60 * Math.min(1, prominence / atr / 4) + 40 * Math.min(1, dom / 120)),
        equals: [],
        status: 'ACTIVE',
        testedAt: null,
        ageBars: 0,
      };
      const lvl: LevelRt = { l: level, confirmIndex: i };
      this.levels.push(lvl);
      const setup: Setup = {
        id: `${this.instrumentId}:HLR:${level.direction}:${sw.time}`,
        instrumentId: this.instrumentId,
        direction: level.direction,
        levelId: id,
        level: sw.price,
        levelTime: sw.time,
        levelConfirmedAt: sw.confirmedAt,
        levelSignificance: level.significance,
        levelEquals: 0,
        state: 'WATCHING_LEVEL',
        entryStatus: 'WAIT',
        stateHistory: [{ from: null, to: 'WATCHING_LEVEL', time: sw.confirmedAt, reason: `important H1 ${side} confirmed (prominence ${level.prominenceAtr.toFixed(2)} ATR, extreme of ${dom} bars)` }],
        liquidity: 'NONE',
        touchedAt: null,
        h4AtSweep: null,
        counterTrend: null,
        sweep: null,
        reclaim: null,
        m5: null,
        rejectedBreaks: 0,
        zone: null,
        zoneNote: null,
        risk: null,
        entry: null,
        triggeredAt: null,
        detectedAt: sw.confirmedAt,
        lastUpdate: sw.confirmedAt,
        stageBars: 0,
        stageTf: 'H1',
        distance: null,
        score: finalizeHLRScore({ htfAlignment: 0, liquiditySweep: 0, reclaim: 0, m5Structure: 0, displacement: 0, entryQuality: 0, riskReward: 0, freshness: 0 }),
      };
      const rt: SetupRt = { s: setup, sign, lvl };
      this.setups.push(rt);
      this.events.push({ time: sw.confirmedAt, setupId: setup.id, direction: setup.direction, from: null, to: 'WATCHING_LEVEL', reason: setup.stateHistory[0]!.reason });
    }
  }

  private setupOf(L: LevelRt): SetupRt {
    return this.setups.find((r) => r.lvl === L)!;
  }

  /* ---------------------------------- M15 --------------------------------- */

  private onM15(bar: Candle): void {
    const st = this.settings;
    const atr15 = this.series.M15.atr();
    if (!atr15) return;
    const known = bar.time + HLR_TF_SECONDS.M15;
    for (const rt of this.setups) {
      const s = rt.s;
      if (s.state !== 'WATCHING_LEVEL' && s.state !== 'LIQUIDITY_TAKEN') continue;
      if (bar.time < s.levelConfirmedAt) continue;
      const fb = frame(rt.sign, bar);
      const fL = rt.sign * s.level;
      const A = rt.lvl.l.atr;
      const side = rt.sign === 1 ? 'below' : 'above';
      if (s.state === 'WATCHING_LEVEL') {
        if (fb.l < fL) {
          const h4 = this.h4Context().state;
          s.h4AtSweep = h4;
          s.counterTrend = h4 === 'INSUFFICIENT_DATA' ? null : (s.direction === 'BUY' && h4 === 'BEARISH') || (s.direction === 'SELL' && h4 === 'BULLISH');
          s.sweep = { level: s.level, time: bar.time, knownAt: known, extreme: rt.sign * fb.l, extremeTime: bar.time, penetration: fL - fb.l, penetrationAtr: (fL - fb.l) / A, closedBackAt: null };
          s.liquidity = 'LIQUIDITY_TAKEN';
          rt.lvl.l.status = 'TAKEN';
          s.stageBars = 0;
          this.setState(rt, 'LIQUIDITY_TAKEN', known, `M15 traded ${side} the H1 ${rt.sign === 1 ? 'low (sell-side' : 'high (buy-side'} liquidity taken)`);
          this.evaluateTaken(rt, bar, fb, atr15, known);
        } else if (fb.l <= fL + st.touchTolAtr * A && s.liquidity === 'NONE') {
          s.liquidity = 'TOUCHED';
          s.touchedAt = known;
          rt.lvl.l.status = 'TESTED';
          rt.lvl.l.testedAt = known;
        }
      } else this.evaluateTaken(rt, bar, fb, atr15, known);
    }
  }

  private evaluateTaken(rt: SetupRt, bar: Candle, fb: FBar, atr15: number, known: number): void {
    const st = this.settings;
    const s = rt.s;
    const sw = s.sweep!;
    const fL = rt.sign * s.level;
    const A = rt.lvl.l.atr;
    s.stageBars += 1;
    if (fb.l < rt.sign * sw.extreme) {
      sw.extreme = rt.sign * fb.l;
      sw.extremeTime = bar.time;
      sw.penetration = fL - fb.l;
      sw.penetrationAtr = sw.penetration / A;
    }
    if (sw.penetrationAtr > st.maxPenetrationAtr) {
      s.liquidity = 'INVALIDATED';
      rt.lvl.l.status = 'BROKEN';
      this.setState(rt, 'INVALIDATED', known, `penetration ${sw.penetrationAtr.toFixed(2)} ATR > ${st.maxPenetrationAtr} ATR — breakout, not a sweep`);
      return;
    }
    if (fb.c <= fL - st.acceptCloseAtr * A) {
      s.liquidity = 'INVALIDATED';
      rt.lvl.l.status = 'BROKEN';
      this.setState(rt, 'INVALIDATED', known, `M15 closed ≥ ${st.acceptCloseAtr} ATR beyond the level — accepted beyond`);
      return;
    }
    if (fb.c >= fL + st.reclaimMarginAtr * atr15) {
      s.reclaim = { time: bar.time, knownAt: known, price: bar.close, bars: s.stageBars, distance: fb.c - fL };
      if (sw.closedBackAt === null) sw.closedBackAt = known;
      s.liquidity = 'RECLAIMED';
      rt.lvl.l.status = 'SWEPT';
      s.stageBars = 0;
      this.setState(rt, 'RECLAIMED', known, `M15 closed back ${rt.sign === 1 ? 'above' : 'below'} the level after ${s.reclaim.bars} bar(s)`);
      return;
    }
    if (fb.c >= fL && sw.closedBackAt === null) {
      sw.closedBackAt = known;
      s.liquidity = 'SWEPT';
    }
    if (s.stageBars >= st.reclaimWindowBars) {
      s.liquidity = 'FAILED';
      rt.lvl.l.status = 'BROKEN';
      this.setState(rt, 'FAILED_RECLAIM', known, `no reclaim close within ${st.reclaimWindowBars} M15 bars`);
    }
  }

  /* ---------------------------------- M5 ---------------------------------- */

  private onM5(bar: Candle, breaks: HLRBreak[]): void {
    const st = this.settings;
    const ser = this.series.M5;
    const atr5 = ser.atr();
    if (!atr5) return;
    const known = bar.time + HLR_TF_SECONDS.M5;
    const i = ser.length - 1;
    for (const rt of this.setups) {
      const s = rt.s;
      if (s.state !== 'RECLAIMED' && s.state !== 'M5_CONFIRMATION_PENDING') continue;
      const rc = s.reclaim!;
      if (known < rc.knownAt) continue;
      const sw = s.sweep!;
      const fb = frame(rt.sign, bar);
      const fExt = rt.sign * sw.extreme;
      if (fb.c < fExt) {
        this.setState(rt, 'INVALIDATED', known, `M5 closed beyond the sweep extreme before confirmation`);
        continue;
      }
      const brk = breaks.find((b) => b.direction === (rt.sign === 1 ? 'up' : 'down'));
      if (brk) {
        let first = i;
        while (first - 1 >= 0 && ser.bars[first - 1]!.time >= sw.time) first -= 1;
        let maxBody = 0;
        for (let k = first; k <= i; k++) maxBody = Math.max(maxBody, Math.abs(ser.bars[k]!.close - ser.bars[k]!.open));
        const legSize = rt.sign * brk.close - fExt;
        const disp = { legSize, legAtr: legSize / atr5, maxBody, maxBodyAtr: maxBody / atr5, bars: i - first + 1, atr: atr5 };
        if (disp.legAtr >= st.minDisplacementAtr && disp.maxBodyAtr >= st.minDisplacementBodyAtr) {
          s.m5 = { kind: brk.kind, brokenLevel: brk.level, swingTime: brk.swingTime, time: brk.time, knownAt: brk.knownAt, close: brk.close, displacement: disp };
          s.stageBars = 0;
          this.setState(rt, 'M5_CONFIRMED', known, `M5 ${brk.kind} close through ${brk.level} with ${disp.legAtr.toFixed(2)} ATR displacement`);
          this.defineZone(rt, known, first, i);
          if (s.zone) this.setState(rt, 'M1_PULLBACK_PENDING', known, `entry zone (${s.zone.source}) defined — waiting for an M1 pullback`);
          continue;
        }
        s.rejectedBreaks += 1;
      }
      if (known > rc.knownAt) {
        s.stageBars += 1;
        if (s.state === 'RECLAIMED') this.setState(rt, 'M5_CONFIRMATION_PENDING', known, 'waiting for an M5 CHOCH/BOS close with displacement');
        if (s.stageBars >= st.m5WindowBars) this.setState(rt, 'EXPIRED', known, `no M5 confirmation within ${st.m5WindowBars} M5 bars`);
      }
    }
  }

  /** Entry zone + risk plan, from data known at the confirmation close only. */
  private defineZone(rt: SetupRt, C: number, legFirst: number, legLast: number): void {
    const st = this.settings;
    const s = rt.s;
    const sign = rt.sign;
    const sw = s.sweep!;
    const fExt = sign * sw.extreme;
    const fBreak = sign * s.m5!.close;
    const atr5 = this.series.M5.atr()!;
    const type = sign === 1 ? 'bullish' : 'bearish';
    const toFrame = (lo: number, hi: number): [number, number] => (sign === 1 ? [lo, hi] : [-hi, -lo]);
    const eps = this.tick || 1e-9;

    type Cand = { zl: number; zh: number; ob: OrderBlock | null; tf: 'M5' | 'M1' | null; fvg: { zl: number; zh: number; time: number } | null };
    const obs: Cand[] = [];
    const unavailable: string[] = [];
    for (const [tf, eng] of [['M5', this.obM5], ['M1', this.obM1]] as const) {
      const known = this.knownBars(tf, C);
      eng.update(known, { lastBarClosed: true });
      const snap = eng.snapshot();
      if (snap.state !== 'READY') {
        unavailable.push(tf);
        continue;
      }
      for (const b of snap.blocks) {
        if (b.type !== type || !(b.state === 'FRESH' || b.state === 'ACTIVE' || b.state === 'TESTED') || b.createdAt < sw.time) continue;
        const [zl, zh] = toFrame(b.low, b.high);
        if (zl >= fExt - eps && zh <= fBreak + eps) obs.push({ zl, zh, ob: b, tf, fvg: null });
      }
    }
    const fvgs: { zl: number; zh: number; time: number }[] = [];
    const m1 = this.knownBars('M1', C);
    let start = m1.length;
    while (start - 1 >= 0 && m1[start - 1]!.time >= sw.time) start -= 1;
    for (let k = start + 1; k < m1.length - 1; k++) {
      const a = frame(sign, m1[k - 1]!);
      const c = frame(sign, m1[k + 1]!);
      if (!(c.l > a.h)) continue;
      let filled = false;
      for (let j = k + 2; j < m1.length && !filled; j++) if (frame(sign, m1[j]!).l <= a.h) filled = true;
      if (!filled && a.h >= fExt - eps && c.l <= fBreak + eps) fvgs.push({ zl: a.h, zh: c.l, time: m1[k]!.time });
    }
    const nearest = <T extends { zh: number }>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => b.zh - a.zh || (key(a) < key(b) ? -1 : 1))[0] ?? null;
    let pick: Cand | null = null;
    let source: ZoneSource | null = null;
    const paired = obs
      .map((o) => ({ ...o, fvg: nearest(fvgs.filter((g) => Math.min(o.zh, g.zh) > Math.max(o.zl, g.zl)), (g) => String(g.time)) }))
      .filter((o) => o.fvg);
    if (paired.length) {
      pick = nearest(paired, (o) => o.ob!.id);
      source = 'OB+FVG';
    } else if (obs.length) {
      pick = nearest(obs, (o) => o.ob!.id);
      source = 'OB';
    } else if (fvgs.length) {
      const g = nearest(fvgs, (x) => String(x.time))!;
      pick = { zl: g.zl, zh: g.zh, ob: null, tf: null, fvg: g };
      source = 'FVG';
    }
    if (!pick || !source) {
      s.zoneNote = `no valid Order Block or FVG inside the displacement leg${unavailable.length ? `; Order Blocks data unavailable on ${unavailable.join(' / ')} (insufficient history)` : ''}`;
      return;
    }
    const real = (zl: number, zh: number) => (sign === 1 ? { low: zl, high: zh } : { low: -zh, high: -zl });
    const zone: EntryZone = {
      source,
      ...real(pick.zl, pick.zh),
      orderBlockId: pick.ob?.id ?? null,
      orderBlockTf: pick.tf,
      fvg: pick.fvg ? { ...real(pick.fvg.zl, pick.fvg.zh), time: pick.fvg.time } : null,
      definedAt: C,
    };
    const fEntry = (pick.zl + pick.zh) / 2;
    const fStop = fExt - st.slBufferAtr * atr5;
    let fLegExt = -Infinity;
    for (let k = legFirst; k <= legLast; k++) fLegExt = Math.max(fLegExt, frame(sign, this.series.M5.bars[k]!).h);
    // TP1: nearest untaken M15 swing (opposing liquidity) beyond the leg extreme; else the leg extreme.
    let fTp1 = fLegExt;
    let tp1Source = 'displacement leg extreme (M5)';
    let m15Pick: number | null = null;
    for (const sw of this.series.M15.unbroken(sign === 1 ? 'high' : 'low')) {
      const fp = sign * sw.price;
      if (sw.confirmedAt <= C && fp > fLegExt && (m15Pick === null || fp < m15Pick)) m15Pick = fp;
    }
    if (m15Pick !== null) {
      fTp1 = m15Pick;
      tp1Source = `nearest untaken M15 swing ${sign === 1 ? 'high' : 'low'}`;
    }
    if (!(fTp1 > fEntry)) {
      s.zoneNote = 'entry zone is not below the displacement extreme';
      return;
    }
    let fTp2: number | null = null;
    let tp2Level: KeyLevel | null = null;
    for (const L of this.levels) {
      if (L.l.direction === s.direction || this.setupOf(L).s.state !== 'WATCHING_LEVEL') continue;
      const fp = sign * L.l.price;
      if (fp > fTp1 && (fTp2 === null || fp < fTp2)) {
        fTp2 = fp;
        tp2Level = L.l;
      }
    }
    const risk = fEntry - fStop;
    s.zone = zone;
    s.zoneNote = null;
    s.risk = {
      entry: sign * fEntry,
      stop: sign * fStop,
      invalidation: sw.extreme,
      tp1: sign * fTp1,
      tp1Source,
      tp2: fTp2 === null ? null : sign * fTp2,
      tp2Source: tp2Level ? `untaken important H1 ${tp2Level.side}` : `no untaken H1 ${sign === 1 ? 'high' : 'low'} beyond TP1`,
      risk,
      rr1: (fTp1 - fEntry) / risk,
      rr2: fTp2 === null ? null : (fTp2 - fEntry) / risk,
    };
  }

  private knownBars(tf: HLRTimeframe, K: number): Candle[] {
    const acc = this.accepted[tf];
    const sec = HLR_TF_SECONDS[tf];
    let lo = 0;
    let hi = acc.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (acc[m]!.time + sec <= K) lo = m + 1;
      else hi = m;
    }
    return acc.slice(0, lo);
  }

  /* ---------------------------------- M1 ---------------------------------- */

  private onM1(bar: Candle): void {
    const st = this.settings;
    const known = bar.time + HLR_TF_SECONDS.M1;
    for (const rt of this.setups) {
      const s = rt.s;
      if (s.state !== 'M5_CONFIRMED' && s.state !== 'M1_PULLBACK_PENDING' && s.state !== 'ENTRY_READY') continue;
      if (bar.time < s.m5!.knownAt) continue;
      s.stageBars += 1;
      if (s.state === 'M5_CONFIRMED') {
        if (s.stageBars >= st.m1PullbackWindowBars) this.setState(rt, 'EXPIRED', known, `no valid entry zone — expired after ${st.m1PullbackWindowBars} M1 bars`);
        continue;
      }
      const fb = frame(rt.sign, bar);
      const z = s.zone!;
      const [zl, zh] = rt.sign === 1 ? [z.low, z.high] : [-z.high, -z.low];
      if (s.state === 'M1_PULLBACK_PENDING') {
        if (fb.l <= zh) {
          if (fb.c < zl) this.setState(rt, 'INVALIDATED', known, 'M1 closed through the entry zone');
          else {
            s.entry = { time: bar.time, knownAt: known, price: bar.close };
            s.stageBars = 0;
            this.setState(rt, 'ENTRY_READY', known, `M1 pullback into the ${z.source} zone held (close inside / beyond)`);
          }
        } else if (fb.h >= rt.sign * s.risk!.tp1) this.setState(rt, 'MISSED', known, 'TP1 reached before a pullback into the zone');
        else if (s.stageBars >= st.m1PullbackWindowBars) this.setState(rt, 'EXPIRED', known, `no pullback into the zone within ${st.m1PullbackWindowBars} M1 bars`);
        continue;
      }
      if (fb.c < zl) this.setState(rt, 'INVALIDATED', known, 'M1 closed through the entry zone after ENTRY READY');
      else if (fb.c > zh) {
        s.triggeredAt = known;
        this.setState(rt, 'TRIGGERED', known, `M1 closed back ${rt.sign === 1 ? 'above' : 'below'} the zone — reaction confirmed`);
      } else if (s.stageBars >= st.m1TriggerWindowBars) this.setState(rt, 'EXPIRED', known, `no reaction out of the zone within ${st.m1TriggerWindowBars} M1 bars`);
    }
  }

  /* -------------------------------- lifecycle ------------------------------ */

  private setState(rt: SetupRt, to: SetupState, time: number, reason: string): void {
    const s = rt.s;
    if (s.state === to || TERMINAL_STATES.includes(s.state)) return;
    s.stateHistory.push({ from: s.state, to, time, reason });
    this.events.push({ time, setupId: s.id, direction: s.direction, from: s.state, to, reason });
    s.state = to;
    s.entryStatus = entryStatusOf(to);
    s.lastUpdate = time;
    s.stageTf = stageTfOf(to) ?? s.stageTf;
    if (to === 'EXPIRED' && rt.lvl.l.status !== 'SWEPT' && rt.lvl.l.status !== 'BROKEN') rt.lvl.l.status = 'EXPIRED';
  }

  /* --------------------------------- output -------------------------------- */

  /** Live internal records WITHOUT copying — read-only, for the anti-repaint audit. */
  inspect(): { knowledgeTime: number | null; setups: readonly Setup[]; levels: readonly KeyLevel[] } {
    return { knowledgeTime: this.lastKey ? this.lastKey[0] : null, setups: this.setups.map((r) => r.s), levels: this.levels.map((l) => l.l) };
  }

  snapshot(): HLRSnapshot {
    const st = this.settings;
    const timeframes = {} as Record<HLRTimeframe, HLRTfStatus>;
    for (const tf of HLR_TIMEFRAMES) {
      const ser = this.series[tf];
      const n = ser.length;
      timeframes[tf] = {
        state: n === 0 ? 'NO_DATA' : n < st.minBars[tf] ? 'INSUFFICIENT_HISTORY' : 'READY',
        bars: n,
        required: st.minBars[tf],
        lastClosedTime: n ? ser.bars[n - 1]!.time : null,
        atr: ser.atr(),
        rejected: this.rejected[tf],
      };
    }
    const states = HLR_TIMEFRAMES.map((tf) => timeframes[tf].state);
    const state = states.every((x) => x === 'READY') ? 'READY' : states.every((x) => x === 'NO_DATA') ? 'NO_DATA' : 'INSUFFICIENT_HISTORY';
    const h4 = this.h4Context();
    const h1Len = this.series.H1.length;
    const finished = this.setups.filter((r) => !OPEN.includes(r.s.state)).sort((a, b) => b.s.lastUpdate - a.s.lastUpdate || (a.s.id < b.s.id ? -1 : 1));
    const keep = new Set([...this.setups.filter((r) => OPEN.includes(r.s.state)), ...finished.slice(0, st.maxFinishedSetups)]);
    const kept = this.setups.filter((r) => keep.has(r));
    const setups = kept.map((r) => {
      const s = clone(r.s);
      s.distance = this.price === null ? null : this.price - s.level;
      const age = r.s.state === 'WATCHING_LEVEL' ? Math.max(0, h1Len - 1 - r.lvl.confirmIndex) : r.lvl.l.ageBars;
      s.score = finalizeHLRScore(hlrScoreComponents(s, h4.state, age, st));
      return s;
    });
    const levels = kept.map((r) => ({ ...clone(r.lvl.l), ageBars: Math.max(0, h1Len - 1 - r.lvl.confirmIndex) }));
    return {
      instrumentId: this.instrumentId,
      state,
      knowledgeTime: this.lastKey ? this.lastKey[0] : null,
      price: this.price,
      timeframes,
      h4,
      m5Trend: this.series.M5.trend,
      levels,
      setups,
      events: clone(this.events.slice(-200)),
      settingsKey: hlrSettingsKey(st),
    };
  }
}

export function analyzeHighLowReversal(o: HLREngineOptions & { candles: HLRInput; currentPrice?: number | null }): HLRSnapshot {
  const e = new HighLowReversalEngine(o);
  e.update(o.candles, { currentPrice: o.currentPrice });
  return e.snapshot();
}
