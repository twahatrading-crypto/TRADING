import type { InstrumentId } from '../../types/instruments';
import type { Candle } from '../../types/market';
import { DEFAULT_HLE_SETTINGS, HLE_TF_ORDER, HLE_TF_SECONDS, HLE_TIMEFRAMES, hleSettingsKey, LEVEL_BASE_STRENGTH, strengthOf, type HLESettings } from './config';
import { finalizeHLEScore, hleScoreComponents } from './score';
import { Series } from './structure';
import type {
  Bias,
  EntryZone,
  HLEBreak,
  HLEEvent,
  HLEEventType,
  HLESnapshot,
  HLESwing,
  HLETfStatus,
  HLETimeframe,
  Level,
  LevelType,
  Setup,
  SetupState,
  StructureContext,
  ZoneSource,
} from './types';
import { TERMINAL } from './types';

/* ============================================================================
 * HIGH / LOW ENGINE (separate from High / Low Reversal). Pure and deterministic.
 * CLOSED candles only, processed in close-time order (ties H4 → H1 → M15 → M5 → M1),
 * so every decision uses only what was knowable at that moment.
 *
 * BUY rules (SELL mirrors them exactly through frame negation):
 *  H4        bias from the last two confirmed H4 swing highs / lows (2 bars each side):
 *            HH+HL BULLISH · LH+LL BEARISH · otherwise NEUTRAL (Range). Context only:
 *            it never creates or blocks a setup (a setup against it is counter-trend).
 *  H1 LEVELS (all from closed H1 candles, UTC calendar):
 *            PDL  lowest low of the previous UTC day (≥ minDayBars bars), known when the day
 *                 completes (a bar closing at 00:00, or the first bar of a later day).
 *            ASIA low of [asiaStartUtc, asiaEndUtc) (≥ minAsiaBars bars), known at the window end.
 *            SWING_LOW  H1 swing (3/3) that is the lowest of ≥ swingDominanceBars prior bars with
 *                 ≥ swingProminenceAtr ATR prominence; watched ≤ swingExpiryBars.
 *            Strength (frozen): PD 70 · Asia 50 · swing 50·min(1, prominence/4 ATR) + 50·min(1,
 *            dominance/120); +15 per other active same-side level within mergeTolAtr (max +30).
 *            STRONG ≥ 70 · MEDIUM ≥ 45 · WEAK. A new level within mergeTolAtr of a watched level
 *            joins that level's setup (confluence) instead of creating a duplicate setup.
 *            A newer PDL / Asia low supersedes the older untouched one.
 *  M15       LIQUIDITY_APPROACH low within approachAtr · SWEPT low below the level (SSL taken;
 *            extreme tracked until reclaim) · RECLAIMED close ≥ level + reclaimMarginAtr × M15 ATR
 *            within reclaimWindowBars (then WAITING_M5). INVALIDATED: penetration >
 *            maxPenetrationAtr, a close ≥ acceptCloseAtr beyond (continuation), or no reclaim.
 *            A sweep NEVER confirms anything by itself.
 *  M5        (bars closing at/after the reclaim) a bullish CHOCH / BOS CLOSE through the most
 *            recent confirmed M5 swing high → M5_CONFIRMED (then WAITING_M1). Displacement is
 *            recorded and scored (not mandatory). INVALIDATED on an M5 close below the sweep
 *            extreme; EXPIRED after m5WindowBars.
 *  ZONE      at the confirmation close, inside the leg (sweep extreme … break close):
 *            M5 order block (last bearish M5 candle before the break whose low held; low → body
 *            top) and unfilled M1 fair-value gaps. OB overlapping FVG › OB › FVG › RECLAIM band
 *            [level − ½ penetration, level]; ties → nearest to price.
 *  RISK      entry = zone midpoint · stop = sweep extreme − slBufferAtr × M5 ATR · TP1 / TP2 =
 *            the two nearest opposing liquidity targets beyond the leg extreme (active H1 highs
 *            of any source and untaken M15 swing highs), none → null.
 *  M1        (bars opening at/after confirmation; M1 never sets direction) M1_PULLBACK event on
 *            the first bearish M1 close · ENTRY_READY (BUY CONFIRMED) when a bar's low enters the
 *            zone and it closes ≥ zone low · INVALIDATED on a close below the zone low ·
 *            EXPIRED if TP1 is reached first (missed) or after m1PullbackWindowBars.
 *            After ENTRY_READY: INVALIDATED on a close through the stop, EXPIRED after
 *            signalWindowBars. Every recorded value is frozen when set.
 * ========================================================================== */

export type HLEInput = Partial<Record<HLETimeframe, readonly Candle[]>>;
export interface HLEEngineOptions {
  instrumentId: InstrumentId;
  tickSize: number;
  settings?: HLESettings;
}

interface SetupRt {
  s: Setup;
  sign: 1 | -1;
}
type FBar = { o: number; h: number; l: number; c: number };

const OPEN_STATES: readonly SetupState[] = ['LEVEL_ACTIVE', 'LIQUIDITY_APPROACH', 'SWEPT', 'RECLAIMED', 'WAITING_M5', 'M5_CONFIRMED', 'WAITING_M1', 'ENTRY_READY'];
const DAY = 86400;
const same = (a: Candle | undefined, b: Candle | null) => !!a && !!b && a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
const frame = (sign: 1 | -1, c: Candle): FBar => (sign === 1 ? { o: c.open, h: c.high, l: c.low, c: c.close } : { o: -c.open, h: -c.low, l: -c.high, c: -c.close });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const TYPE_LABEL: Record<LevelType, string> = { PDH: 'Previous Day High', PDL: 'Previous Day Low', ASIA_HIGH: 'Asia High', ASIA_LOW: 'Asia Low', SWING_HIGH: 'Major Swing High', SWING_LOW: 'Major Swing Low' };
export const levelLabel = (t: LevelType) => TYPE_LABEL[t];

/** Every mandatory stage for ENTRY_READY, from the setup's own evidence. */
export function mandatoryGates(s: Setup): { level: boolean; sweep: boolean; reclaim: boolean; m5: boolean; zone: boolean; pullback: boolean } {
  return {
    level: s.levelCreatedAt > 0,
    sweep: !!s.sweep && s.sweep.time >= s.levelCreatedAt,
    reclaim: !!s.reclaim && !!s.sweep && s.reclaim.knownAt >= s.sweep.knownAt,
    m5: !!s.m5 && !!s.reclaim && s.m5.knownAt >= s.reclaim.knownAt,
    zone: !!s.zone && !!s.m5 && s.zone.definedAt === s.m5.knownAt,
    pullback: !!s.entry && !!s.m5 && s.entry.time >= s.m5.knownAt,
  };
}

export function structureContext(ser: Series, minBars: number): StructureContext {
  const highs = ser.lastSwings('high', 3);
  const lows = ser.lastSwings('low', 3);
  const at = <T>(a: T[], k: number) => a[a.length - k] ?? null;
  const base = { lastSwingHigh: at(highs, 1), prevSwingHigh: at(highs, 2), lastSwingLow: at(lows, 1), prevSwingLow: at(lows, 2), bars: ser.length };
  if (ser.length < minBars || highs.length < 2 || lows.length < 2) return { ...base, bias: 'INSUFFICIENT_DATA', structure: 'Not enough confirmed swings', short: '—', strength: 0 };
  const h = highs[highs.length - 1]!.price > highs[highs.length - 2]!.price ? 'HH' : 'LH';
  const l = lows[lows.length - 1]!.price > lows[lows.length - 2]!.price ? 'HL' : 'LL';
  const bias: Bias = h === 'HH' && l === 'HL' ? 'BULLISH' : h === 'LH' && l === 'LL' ? 'BEARISH' : 'NEUTRAL';
  let agree = 0;
  let total = 0;
  for (const arr of [highs, lows])
    for (let k = 1; k < arr.length; k++) {
      total += 1;
      const up = arr[k]!.price > arr[k - 1]!.price;
      if ((bias === 'BULLISH' && up) || (bias === 'BEARISH' && !up)) agree += 1;
    }
  const structure = bias === 'BULLISH' ? 'Higher Highs + Higher Lows' : bias === 'BEARISH' ? 'Lower Highs + Lower Lows' : `Range / Neutral (${h} + ${l})`;
  return { ...base, bias, structure, short: `${h} + ${l}`, strength: bias === 'NEUTRAL' ? 0 : Math.round((100 * agree) / total) };
}

export class HighLowEngine {
  readonly instrumentId: InstrumentId;
  readonly settings: HLESettings;
  private readonly tick: number;
  private series!: Record<HLETimeframe, Series>;
  private accepted!: Record<HLETimeframe, Candle[]>;
  private processed!: Record<HLETimeframe, number>;
  private consumed!: Record<HLETimeframe, number>;
  private firstInput!: Record<HLETimeframe, Candle | null>;
  private lastInput!: Record<HLETimeframe, Candle | null>;
  private rejected!: Record<HLETimeframe, number>;
  private lastKey: [number, number] | null = null;
  private levels: Level[] = [];
  private levelIndex = new Map<string, number>();
  private setups: SetupRt[] = [];
  private events: HLEEvent[] = [];
  private finalizedDays = new Set<number>();
  private finalizedAsia = new Set<number>();
  private h4Bias: Bias | null = null;
  private h1Bias: Bias | null = null;
  private price: number | null = null;

  constructor(o: HLEEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.settings = o.settings ?? { ...DEFAULT_HLE_SETTINGS };
    this.tick = o.tickSize > 0 ? o.tickSize : 0;
    this.reset();
  }

  private reset(): void {
    const st = this.settings;
    const mk = <T>(f: () => T) => Object.fromEntries(HLE_TIMEFRAMES.map((tf) => [tf, f()])) as Record<HLETimeframe, T>;
    this.series = {
      H4: new Series(HLE_TF_SECONDS.H4, st.h4Swing, st.h4Swing, st.atrPeriod),
      H1: new Series(HLE_TF_SECONDS.H1, st.h1Swing, st.h1Swing, st.atrPeriod),
      M15: new Series(HLE_TF_SECONDS.M15, st.m15Swing, st.m15Swing, st.atrPeriod),
      M5: new Series(HLE_TF_SECONDS.M5, st.m5Swing, st.m5Swing, st.atrPeriod),
      M1: new Series(HLE_TF_SECONDS.M1, 3, 3, st.atrPeriod),
    };
    this.accepted = mk(() => []);
    this.processed = mk(() => 0);
    this.consumed = mk(() => 0);
    this.firstInput = mk(() => null);
    this.lastInput = mk(() => null);
    this.rejected = mk(() => 0);
    this.lastKey = null;
    this.levels = [];
    this.levelIndex = new Map();
    this.setups = [];
    this.events = [];
    this.finalizedDays = new Set();
    this.finalizedAsia = new Set();
    this.h4Bias = null;
    this.h1Bias = null;
  }

  /** Feed CLOSED candles per timeframe (ascending). Incremental; rebuilds deterministically when needed. */
  update(input: HLEInput, o: { currentPrice?: number | null } = {}): void {
    if (!this.ingest(input)) {
      this.reset();
      this.ingest(input);
    }
    this.run();
    const m1 = this.accepted.M1;
    this.price = o.currentPrice !== undefined ? o.currentPrice : m1.length ? m1[m1.length - 1]!.close : null;
  }

  private ingest(input: HLEInput): boolean {
    for (const tf of HLE_TIMEFRAMES) {
      const arr = input[tf] ?? [];
      const n = this.consumed[tf];
      if (n > arr.length || (n > 0 && (!same(arr[0], this.firstInput[tf]) || !same(arr[n - 1], this.lastInput[tf])))) return false;
    }
    for (const tf of HLE_TIMEFRAMES) {
      const arr = input[tf] ?? [];
      const acc = this.accepted[tf];
      for (let j = this.consumed[tf]; j < arr.length; j++) {
        const c = arr[j]!;
        const prev = acc[acc.length - 1];
        // Duplicate / out-of-order timestamps are rejected (counted), never processed.
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
        const k0 = next.time + HLE_TF_SECONDS[tf];
        if (k0 < this.lastKey[0] || (k0 === this.lastKey[0] && HLE_TF_ORDER[tf] < this.lastKey[1])) return false;
      }
    }
    return true;
  }

  private run(): void {
    for (;;) {
      let best: HLETimeframe | null = null;
      let bk = Infinity;
      for (const tf of HLE_TIMEFRAMES) {
        const b = this.accepted[tf][this.processed[tf]];
        if (b && b.time + HLE_TF_SECONDS[tf] < bk) {
          bk = b.time + HLE_TF_SECONDS[tf];
          best = tf;
        }
      }
      if (!best) return;
      const bar = this.accepted[best][this.processed[best]]!;
      this.processed[best] += 1;
      this.lastKey = [bk, HLE_TF_ORDER[best]];
      const r = this.series[best].push(bar);
      if (best === 'H4') this.onH4(bar);
      else if (best === 'H1') this.onH1(bar, r.swings);
      else if (best === 'M15') this.onM15(bar);
      else if (best === 'M5') this.onM5(bar, r.breaks);
      else this.onM1(bar);
    }
  }

  /* -------------------------------- events -------------------------------- */

  /** Event ids are deterministic (instrument:type:subject:time), so a re-run or a refresh yields the same log. */
  private emit(type: HLEEventType, time: number, tf: HLETimeframe, price: number | null, setupId: string | null, message: string, subject?: string): void {
    this.events.push({ id: `${this.instrumentId}:${type}:${subject ?? setupId ?? tf}:${time}`, time, instrumentId: this.instrumentId, timeframe: tf, type, price, setupId, message });
  }

  private setState(rt: SetupRt, to: SetupState, time: number, reason: string, tf: HLETimeframe, price: number | null): void {
    const s = rt.s;
    if (s.state === to || TERMINAL.includes(s.state)) return;
    s.history.push({ from: s.state, to, time, reason });
    s.state = to;
    s.lastUpdate = time;
    if (to === 'INVALIDATED' || to === 'EXPIRED') {
      this.emit(to === 'INVALIDATED' ? 'SETUP_INVALIDATED' : 'SETUP_EXPIRED', time, tf, price, s.id, reason);
      for (const id of s.levelIds) {
        const l = this.levels[this.levelIndex.get(id)!]!;
        if (l.status === 'ACTIVE') {
          l.status = s.sweep ? 'BROKEN' : 'EXPIRED';
          l.statusAt = time;
        }
      }
    }
  }

  /* ---------------------------------- H4 ---------------------------------- */

  private onH4(bar: Candle): void {
    const ctx = structureContext(this.series.H4, this.settings.minBars.H4);
    if (ctx.bias !== this.h4Bias) {
      if (this.h4Bias !== null || ctx.bias !== 'INSUFFICIENT_DATA') this.emit('H4_BIAS_CHANGED', bar.time + HLE_TF_SECONDS.H4, 'H4', bar.close, null, `H4 bias ${this.h4Bias ?? '—'} → ${ctx.bias} (${ctx.structure})`);
      this.h4Bias = ctx.bias;
    }
  }

  /* ---------------------------------- H1 ---------------------------------- */

  private onH1(bar: Candle, swings: HLESwing[]): void {
    const st = this.settings;
    const ser = this.series.H1;
    const i = ser.length - 1;
    const known = bar.time + HLE_TF_SECONDS.H1;
    const atr = ser.atr();

    // Watched levels: traded through with no M15 history covering this hour → unverifiable; swing expiry.
    const m15 = this.series.M15;
    const covered = m15.length > 0 && m15.bars[m15.length - 1]!.time >= bar.time;
    for (const rt of this.setups) {
      if (rt.s.state !== 'LEVEL_ACTIVE' && rt.s.state !== 'LIQUIDITY_APPROACH') continue;
      if (!covered && known > rt.s.levelCreatedAt && frame(rt.sign, bar).l < rt.sign * rt.s.level)
        this.setState(rt, 'INVALIDATED', known, 'H1 traded through the level before M15 history was available — sweep not verifiable', 'H1', bar.close);
    }
    for (const l of this.levels) {
      if (l.status !== 'ACTIVE' || (l.type !== 'SWING_HIGH' && l.type !== 'SWING_LOW')) continue;
      if (known - l.createdAt >= st.swingExpiryBars * 3600) this.retire(l, 'EXPIRED', known, `major swing not swept within ${st.swingExpiryBars} H1 bars`);
    }

    // Previous UTC day / Asia session complete?
    const prev = ser.bars[i - 1];
    const dayOf = (t: number) => Math.floor(t / DAY) * DAY;
    if (prev && dayOf(bar.time) > dayOf(prev.time)) this.finalizeDay(dayOf(prev.time), known);
    if (known % DAY === 0) this.finalizeDay(dayOf(bar.time), known);
    const aEnd = (d: number) => d + st.asiaEndUtc * 3600;
    if (known === aEnd(dayOf(bar.time))) this.finalizeAsia(dayOf(bar.time), known);
    if (prev && bar.time >= aEnd(dayOf(prev.time)) && prev.time < aEnd(dayOf(prev.time))) this.finalizeAsia(dayOf(prev.time), known);
    if (prev && dayOf(bar.time) > dayOf(prev.time) && prev.time < aEnd(dayOf(prev.time))) this.finalizeAsia(dayOf(prev.time), known);

    if (atr) {
      for (const sw of swings) {
        const sign: 1 | -1 = sw.kind === 'low' ? 1 : -1;
        const c = i - st.h1Swing;
        const D = st.swingDominanceBars;
        if (c - D < 0) continue;
        const fp = sign * sw.price;
        let dom = 0;
        while (c - dom - 1 >= 0 && dom < 240 && frame(sign, ser.bars[c - dom - 1]!).l > fp) dom += 1;
        if (dom < D) continue;
        let far = -Infinity;
        for (let k = c - D; k <= i; k++) far = Math.max(far, frame(sign, ser.bars[k]!).h);
        const prom = (far - fp) / atr;
        if (prom < st.swingProminenceAtr) continue;
        const base = Math.round(50 * Math.min(1, prom / 4) + 50 * Math.min(1, dom / 120));
        this.addLevel(sw.kind === 'low' ? 'SWING_LOW' : 'SWING_HIGH', sw.price, sw.time, sw.time, sw.time + 3600, known, atr, base);
      }
    }

    const ctx = structureContext(ser, 1);
    if (ctx.bias !== this.h1Bias) {
      if (this.h1Bias !== null || ctx.bias !== 'INSUFFICIENT_DATA') this.emit('H1_BIAS_CHANGED', known, 'H1', bar.close, null, `H1 bias ${this.h1Bias ?? '—'} → ${ctx.bias} (${ctx.short})`);
      this.h1Bias = ctx.bias;
    }
  }

  private barsIn(from: number, to: number): Candle[] {
    const out: Candle[] = [];
    const b = this.series.H1.bars;
    for (let k = b.length - 1; k >= 0 && b[k]!.time >= from; k--) if (b[k]!.time < to) out.unshift(b[k]!);
    return out;
  }

  private finalizeDay(day: number, known: number): void {
    if (this.finalizedDays.has(day)) return;
    this.finalizedDays.add(day);
    const bars = this.barsIn(day, day + DAY);
    const atr = this.series.H1.atr();
    if (bars.length < this.settings.minDayBars || !atr) return;
    const hi = bars.reduce((a, c) => (c.high > a.high ? c : a));
    const lo = bars.reduce((a, c) => (c.low < a.low ? c : a));
    this.addLevel('PDH', hi.high, hi.time, day, day + DAY, known, atr, LEVEL_BASE_STRENGTH.PD);
    this.addLevel('PDL', lo.low, lo.time, day, day + DAY, known, atr, LEVEL_BASE_STRENGTH.PD);
  }

  private finalizeAsia(day: number, known: number): void {
    if (this.finalizedAsia.has(day)) return;
    this.finalizedAsia.add(day);
    const st = this.settings;
    const bars = this.barsIn(day + st.asiaStartUtc * 3600, day + st.asiaEndUtc * 3600);
    const atr = this.series.H1.atr();
    if (bars.length < st.minAsiaBars || !atr) return;
    const hi = bars.reduce((a, c) => (c.high > a.high ? c : a));
    const lo = bars.reduce((a, c) => (c.low < a.low ? c : a));
    this.addLevel('ASIA_HIGH', hi.high, hi.time, day + st.asiaStartUtc * 3600, day + st.asiaEndUtc * 3600, known, atr, LEVEL_BASE_STRENGTH.ASIA);
    this.addLevel('ASIA_LOW', lo.low, lo.time, day + st.asiaStartUtc * 3600, day + st.asiaEndUtc * 3600, known, atr, LEVEL_BASE_STRENGTH.ASIA);
  }

  private retire(l: Level, status: 'EXPIRED' | 'SUPERSEDED', time: number, reason: string): void {
    l.status = status;
    l.statusAt = time;
    const rt = this.setups.find((r) => r.s.id === l.setupId)!;
    if ((rt.s.state === 'LEVEL_ACTIVE' || rt.s.state === 'LIQUIDITY_APPROACH') && rt.s.levelIds.every((id) => this.levels[this.levelIndex.get(id)!]!.status !== 'ACTIVE'))
      this.setState(rt, 'EXPIRED', time, reason, 'H1', null);
  }

  private addLevel(type: LevelType, price: number, sourceTime: number, periodStart: number, periodEnd: number, known: number, atr: number, base: number): void {
    const st = this.settings;
    const kind: 'high' | 'low' = type === 'PDH' || type === 'ASIA_HIGH' || type === 'SWING_HIGH' ? 'high' : 'low';
    const side = kind === 'low' ? 'BUY' : 'SELL';
    const id = `${this.instrumentId}:HLE:LVL:${type}:${sourceTime}`;
    if (this.levelIndex.has(id)) return;
    // A newer calendar level supersedes the older untouched one of the same type.
    if (type !== 'SWING_HIGH' && type !== 'SWING_LOW')
      for (const l of this.levels) if (l.type === type && l.status === 'ACTIVE') this.retire(l, 'SUPERSEDED', known, `superseded by the newer ${TYPE_LABEL[type]}`);
    const near = this.levels.filter((l) => l.status === 'ACTIVE' && l.kind === kind && Math.abs(l.price - price) <= st.mergeTolAtr * atr);
    const score = Math.min(100, base + 15 * Math.min(2, near.length));
    const owner = near.map((l) => this.setups.find((r) => r.s.id === l.setupId)!).find((r) => r.s.state === 'LEVEL_ACTIVE' || r.s.state === 'LIQUIDITY_APPROACH') ?? null;
    const setupId = owner ? owner.s.id : `${this.instrumentId}:HLE:${side}:${type}:${sourceTime}`;
    const level: Level = {
      id,
      type,
      kind,
      side,
      price,
      sourceTime,
      periodStart,
      periodEnd,
      createdAt: known,
      atr,
      strengthScore: score,
      strength: strengthOf(score),
      confluence: near.map((l) => l.id),
      setupId,
      status: 'ACTIVE',
      statusAt: null,
      distance: null,
    };
    this.levelIndex.set(id, this.levels.length);
    this.levels.push(level);
    this.emit('LEVEL_DETECTED', known, 'H1', price, setupId, `${TYPE_LABEL[type]} ${level.strength}${owner ? ' (confluence with a watched level)' : ''}`, id);
    if (owner) {
      owner.s.levelIds.push(id);
      return;
    }
    const s: Setup = {
      id: setupId,
      instrumentId: this.instrumentId,
      side,
      levelId: id,
      levelType: type,
      level: price,
      levelCreatedAt: known,
      levelIds: [id],
      state: 'LEVEL_ACTIVE',
      history: [{ from: null, to: 'LEVEL_ACTIVE', time: known, reason: `${TYPE_LABEL[type]} detected (${level.strength})` }],
      approachAt: null,
      h4AtSweep: null,
      counterTrend: null,
      sweep: null,
      reclaim: null,
      m5: null,
      zone: null,
      risk: null,
      pullback: null,
      entry: null,
      stageBars: 0,
      lastUpdate: known,
      distance: null,
      score: finalizeHLEScore({ htfAlignment: 0, levelImportance: 0, sweepQuality: 0, rejectionDisplacement: 0, m5Structure: 0, m1EntryQuality: 0, fvgObConfluence: 0 }),
    };
    this.setups.push({ s, sign: side === 'BUY' ? 1 : -1 });
  }

  private levelScore(s: Setup): number {
    return Math.min(100, Math.max(...s.levelIds.map((id) => this.levels[this.levelIndex.get(id)!]!.strengthScore)) + 10 * Math.min(2, s.levelIds.length - 1));
  }

  /* ---------------------------------- M15 --------------------------------- */

  private onM15(bar: Candle): void {
    const st = this.settings;
    const atr15 = this.series.M15.atr();
    if (!atr15) return;
    const known = bar.time + HLE_TF_SECONDS.M15;
    for (const rt of this.setups) {
      const s = rt.s;
      if (s.state !== 'LEVEL_ACTIVE' && s.state !== 'LIQUIDITY_APPROACH' && s.state !== 'SWEPT') continue;
      if (bar.time < s.levelCreatedAt) continue;
      const lvl = this.levels[this.levelIndex.get(s.levelId)!]!;
      const A = lvl.atr;
      const fb = frame(rt.sign, bar);
      const fL = rt.sign * s.level;
      const buy = rt.sign === 1;
      if (s.state !== 'SWEPT') {
        if (fb.l < fL) {
          const range = fb.h - fb.l;
          const h4 = structureContext(this.series.H4, st.minBars.H4).bias;
          s.h4AtSweep = h4;
          s.counterTrend = h4 === 'INSUFFICIENT_DATA' || h4 === 'NEUTRAL' ? false : (buy && h4 === 'BEARISH') || (!buy && h4 === 'BULLISH');
          s.sweep = {
            time: bar.time,
            knownAt: known,
            extreme: rt.sign * fb.l,
            extremeTime: bar.time,
            penetration: fL - fb.l,
            penetrationAtr: (fL - fb.l) / A,
            rejection: range > 0 ? (Math.min(fb.o, fb.c) - fb.l) / range : 0,
            importanceAtSweep: this.levelScore(s),
          };
          s.stageBars = 0;
          this.emit(buy ? 'SSL_TAKEN' : 'BSL_TAKEN', known, 'M15', rt.sign * fb.l, s.id, `${buy ? 'Sell' : 'Buy'}-side liquidity taken at ${TYPE_LABEL[s.levelType]}`);
          this.setState(rt, 'SWEPT', known, `M15 traded ${buy ? 'below' : 'above'} the level`, 'M15', bar.close);
        } else if (s.state === 'LEVEL_ACTIVE' && fb.l <= fL + st.approachAtr * A) {
          s.approachAt = known;
          this.emit('LEVEL_APPROACH', known, 'M15', s.level, s.id, `Price approaching ${TYPE_LABEL[s.levelType]}`);
          this.setState(rt, 'LIQUIDITY_APPROACH', known, `M15 within ${st.approachAtr} ATR of the level`, 'M15', bar.close);
          continue;
        } else continue;
      }
      // SWEPT: extreme / invalidation / reclaim (the sweep bar itself included).
      const sw = s.sweep!;
      s.stageBars += 1;
      if (fb.l < rt.sign * sw.extreme) {
        sw.extreme = rt.sign * fb.l;
        sw.extremeTime = bar.time;
        sw.penetration = fL - fb.l;
        sw.penetrationAtr = sw.penetration / A;
      }
      if (sw.penetrationAtr > st.maxPenetrationAtr) {
        this.setState(rt, 'INVALIDATED', known, `penetration ${sw.penetrationAtr.toFixed(2)} ATR > ${st.maxPenetrationAtr} — continuation, not a sweep`, 'M15', bar.close);
        continue;
      }
      if (fb.c <= fL - st.acceptCloseAtr * A) {
        this.setState(rt, 'INVALIDATED', known, `M15 closed ≥ ${st.acceptCloseAtr} ATR beyond the level — continuation`, 'M15', bar.close);
        continue;
      }
      if (fb.c >= fL + st.reclaimMarginAtr * atr15) {
        s.reclaim = { time: bar.time, knownAt: known, price: bar.close, bars: s.stageBars };
        s.stageBars = 0;
        for (const id of s.levelIds) {
          const l = this.levels[this.levelIndex.get(id)!]!;
          if (l.status === 'ACTIVE') {
            l.status = 'SWEPT';
            l.statusAt = known;
          }
        }
        this.emit('LEVEL_RECLAIMED', known, 'M15', bar.close, s.id, `Level reclaimed after ${s.reclaim.bars} M15 bar(s)`);
        this.setState(rt, 'RECLAIMED', known, `M15 closed back ${buy ? 'above' : 'below'} the level`, 'M15', bar.close);
        this.setState(rt, 'WAITING_M5', known, `waiting for an M5 ${buy ? 'bullish' : 'bearish'} CHOCH / BOS close`, 'M15', bar.close);
        continue;
      }
      if (s.stageBars >= st.reclaimWindowBars) this.setState(rt, 'INVALIDATED', known, `wick through without a reclaim close within ${st.reclaimWindowBars} M15 bars`, 'M15', bar.close);
    }
  }

  /* ---------------------------------- M5 ---------------------------------- */

  private onM5(bar: Candle, breaks: HLEBreak[]): void {
    const st = this.settings;
    const ser = this.series.M5;
    const atr5 = ser.atr();
    if (!atr5) return;
    const known = bar.time + HLE_TF_SECONDS.M5;
    const i = ser.length - 1;
    for (const rt of this.setups) {
      const s = rt.s;
      if (s.state !== 'WAITING_M5') continue;
      if (known < s.reclaim!.knownAt) continue;
      const sw = s.sweep!;
      const fExt = rt.sign * sw.extreme;
      const fb = frame(rt.sign, bar);
      if (fb.c < fExt) {
        this.setState(rt, 'INVALIDATED', known, 'M5 closed beyond the sweep extreme before confirmation', 'M5', bar.close);
        continue;
      }
      const brk = breaks.find((b) => b.direction === (rt.sign === 1 ? 'up' : 'down'));
      if (brk) {
        let first = i;
        while (first - 1 >= 0 && ser.bars[first - 1]!.time >= sw.time) first -= 1;
        let maxBody = 0;
        for (let k = first; k <= i; k++) maxBody = Math.max(maxBody, Math.abs(ser.bars[k]!.close - ser.bars[k]!.open));
        const legAtr = (rt.sign * brk.close - fExt) / atr5;
        const d = { legAtr, maxBodyAtr: maxBody / atr5, breakBodyAtr: Math.abs(bar.close - bar.open) / atr5, bars: i - first + 1, atr: atr5, strong: legAtr >= st.displacementLegAtr && maxBody / atr5 >= st.displacementBodyAtr };
        s.m5 = { kind: brk.kind, brokenLevel: brk.level, swingTime: brk.swingTime, time: brk.time, knownAt: brk.knownAt, close: brk.close, displacement: d };
        s.stageBars = 0;
        this.emit(brk.kind === 'CHOCH' ? 'M5_CHOCH' : 'M5_BOS', known, 'M5', brk.close, s.id, `M5 ${rt.sign === 1 ? 'bullish' : 'bearish'} ${brk.kind} close through ${brk.level}`);
        this.setState(rt, 'M5_CONFIRMED', known, `M5 ${brk.kind} close (displacement ${d.strong ? 'strong' : 'weak'} ${legAtr.toFixed(2)} ATR)`, 'M5', brk.close);
        this.defineZone(rt, known, first, i);
        this.setState(rt, 'WAITING_M1', known, `entry zone (${s.zone!.source}) defined — waiting for an M1 pullback`, 'M5', brk.close);
        continue;
      }
      if (known > s.reclaim!.knownAt) {
        s.stageBars += 1;
        if (s.stageBars >= st.m5WindowBars) this.setState(rt, 'EXPIRED', known, `no M5 CHOCH / BOS within ${st.m5WindowBars} M5 bars`, 'M5', bar.close);
      }
    }
  }

  private knownBars(tf: HLETimeframe, K: number): Candle[] {
    const acc = this.accepted[tf];
    const sec = HLE_TF_SECONDS[tf];
    let lo = 0;
    let hi = acc.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (acc[m]!.time + sec <= K) lo = m + 1;
      else hi = m;
    }
    return acc.slice(0, lo);
  }

  /** Entry zone + risk plan from data known at the confirmation close only (frozen). */
  private defineZone(rt: SetupRt, C: number, legFirst: number, legLast: number): void {
    const st = this.settings;
    const s = rt.s;
    const sign = rt.sign;
    const sw = s.sweep!;
    const fExt = sign * sw.extreme;
    const fBreak = sign * s.m5!.close;
    const m5 = this.series.M5.bars;
    const atr5 = this.series.M5.atr()!;
    const eps = this.tick || 1e-9;
    const real = (zl: number, zh: number) => (sign === 1 ? { low: zl, high: zh } : { low: -zh, high: -zl });

    // M5 order block: last opposite (bearish for BUY) candle before the break whose extreme held.
    let ob: { zl: number; zh: number; time: number } | null = null;
    for (let k = legLast - 1; k >= Math.max(0, legLast - st.obLookback); k--) {
      const f = frame(sign, m5[k]!);
      if (!(f.c < f.o) || m5[k]!.time < sw.time) continue;
      let holds = true;
      for (let j = k + 1; j <= legLast && holds; j++) if (frame(sign, m5[j]!).l < f.l) holds = false;
      if (holds) {
        if (f.l >= fExt - eps && f.o <= fBreak + eps && f.o - f.l > eps) ob = { zl: f.l, zh: f.o, time: m5[k]!.time };
        break;
      }
    }
    // M1 fair-value gaps inside the leg, unfilled at C.
    const m1 = this.knownBars('M1', C);
    let start = m1.length;
    while (start - 1 >= 0 && m1[start - 1]!.time >= sw.time) start -= 1;
    const fvgs: { zl: number; zh: number; time: number }[] = [];
    for (let k = start + 1; k < m1.length - 1; k++) {
      const a = frame(sign, m1[k - 1]!);
      const c = frame(sign, m1[k + 1]!);
      if (!(c.l > a.h)) continue;
      let filled = false;
      for (let j = k + 2; j < m1.length && !filled; j++) if (frame(sign, m1[j]!).l <= a.h) filled = true;
      if (!filled && a.h >= fExt - eps && c.l <= fBreak + eps) fvgs.push({ zl: a.h, zh: c.l, time: m1[k]!.time });
    }
    const nearest = (xs: { zl: number; zh: number; time: number }[]) => [...xs].sort((x, y) => y.zh - x.zh || x.time - y.time)[0] ?? null;
    let zl: number;
    let zh: number;
    let source: ZoneSource;
    let fvg: { zl: number; zh: number; time: number } | null = null;
    const overlapping = ob ? fvgs.filter((g) => Math.min(ob!.zh, g.zh) > Math.max(ob!.zl, g.zl)) : [];
    if (ob && overlapping.length) {
      [zl, zh, source, fvg] = [ob.zl, ob.zh, 'OB+FVG', nearest(overlapping)];
    } else if (ob) {
      [zl, zh, source] = [ob.zl, ob.zh, 'OB'];
    } else if (fvgs.length) {
      fvg = nearest(fvgs);
      [zl, zh, source] = [fvg!.zl, fvg!.zh, 'FVG'];
    } else {
      const fL = sign * s.level;
      [zl, zh, source] = [fL - sw.penetration / 2, fL, 'RECLAIM'];
    }
    const zone: EntryZone = {
      source,
      ...real(zl, zh),
      ob: ob ? { ...real(ob.zl, ob.zh), time: ob.time } : null,
      fvg: fvg ? { ...real(fvg.zl, fvg.zh), time: fvg.time } : null,
      definedAt: C,
    };
    // Targets: opposing liquidity beyond the leg extreme (active H1 levels of any source + untaken M15 swings).
    let fLegExt = -Infinity;
    for (let k = legFirst; k <= legLast; k++) fLegExt = Math.max(fLegExt, frame(sign, m5[k]!).h);
    const cands: { fp: number; src: string }[] = [];
    for (const l of this.levels) if (l.status === 'ACTIVE' && l.side !== s.side && sign * l.price > fLegExt) cands.push({ fp: sign * l.price, src: TYPE_LABEL[l.type] });
    for (const x of this.series.M15.unbroken(sign === 1 ? 'high' : 'low')) if (x.confirmedAt <= C && sign * x.price > fLegExt) cands.push({ fp: sign * x.price, src: `M15 swing ${sign === 1 ? 'high' : 'low'}` });
    cands.sort((a, b) => a.fp - b.fp || (a.src < b.src ? -1 : 1));
    const tol = this.levels[this.levelIndex.get(s.levelId)!]!.atr * 0.1;
    const picked: { fp: number; src: string }[] = [];
    for (const c of cands) if (!picked.length || c.fp - picked[picked.length - 1]!.fp > tol) picked.push(c);
    const fEntry = (zl + zh) / 2;
    const fStop = fExt - st.slBufferAtr * atr5;
    const risk = fEntry - fStop;
    const t1 = picked[0] ?? null;
    const t2 = picked[1] ?? null;
    s.zone = zone;
    s.risk = {
      entry: sign * fEntry,
      stop: sign * fStop,
      tp1: t1 ? sign * t1.fp : null,
      tp1Source: t1 ? t1.src : 'no opposing liquidity beyond the leg',
      tp2: t2 ? sign * t2.fp : null,
      tp2Source: t2 ? t2.src : 'no second opposing target',
      risk,
      rr1: t1 && risk > 0 ? (t1.fp - fEntry) / risk : null,
      rr2: t2 && risk > 0 ? (t2.fp - fEntry) / risk : null,
    };
  }

  /* ---------------------------------- M1 ---------------------------------- */

  private onM1(bar: Candle): void {
    const st = this.settings;
    const known = bar.time + HLE_TF_SECONDS.M1;
    for (const rt of this.setups) {
      const s = rt.s;
      if (s.state !== 'WAITING_M1' && s.state !== 'ENTRY_READY') continue;
      if (bar.time < s.m5!.knownAt) continue;
      s.stageBars += 1;
      const fb = frame(rt.sign, bar);
      const z = s.zone!;
      const [zl, zh] = rt.sign === 1 ? [z.low, z.high] : [-z.high, -z.low];
      if (s.state === 'ENTRY_READY') {
        if (fb.c < rt.sign * s.risk!.stop) this.setState(rt, 'INVALIDATED', known, 'M1 closed through the stop after the signal', 'M1', bar.close);
        else if (s.stageBars >= st.signalWindowBars) this.setState(rt, 'EXPIRED', known, `signal window of ${st.signalWindowBars} M1 bars elapsed`, 'M1', bar.close);
        continue;
      }
      if (!s.pullback && fb.c < fb.o) {
        s.pullback = { time: bar.time, knownAt: known, price: bar.close };
        this.emit('M1_PULLBACK', known, 'M1', bar.close, s.id, 'M1 pullback started after M5 confirmation');
      }
      if (fb.l <= zh) {
        if (fb.c < zl) {
          this.setState(rt, 'INVALIDATED', known, 'M1 closed through the entry zone', 'M1', bar.close);
          continue;
        }
        if (!s.pullback) {
          s.pullback = { time: bar.time, knownAt: known, price: bar.close };
          this.emit('M1_PULLBACK', known, 'M1', bar.close, s.id, 'M1 pullback into the zone');
        }
        s.entry = { time: bar.time, knownAt: known, price: bar.close };
        s.stageBars = 0;
        this.emit('ENTRY_READY', known, 'M1', bar.close, s.id, `${s.side} CONFIRMED — entry ${s.risk!.entry.toFixed(5).replace(/0+$/, '')}, SL ${s.risk!.stop.toFixed(5).replace(/0+$/, '')}${s.risk!.tp1 !== null ? `, TP1 ${s.risk!.tp1.toFixed(5).replace(/0+$/, '')}` : ''}`);
        this.setState(rt, 'ENTRY_READY', known, `M1 pullback into the ${z.source} zone held — every mandatory stage complete`, 'M1', bar.close);
      } else if (s.risk!.tp1 !== null && fb.h >= rt.sign * s.risk!.tp1) this.setState(rt, 'EXPIRED', known, 'TP1 reached before a pullback into the zone (missed)', 'M1', bar.close);
      else if (s.stageBars >= st.m1PullbackWindowBars) this.setState(rt, 'EXPIRED', known, `no pullback into the zone within ${st.m1PullbackWindowBars} M1 bars`, 'M1', bar.close);
    }
  }

  /* --------------------------------- output -------------------------------- */

  /** Live internal records WITHOUT copying — read-only, for the anti-repaint audit. */
  inspect(): { knowledgeTime: number | null; setups: readonly Setup[]; levels: readonly Level[]; events: readonly HLEEvent[] } {
    return { knowledgeTime: this.lastKey ? this.lastKey[0] : null, setups: this.setups.map((r) => r.s), levels: this.levels, events: this.events };
  }

  snapshot(): HLESnapshot {
    const st = this.settings;
    const timeframes = {} as Record<HLETimeframe, HLETfStatus>;
    for (const tf of HLE_TIMEFRAMES) {
      const ser = this.series[tf];
      const n = ser.length;
      timeframes[tf] = { state: n === 0 ? 'NO_DATA' : n < st.minBars[tf] ? 'INSUFFICIENT_HISTORY' : 'READY', bars: n, required: st.minBars[tf], lastClosedTime: n ? ser.bars[n - 1]!.time : null, atr: ser.atr(), rejected: this.rejected[tf] };
    }
    const states = HLE_TIMEFRAMES.map((tf) => timeframes[tf].state);
    const h4 = structureContext(this.series.H4, st.minBars.H4);
    const h1 = structureContext(this.series.H1, 1);
    const finished = this.setups.filter((r) => !OPEN_STATES.includes(r.s.state)).sort((a, b) => b.s.lastUpdate - a.s.lastUpdate || (a.s.id < b.s.id ? -1 : 1));
    const keep = new Set([...this.setups.filter((r) => OPEN_STATES.includes(r.s.state)), ...finished.slice(0, st.maxFinishedSetups)]);
    const setups = this.setups
      .filter((r) => keep.has(r))
      .map((r) => {
        const s = clone(r.s);
        s.distance = this.price === null ? null : this.price - s.level;
        s.score = finalizeHLEScore(hleScoreComponents(s, this.levelScore(r.s), h4.bias));
        return s;
      });
    const kept = new Set(setups.map((s) => s.id));
    const levels = this.levels.filter((l) => l.status === 'ACTIVE' || kept.has(l.setupId)).map((l) => ({ ...clone(l), distance: this.price === null ? null : l.price - this.price }));
    const live = setups.filter((s) => s.state === 'ENTRY_READY').sort((a, b) => b.entry!.knownAt - a.entry!.knownAt)[0] ?? null;
    return {
      instrumentId: this.instrumentId,
      state: states.every((x) => x === 'READY') ? 'READY' : states.every((x) => x === 'NO_DATA') ? 'NO_DATA' : 'INSUFFICIENT_HISTORY',
      engineState: setups.some((s) => OPEN_STATES.includes(s.state)) ? 'TRACKING' : 'WAITING_FOR_LEVEL',
      knowledgeTime: this.lastKey ? this.lastKey[0] : null,
      price: this.price,
      timeframes,
      h4,
      h1,
      levels,
      setups,
      events: clone(this.events.slice(-st.maxEvents)),
      signal: live ? { side: live.side, setupId: live.id, at: live.entry!.knownAt } : null,
      settingsKey: hleSettingsKey(st),
    };
  }
}

export function analyzeHighLow(o: HLEEngineOptions & { candles: HLEInput; currentPrice?: number | null }): HLESnapshot {
  const e = new HighLowEngine(o);
  e.update(o.candles, o.currentPrice === undefined ? {} : { currentPrice: o.currentPrice });
  return e.snapshot();
}
