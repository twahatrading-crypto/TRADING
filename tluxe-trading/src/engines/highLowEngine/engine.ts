import type { InstrumentId } from '../../types/instruments';
import type { Candle } from '../../types/market';
import { DEFAULT_HLE_SETTINGS, HLE_TF_SECONDS, HLE_TIMEFRAMES, hleSettingsKey, KIND_WEIGHT, RATING_BANDS, RATING_WEIGHTS, type HLESettings } from './config';
import { finalizeHLEScore, hleScoreFractions } from './score';
import { directionOf, inAsia, structureBias, Tf, type Pivot } from './structure';
import type {
  BlockerCode,
  Candidate,
  ConfluenceItem,
  HLEEvent,
  HLEEventType,
  HLESnapshot,
  HLETfStatus,
  HLETimeframe,
  Level,
  LevelRating,
  LevelSource,
  LevelType,
  RawBias,
  Setup,
  SetupState,
  Side,
} from './types';
import { TERMINAL } from './types';

/* ============================================================================
 * HIGH / LOW ENGINE — the documented High / Low reversal workflow (migration handoff §3–§10),
 * rebuilt as a deterministic, incremental state machine. Separate from High / Low Reversal.
 *
 *  • CLOSED candles only. Bars are processed in knowledge steps K (every bar that closes at K, on
 *    every timeframe, is added before anything is evaluated at K) — exactly what an analysis at
 *    asOf = K sees. Every past bar is judged with the ATR AT that bar.
 *  • H4 direction and H1 bias are context (scored, never a gate). Counter-trend is always allowed
 *    and labelled.
 *  • H1 levels: Previous Day High/Low (UTC day, ≥ 4 H1 bars, walk back ≤ 7 days, validFrom = the
 *    day end) · Asia High/Low (Asia/Tokyo 09–18 weekdays on M15; each side valid at the close of
 *    the candle that set it) · H1 pivot clusters (strict k = 2 pivots in the last 200 H1 bars,
 *    chained within max(ATR × 0.15, price × 0.00015); the cluster with the most pivots is the
 *    Major Swing, the others Equal / Swing Highs-Lows). A level does not exist before validFrom.
 *    Level state ACTIVE → SWEPT → CONSUMED on H1 with the tolerance FROZEN at validFrom (R2 fix).
 *  • BUY (SELL mirrors via frame negation): a low is NOT a buy.
 *     sweep   first M15 bar after validFrom with low < level − 0.10 × ATR(bar)
 *     reclaim an M15 CLOSE above the level within 4 bars of the sweep (sweep run frozen there);
 *             sweep candle closed > 0.10 ATR beyond and no reclaim in 4 bars → LEVEL_BROKEN
 *     M5      from the first M5 bar after the sweep run, within 72 bars: a CLOSE above the newest
 *             confirmed swing high (formed at/after the sweep, else the latest one — R8, flagged)
 *             + 0.05 × ATR(bar). CHOCH if the M5 bias before the sweep was not bullish, else BOS.
 *             An M5 close below the swept extreme first → STRUCTURE_FAILED.
 *     zone    0.5–0.786 retracement of the impulse (swept extreme … leg high); SL = extreme −
 *             0.15 × M5 ATR at the break. Frozen.
 *     M1      from the first M1 bar after the break: overlap with the zone within 180 bars
 *             (else EXPIRED — R5 fix) = pullback. An M1 close through the SL → STRUCTURE_FAILED
 *             (outranks progress, also after confirmation). M1 never sets direction.
 *     entry   at the pullback close: entry = min(zone high, last closed M15 close) kept inside the
 *             zone; TP1/TP2 = the nearest opposing levels (not consumed, valid by then, ≥ 0.25 R
 *             away). No target → NO_TARGET (never invented). Entry / SL / TP / R / score FROZEN
 *             there (R1 fix). R:R < 1.5 is reported only.
 *  • A sweep older than 48 M15 bars ends the setup with a logged EXPIRED event (R3 / R5 fix —
 *    setups never vanish silently). One setup per level.
 * ========================================================================== */

export type HLEInput = Partial<Record<HLETimeframe, readonly Candle[]>>;
export interface HLEEngineOptions {
  instrumentId: InstrumentId;
  tickSize: number;
  settings?: HLESettings;
}
export interface HLEUpdateResult {
  /** A previously processed CLOSED bar changed (broker revision, handoff R6) → full deterministic rebuild. */
  rebuilt: boolean;
  revised: { tf: HLETimeframe; time: number }[];
}

type FBar = { o: number; h: number; l: number; c: number };
const frame = (sign: 1 | -1, c: Candle): FBar => (sign === 1 ? { o: c.open, h: c.high, l: c.low, c: c.close } : { o: -c.open, h: -c.low, l: -c.high, c: -c.close });
const DAY = 86400;
const REVISION_WINDOW = 50;
const same = (a: Candle | undefined, b: Candle | null) => !!a && !!b && a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const c01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
const stamp = (t: number) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').slice(0, 13);
const OPEN: readonly SetupState[] = ['SWEPT', 'WAITING_M5', 'WAITING_M1', 'NO_TARGET', 'ENTRY_READY'];
const PRE_ENTRY: readonly SetupState[] = ['SWEPT', 'WAITING_M5', 'WAITING_M1', 'NO_TARGET'];

export const LEVEL_TYPE_LABEL: Record<LevelType, string> = {
  PDH: 'Previous Day High',
  PDL: 'Previous Day Low',
  ASIA_HIGH: 'Asia High',
  ASIA_LOW: 'Asia Low',
  SWING_HIGH: 'Major Swing High',
  SWING_LOW: 'Major Swing Low',
};
export const levelLabel = (t: LevelType) => LEVEL_TYPE_LABEL[t];

/** The six mandatory booleans (handoff §9.1) from a setup's own evidence. The score is not among them. */
export function mandatoryGates(s: Setup): { level: boolean; sweep: boolean; reclaim: boolean; m5: boolean; pullback: boolean; target: boolean } {
  return {
    level: !!s.touch && s.sweep.time >= s.levelValidFrom,
    sweep: s.sweep.time >= s.levelValidFrom,
    reclaim: !!s.reclaim && s.reclaim.knownAt >= s.sweep.knownAt,
    m5: !!s.m5 && !!s.reclaim && s.m5.knownAt >= s.reclaim.knownAt,
    pullback: !!s.entry && !!s.m5 && s.entry.knownAt >= s.m5.knownAt,
    target: !!s.risk && s.risk.tp1 !== null,
  };
}

interface LevelRt {
  l: Level;
  sign: 1 | -1;
  fP: number;
  h1Cursor: number;
  m15Cursor: number;
  touchKnownAt: number | null;
  setup: SetupRt | null;
}
interface SetupRt {
  s: Setup;
  sign: 1 | -1;
  lv: LevelRt;
  fP: number;
  sIdx: number;
  runOpen: boolean;
  runEnd: number;
  fExt: number;
  m15Cursor: number;
  c0: number;
  m5Cursor: number;
  preBias: { dir: number; label: RawBias } | null;
  brokeIdx: number;
  fSL: number;
  fzlo: number;
  fzhi: number;
  e0: number;
  m1Cursor: number;
  conf: { len: number; fvg: ConfluenceItem[]; ob: ConfluenceItem[] } | null;
}

export class HighLowEngine {
  readonly instrumentId: InstrumentId;
  readonly settings: HLESettings;
  private tf!: Record<HLETimeframe, Tf>;
  private accepted!: Record<HLETimeframe, Candle[]>;
  private processed!: Record<HLETimeframe, number>;
  private consumed!: Record<HLETimeframe, number>;
  private firstInput!: Record<HLETimeframe, Candle | null>;
  private lastInput!: Record<HLETimeframe, Candle | null>;
  private rejected!: Record<HLETimeframe, number>;
  private tailInput!: Record<HLETimeframe, readonly Candle[]>;
  private K: number | null = null;
  private levels: LevelRt[] = [];
  private byId = new Map<string, LevelRt>();
  private clusters = new Map<string, LevelRt>();
  private pd: { d0: number; high: LevelRt; low: LevelRt } | null = null;
  private pdDay: number | null = null;
  private asia: { lastIdx: number; high: number; highAt: number; low: number; lowAt: number; hiDirty: boolean; loDirty: boolean } | null = null;
  private asiaLv: { high: LevelRt | null; low: LevelRt | null } = { high: null, low: null };
  private gateOpen = false;
  private setups: SetupRt[] = [];
  private events: HLEEvent[] = [];
  private h4Raw: RawBias | null = null;
  private h1Raw: RawBias | null = null;
  private displayPrice: number | null = null;

  constructor(o: HLEEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.settings = o.settings ?? { ...DEFAULT_HLE_SETTINGS };
    this.reset();
  }

  private reset(): void {
    const st = this.settings;
    const mk = <T>(f: () => T) => Object.fromEntries(HLE_TIMEFRAMES.map((tf) => [tf, f()])) as Record<HLETimeframe, T>;
    this.tf = mk(() => null as unknown as Tf);
    for (const t of HLE_TIMEFRAMES) this.tf[t] = new Tf(HLE_TF_SECONDS[t], st.swingK, st.atrLen);
    this.accepted = mk(() => []);
    this.processed = mk(() => 0);
    this.consumed = mk(() => 0);
    this.firstInput = mk(() => null);
    this.lastInput = mk(() => null);
    this.rejected = mk(() => 0);
    this.tailInput = mk(() => []);
    this.K = null;
    this.levels = [];
    this.byId = new Map();
    this.clusters = new Map();
    this.pd = null;
    this.pdDay = null;
    this.asia = null;
    this.asiaLv = { high: null, low: null };
    this.gateOpen = false;
    this.setups = [];
    this.events = [];
    this.h4Raw = null;
    this.h1Raw = null;
  }

  /** Feed CLOSED candles per timeframe (ascending). Incremental; any change to a processed bar rebuilds deterministically. */
  update(input: HLEInput, o: { currentPrice?: number | null } = {}): HLEUpdateResult {
    let revised: HLEUpdateResult['revised'] = [];
    let rebuilt = false;
    if (!this.ingest(input)) {
      revised = this.revisions(input);
      this.reset();
      this.ingest(input);
      rebuilt = true;
    }
    this.run();
    const m1 = this.accepted.M1;
    this.displayPrice = o.currentPrice !== undefined ? o.currentPrice : m1.length ? m1[m1.length - 1]!.close : null;
    return { rebuilt, revised };
  }

  private revisions(input: HLEInput): HLEUpdateResult['revised'] {
    const out: HLEUpdateResult['revised'] = [];
    for (const tf of HLE_TIMEFRAMES) {
      const next = new Map((input[tf] ?? []).map((c) => [c.time, c]));
      for (const c of this.accepted[tf].slice(0, this.processed[tf])) {
        const n = next.get(c.time);
        if (n && !same(n, c)) out.push({ tf, time: c.time });
      }
    }
    return out;
  }

  private ingest(input: HLEInput): boolean {
    for (const tf of HLE_TIMEFRAMES) {
      const arr = input[tf] ?? [];
      const n = this.consumed[tf];
      if (n > arr.length || (n > 0 && (!same(arr[0], this.firstInput[tf]) || !same(arr[n - 1], this.lastInput[tf])))) return false;
      // Broker revisions (handoff R6) hit recent closed bars: re-check the last REVISION_WINDOW consumed inputs.
      const tail = this.tailInput[tf];
      for (let k = 0; k < tail.length; k++) {
        const a = arr[n - tail.length + k];
        if (a !== tail[k] && !same(a, tail[k]!)) return false;
      }
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
      this.tailInput[tf] = arr.slice(Math.max(0, arr.length - REVISION_WINDOW));
      // A new bar closing at or before the last processed knowledge step would rewrite history → rebuild.
      const next = acc[this.processed[tf]];
      if (next && this.K !== null && next.time + HLE_TF_SECONDS[tf] <= this.K) return false;
    }
    return true;
  }

  private run(): void {
    for (;;) {
      let K = Infinity;
      for (const t of HLE_TIMEFRAMES) {
        const b = this.accepted[t][this.processed[t]];
        if (b) K = Math.min(K, b.time + HLE_TF_SECONDS[t]);
      }
      if (K === Infinity) return;
      const pushed = new Set<HLETimeframe>();
      for (const t of HLE_TIMEFRAMES) {
        for (;;) {
          const b = this.accepted[t][this.processed[t]];
          if (!b || b.time + HLE_TF_SECONDS[t] !== K) break;
          this.tf[t].push(b);
          this.processed[t] += 1;
          pushed.add(t);
        }
      }
      this.K = K;
      this.step(K, pushed);
    }
  }

  /* -------------------------------- events -------------------------------- */

  private emit(type: HLEEventType, time: number, tf: HLETimeframe, price: number | null, setupId: string | null, message: string, subject?: string): void {
    this.events.push({ id: `${this.instrumentId}:${type}:${subject ?? setupId ?? tf}:${time}`, time, instrumentId: this.instrumentId, timeframe: tf, type, price, setupId, message });
  }

  /* --------------------------------- step --------------------------------- */

  private step(K: number, pushed: Set<HLETimeframe>): void {
    const st = this.settings;
    if (pushed.has('H4')) {
      const ctx = directionOf(this.tf.H4, st.minBars.H4, st.dirSwings);
      if (ctx.raw !== this.h4Raw) {
        if (this.h4Raw !== null || ctx.raw !== 'UNKNOWN') this.emit('H4_BIAS_CHANGED', K, 'H4', null, null, `H4 direction ${this.h4Raw ?? '—'} → ${ctx.raw} (${ctx.reason})`);
        this.h4Raw = ctx.raw;
      }
    }
    if (pushed.has('H1')) {
      const ctx = directionOf(this.tf.H1, 60, st.contextSwings);
      if (ctx.raw !== this.h1Raw) {
        if (this.h1Raw !== null || ctx.raw !== 'UNKNOWN') this.emit('H1_BIAS_CHANGED', K, 'H1', null, null, `H1 bias ${this.h1Raw ?? '—'} → ${ctx.raw} (${ctx.reason})`);
        this.h1Raw = ctx.raw;
      }
    }
    if (pushed.has('M15')) this.trackAsia();
    const opened = !this.gateOpen && this.tf.H1.length >= st.minLevelBars;
    if (opened) this.gateOpen = true;
    if (this.gateOpen) {
      if (pushed.has('H1') || opened) this.rebuildClusters(K);
      this.checkPD(K, opened);
      this.publishAsia(K, opened);
      this.advanceLevelStates(K);
      for (const lv of [...this.levels]) if (lv.l.retiredAt === null && !lv.setup && lv.l.state !== 'CONSUMED') this.scanLevel(lv, K);
    }
    for (const rt of this.setups) if (OPEN.includes(rt.s.state)) this.advance(rt, K);
  }

  /* -------------------------------- levels -------------------------------- */

  private tolAt(t: number): { atr: number; tol: number } {
    const h1 = this.tf.H1;
    const i = h1.lastClosedBy(t);
    if (i < 0) return { atr: 0, tol: 0 };
    const atr = h1.atrAt(i) ?? 0;
    return { atr, tol: Math.max(atr * this.settings.levelTolH1Atr, h1.bars[i]!.close * this.settings.levelTolPrice) };
  }

  private addLevel(type: LevelType, price: number, formedAt: number, validFrom: number, touches: number, members: number[], identity: string, K: number): LevelRt {
    const id = `${this.instrumentId}:HLE:LVL:${type}:${identity}`;
    const have = this.byId.get(id);
    if (have) return have;
    const kind: 'high' | 'low' = type === 'PDH' || type === 'ASIA_HIGH' || type === 'SWING_HIGH' ? 'high' : 'low';
    const source: LevelSource = type === 'PDH' ? 'pdh' : type === 'PDL' ? 'pdl' : type === 'ASIA_HIGH' || type === 'ASIA_LOW' ? 'asia' : 'swing';
    const { atr, tol } = this.tolAt(validFrom);
    const sign: 1 | -1 = kind === 'low' ? 1 : -1;
    const l: Level = {
      id,
      type,
      source,
      kind,
      side: kind === 'low' ? 'BUY' : 'SELL',
      price,
      formedAt,
      validFrom,
      createdAt: K,
      touches,
      members,
      atr,
      tol,
      state: 'ACTIVE',
      sweptAt: null,
      consumedAt: null,
      penetration: 0,
      retiredAt: null,
      setupId: null,
      label: LEVEL_TYPE_LABEL[type],
      major: false,
      rating: { score: 0, label: 'WEAK', parts: { kind: 0, touches: 0, reaction: 0, freshness: 0, untouched: 0 } },
      distance: null,
      distanceAtr: null,
      near: false,
      touchedAt: null,
    };
    const lv: LevelRt = { l, sign, fP: sign * price, h1Cursor: -1, m15Cursor: -1, touchKnownAt: null, setup: null };
    this.levels.push(lv);
    this.byId.set(id, lv);
    if (source !== 'swing') this.emit('LEVEL_DETECTED', K, 'H1', price, null, `${LEVEL_TYPE_LABEL[type]} ${price} valid from ${hhmm(validFrom)} UTC`, id);
    return lv;
  }

  /** Replaced by a newer definition. A level with a running setup stays with it; others are dropped. */
  private retire(lv: LevelRt | null, K: number): void {
    if (!lv || lv.l.retiredAt !== null) return;
    lv.l.retiredAt = K;
    if (!lv.setup) {
      this.levels = this.levels.filter((x) => x !== lv);
      this.byId.delete(lv.l.id);
    }
  }

  /** H1 pivot clusters (VPR.liquidityLevels): strict k-pivots in the last 200 H1 bars, chained within tol. */
  private rebuildClusters(K: number): void {
    const st = this.settings;
    const h1 = this.tf.H1;
    const len = h1.length;
    const atr = h1.lastAtr() ?? 0;
    const tol = Math.max(atr * st.levelTolH1Atr, h1.bars[len - 1]!.close * st.levelTolPrice);
    const groups: { kind: 'high' | 'low'; g: Pivot[] }[] = [];
    for (const kind of ['high', 'low'] as const) {
      const piv = [...h1.pivots(kind, Math.max(0, len - st.clusterSwings), len)].sort((a, b) => a.price - b.price || a.time - b.time);
      let cur: Pivot[] | null = null;
      for (const p of piv) {
        if (cur && p.price - cur[cur.length - 1]!.price <= tol) cur.push(p);
        else groups.push({ kind, g: (cur = [p]) });
      }
    }
    const byIdentity = new Map<string, { kind: 'high' | 'low'; g: Pivot[] }>();
    for (const v of groups) byIdentity.set(`${v.kind}:${v.g.map((p) => p.time).sort((a, b) => a - b).join('.')}`, v);
    for (const [idn, lv] of [...this.clusters]) {
      if (!byIdentity.has(idn)) {
        this.retire(lv, K);
        this.clusters.delete(idn);
      }
    }
    for (const [idn, v] of byIdentity) {
      if (this.clusters.has(idn)) continue;
      const price = v.g.reduce((a, p) => a + p.price, 0) / v.g.length;
      const times = v.g.map((p) => p.time).sort((a, b) => a - b);
      const lv = this.addLevel(v.kind === 'high' ? 'SWING_HIGH' : 'SWING_LOW', price, times[times.length - 1]!, K, v.g.length, times, `${idn.replace(/[^0-9.]/g, '')}@${K}`, K);
      this.clusters.set(idn, lv);
    }
  }

  /** Previous UTC day with ≥ 4 H1 bars, walking back ≤ 7 days; validFrom = the end of that day. */
  private checkPD(K: number, opened: boolean): void {
    const st = this.settings;
    const day = Math.floor(K / DAY) * DAY;
    if (!opened && this.pdDay === day) return;
    this.pdDay = day;
    const h1 = this.tf.H1;
    for (let back = 1; back <= st.pdMaxBack; back++) {
      const d0 = day - back * DAY;
      const d1 = d0 + DAY;
      const i0 = h1.firstFrom(d0);
      if (i0 < 0 || h1.bars[i0]!.time >= d1) continue;
      let i1 = h1.firstFrom(d1);
      if (i1 < 0) i1 = h1.length;
      if (i1 - i0 < st.pdMinBars) continue;
      if (this.pd?.d0 === d0) return;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = i0; i < i1; i++) {
        hi = Math.max(hi, h1.bars[i]!.high);
        lo = Math.min(lo, h1.bars[i]!.low);
      }
      this.retire(this.pd?.high ?? null, K);
      this.retire(this.pd?.low ?? null, K);
      this.pd = { d0, high: this.addLevel('PDH', hi, d1, d1, 1, [], String(d0), K), low: this.addLevel('PDL', lo, d1, d1, 1, [], String(d0), K) };
      return;
    }
    this.retire(this.pd?.high ?? null, K);
    this.retire(this.pd?.low ?? null, K);
    this.pd = null;
  }

  /** Most recent contiguous run of M15 bars inside the Asia/Tokyo session; extremes keep the EARLIEST bar. */
  private trackAsia(): void {
    const m15 = this.tf.M15;
    const i = m15.length - 1;
    const b = m15.bars[i]!;
    if (!inAsia(b.time, this.settings.asiaStart, this.settings.asiaEnd)) return;
    const a = this.asia;
    if (a && a.lastIdx === i - 1) {
      a.lastIdx = i;
      if (b.high > a.high) Object.assign(a, { high: b.high, highAt: b.time, hiDirty: true });
      if (b.low < a.low) Object.assign(a, { low: b.low, lowAt: b.time, loDirty: true });
    } else this.asia = { lastIdx: i, high: b.high, highAt: b.time, low: b.low, lowAt: b.time, hiDirty: true, loDirty: true };
  }

  private publishAsia(K: number, opened: boolean): void {
    const a = this.asia;
    if (!a) return;
    if (a.hiDirty || opened) {
      this.retire(this.asiaLv.high, K);
      this.asiaLv.high = this.addLevel('ASIA_HIGH', a.high, a.highAt, a.highAt + HLE_TF_SECONDS.M15, 1, [], String(a.highAt), K);
      a.hiDirty = false;
    }
    if (a.loDirty || opened) {
      this.retire(this.asiaLv.low, K);
      this.asiaLv.low = this.addLevel('ASIA_LOW', a.low, a.lowAt, a.lowAt + HLE_TF_SECONDS.M15, 1, [], String(a.lowAt), K);
      a.loDirty = false;
    }
  }

  /** ACTIVE → SWEPT (wick beyond tol) → CONSUMED (close beyond tol), on H1 from validFrom, tol frozen (R2). */
  private advanceLevelStates(K: number): void {
    const h1 = this.tf.H1;
    for (const lv of this.levels) {
      const l = lv.l;
      if (l.state === 'CONSUMED' || (l.retiredAt !== null && !(lv.setup && OPEN.includes(lv.setup.s.state)))) continue;
      if (lv.h1Cursor < 0) {
        const f = h1.firstFrom(l.validFrom);
        if (f < 0) continue;
        lv.h1Cursor = f;
      }
      for (let i = lv.h1Cursor; i < h1.length; i++) {
        lv.h1Cursor = i + 1;
        const b = frame(lv.sign, h1.bars[i]!);
        if (!(b.l < lv.fP - l.tol)) continue;
        l.penetration = Math.max(l.penetration, lv.fP - b.l);
        if (b.c < lv.fP - l.tol) {
          l.state = 'CONSUMED';
          l.consumedAt = h1.bars[i]!.time;
          if (l.sweptAt === null) l.sweptAt = h1.bars[i]!.time;
          const rt = lv.setup;
          if (rt && PRE_ENTRY.includes(rt.s.state)) this.finish(rt, 'INVALIDATED', 'LEVEL_CONSUMED', rt.s.stage, K, 'H1', `${rt.s.levelLabel} was closed through on H1 (beyond its tolerance) — the level is consumed.`);
          break;
        }
        if (l.state === 'ACTIVE') {
          l.state = 'SWEPT';
          l.sweptAt = h1.bars[i]!.time;
        }
      }
    }
  }

  /** Stage 1 → 2: touch (within 0.25 ATR) and the FIRST M15 sweep (≥ 0.10 ATR beyond) after validFrom. */
  private scanLevel(lv: LevelRt, K: number): void {
    const st = this.settings;
    const m15 = this.tf.M15;
    if (lv.m15Cursor < 0) {
      const vi = m15.firstFrom(lv.l.validFrom);
      if (vi < 0) return;
      lv.m15Cursor = Math.max(vi, m15.length - st.sweepWindow);
    }
    for (let i = lv.m15Cursor; i < m15.length; i++) {
      lv.m15Cursor = i + 1;
      const A = m15.atrAt(i) ?? m15.lastAtr();
      if (!A) continue;
      const b = frame(lv.sign, m15.bars[i]!);
      if (lv.l.touchedAt === null && b.l <= lv.fP + st.levelTolAtr * A) {
        lv.l.touchedAt = m15.bars[i]!.time;
        lv.touchKnownAt = K;
        this.emit('LEVEL_APPROACH', K, 'M15', lv.l.price, null, `Price reached ${lv.l.label} ${lv.l.price}`, lv.l.id);
      }
      if (b.l < lv.fP - st.sweepMinAtr * A) {
        this.createSetup(lv, i, A, K);
        return;
      }
    }
  }

  /* -------------------------------- setups -------------------------------- */

  private createSetup(lv: LevelRt, sIdx: number, A: number, K: number): void {
    const st = this.settings;
    const bar = this.tf.M15.bars[sIdx]!;
    const b = frame(lv.sign, bar);
    const range = Math.max(1e-12, b.h - b.l);
    const wick = (Math.min(b.o, b.c) - b.l) / range;
    const side: Side = lv.l.side;
    const buy = side === 'BUY';
    const id = `${this.instrumentId}:HLE:${side}:${lv.l.type}:${lv.l.id.split(':').pop()}`;
    const s: Setup = {
      id,
      instrumentId: this.instrumentId,
      side,
      levelId: lv.l.id,
      levelType: lv.l.type,
      levelLabel: lv.l.label,
      level: lv.l.price,
      levelValidFrom: lv.l.validFrom,
      state: 'SWEPT',
      code: 'WAITING_RECLAIM',
      stage: 2,
      history: [{ from: null, to: 'SWEPT', time: K, reason: `${buy ? 'SSL' : 'BSL'} taken: M15 traded ${buy ? 'below' : 'above'} ${lv.l.label} by ${((lv.fP - b.l) / A).toFixed(2)} ATR` }],
      touch: { time: lv.l.touchedAt ?? bar.time, knownAt: lv.touchKnownAt ?? K },
      sweep: {
        time: bar.time,
        knownAt: K,
        extreme: lv.sign * b.l,
        extremeTime: bar.time,
        runEnd: bar.time,
        penetration: lv.fP - b.l,
        penetrationAtr: (lv.fP - b.l) / A,
        atr: A,
        wick,
        rejection: wick >= st.rejectWick,
        closedBeyond: b.c < lv.fP - st.sweepMinAtr * A,
      },
      reclaim: null,
      m5: null,
      zone: null,
      entry: null,
      risk: null,
      confluence: null,
      context: null,
      alertKey: null,
      lastUpdate: K,
      distance: null,
      score: finalizeHLEScore({ htfAlignment: 0, levelImportance: 0, sweepQuality: 0, rejectionDisplacement: 0, m5Structure: 0, m1EntryQuality: 0, fvgObConfluence: 0 }, false),
    };
    const rt: SetupRt = { s, sign: lv.sign, lv, fP: lv.fP, sIdx, runOpen: true, runEnd: sIdx, fExt: b.l, m15Cursor: sIdx, c0: -1, m5Cursor: -1, preBias: null, brokeIdx: -1, fSL: 0, fzlo: 0, fzhi: 0, e0: -1, m1Cursor: -1, conf: null };
    lv.setup = rt;
    lv.l.setupId = id;
    this.setups.push(rt);
    this.emit(buy ? 'SSL_TAKEN' : 'BSL_TAKEN', K, 'M15', s.sweep.extreme, id, `${buy ? 'Sell' : 'Buy'}-side liquidity taken at ${lv.l.label} (${s.sweep.penetrationAtr.toFixed(2)} ATR)`);
  }

  private setState(rt: SetupRt, to: SetupState, code: BlockerCode, stage: number, K: number, reason: string): void {
    const s = rt.s;
    s.history.push({ from: s.state, to, time: K, reason });
    s.state = to;
    s.code = code;
    s.stage = stage;
    s.lastUpdate = K;
  }

  private finish(rt: SetupRt, to: 'INVALIDATED' | 'EXPIRED', code: BlockerCode, stage: number, K: number, tf: HLETimeframe, reason: string): void {
    if (TERMINAL.includes(rt.s.state)) return;
    this.setState(rt, to, code, stage, K, reason);
    this.emit(to === 'INVALIDATED' ? 'SETUP_INVALIDATED' : 'SETUP_EXPIRED', K, tf, null, rt.s.id, `${code}: ${reason}`);
  }

  private advance(rt: SetupRt, K: number): void {
    const st = this.settings;
    const s = rt.s;
    const m15 = this.tf.M15;
    const m5 = this.tf.M5;
    const m1 = this.tf.M1;
    const buy = s.side === 'BUY';
    const W = st.reclaimWindow;

    // ---- M15: sweep run + reclaim / break --------------------------------------------------
    if (s.state === 'SWEPT') {
      for (let i = rt.m15Cursor; i < m15.length; i++) {
        rt.m15Cursor = i + 1;
        const bar = m15.bars[i]!;
        const b = frame(rt.sign, bar);
        if (rt.runOpen) {
          if (i <= rt.sIdx + W && b.l < rt.fP) {
            if (b.l < rt.fExt) {
              rt.fExt = b.l;
              s.sweep.extremeTime = bar.time;
            }
            rt.runEnd = i;
          } else rt.runOpen = false;
        }
        s.sweep.extreme = rt.sign * rt.fExt;
        s.sweep.runEnd = m15.bars[rt.runEnd]!.time;
        if (i <= rt.sIdx + W && b.c > rt.fP) {
          rt.runOpen = false; // the sweep run is frozen at the reclaim close
          s.reclaim = { time: bar.time, knownAt: K, price: bar.close, bars: i - rt.sIdx + 1 };
          s.sweep.rejection = true;
          this.setState(rt, 'WAITING_M5', 'WAITING_STRUCTURE', 2, K, `M15 closed back ${buy ? 'above' : 'below'} ${s.levelLabel} after ${s.reclaim.bars} bar(s) — reclaimed`);
          this.emit('LEVEL_RECLAIMED', K, 'M15', bar.close, s.id, `Level reclaimed after ${s.reclaim.bars} M15 bar(s)`);
          break;
        }
        if (s.sweep.closedBeyond && i - rt.sIdx >= W) {
          this.finish(rt, 'INVALIDATED', 'LEVEL_BROKEN', 1, K, 'M15', `${s.levelLabel} was closed through and not reclaimed within ${W} M15 candles. That is a break, not a sweep — this level is no longer valid for a reversal.`);
          return;
        }
      }
    }

    // ---- M5: CHOCH / BOS on a closed candle ------------------------------------------------
    if (s.state === 'WAITING_M5') {
      if (rt.c0 < 0) {
        const c0 = m5.firstFrom(m15.bars[rt.runEnd]!.time + HLE_TF_SECONDS.M15);
        if (c0 >= 0) {
          rt.c0 = c0;
          rt.m5Cursor = c0;
          const pb = structureBias(m5, c0 + 1, st.contextSwings);
          rt.preBias = { dir: pb.dir, label: pb.label };
        }
      }
      if (rt.c0 >= 0) {
        const t0 = m5.bars[rt.c0]!.time;
        for (let i = rt.m5Cursor; i < m5.length && i <= rt.c0 + st.confirmWindow; i++) {
          rt.m5Cursor = i + 1;
          const b = frame(rt.sign, m5.bars[i]!);
          if (b.c < rt.fExt) {
            this.finish(rt, 'INVALIDATED', 'STRUCTURE_FAILED', 2, K, 'M5', `M5 closed back through the swept extreme ${s.sweep.extreme} before structure turned.`);
            return;
          }
          if (i < 3 * st.swingK + 2) continue;
          const piv = m5.pivots(rt.sign === 1 ? 'high' : 'low', Math.max(0, i - st.m5SwingScan), i);
          const after = piv.filter((p) => p.time >= t0);
          const cand = after[after.length - 1] ?? piv[piv.length - 1];
          if (!cand) continue;
          const a = m5.atrAt(i) ?? 0;
          if (b.c > rt.sign * cand.price + st.breakMarginAtr * a) {
            this.confirm(rt, i, cand, after.length === 0, K);
            break;
          }
        }
      }
    }

    // ---- M1: pullback into the zone; SL close outranks everything ----------------------------
    if (s.state === 'WAITING_M1' || s.state === 'NO_TARGET' || s.state === 'ENTRY_READY') {
      if (rt.e0 < 0) {
        const e0 = m1.firstFrom(m5.bars[rt.brokeIdx]!.time + HLE_TF_SECONDS.M5);
        if (e0 >= 0) {
          rt.e0 = e0;
          rt.m1Cursor = e0;
        }
      }
      if (rt.e0 >= 0) {
        for (let j = rt.m1Cursor; j < m1.length; j++) {
          rt.m1Cursor = j + 1;
          const b = frame(rt.sign, m1.bars[j]!);
          if (b.c < rt.fSL) {
            this.finish(rt, 'INVALIDATED', 'STRUCTURE_FAILED', 3, K, 'M1', `Price closed through the protective level at ${s.zone!.stop} after the M5 ${s.m5!.kind}. The setup is invalidated.`);
            return;
          }
          if (s.state !== 'WAITING_M1') continue;
          if (j > rt.e0 + st.entryWindow) {
            this.finish(rt, 'EXPIRED', 'EXPIRED', 3, K, 'M1', `No M1 pullback into the zone within ${st.entryWindow} M1 candles of the M5 ${s.m5!.kind}.`);
            return;
          }
          if (b.l <= rt.fzhi && b.h >= rt.fzlo) this.pullback(rt, j, K);
        }
      }
    }

    // ---- Explicit expiry (never a silent disappearance) --------------------------------------
    const since = m15.length - 1 - rt.sIdx;
    if (since > st.expiryBars) {
      if (s.state === 'SWEPT' || s.state === 'WAITING_M5')
        this.finish(rt, 'EXPIRED', 'EXPIRED', 2, K, 'M15', `No M5 structure within ${st.expiryBars} M15 candles of the sweep — the setup went stale.`);
      else if (s.state === 'NO_TARGET' || s.state === 'ENTRY_READY') this.finish(rt, 'EXPIRED', 'EXPIRED', s.stage, K, 'M15', `Setup aged out: the sweep is older than ${st.expiryBars} M15 candles.`);
    }
  }

  private confirm(rt: SetupRt, bi: number, cand: Pivot, preSweep: boolean, K: number): void {
    const st = this.settings;
    const s = rt.s;
    const m5 = this.tf.M5;
    const bar = m5.bars[bi]!;
    const a = m5.atrAt(bi) ?? 0;
    const body = Math.abs(bar.close - bar.open);
    const rng = Math.max(1e-12, bar.high - bar.low);
    const dir = rt.sign;
    const kind: 'BOS' | 'CHOCH' = rt.preBias!.dir === dir ? 'BOS' : 'CHOCH';
    let fHi = -Infinity;
    let fLo = Infinity;
    for (let i = rt.c0; i <= bi; i++) {
      const b = frame(rt.sign, m5.bars[i]!);
      fHi = Math.max(fHi, b.h);
      fLo = Math.min(fLo, b.l);
    }
    fHi = Math.max(fHi, frame(rt.sign, bar).c);
    const from = Math.min(fLo, rt.fExt);
    const to = fHi;
    const span = to - from;
    rt.fzlo = to - span * st.pullbackMax;
    rt.fzhi = to - span * st.pullbackMin;
    rt.fSL = rt.fExt - st.stopBufferAtr * a;
    rt.brokeIdx = bi;
    const r = (f: number) => rt.sign * f;
    s.m5 = {
      kind,
      preBias: rt.preBias!.label,
      brokenLevel: cand.price,
      swingTime: cand.time,
      preSweepSwing: preSweep,
      time: bar.time,
      knownAt: K,
      close: bar.close,
      atr: a,
      displacement: { body, bodyAtr: a ? body / a : 0, bodyPct: body / rng, displaced: a ? body / a >= st.dispBodyAtr && body / rng >= st.dispBodyPct : false },
    };
    s.zone = {
      low: Math.min(r(rt.fzlo), r(rt.fzhi)),
      high: Math.max(r(rt.fzlo), r(rt.fzhi)),
      impulseFrom: r(from),
      impulseTo: r(to),
      stop: r(rt.fSL),
      definedAt: K,
    };
    s.alertKey = `HLE-${this.instrumentId}-${s.side}-${stamp(bar.time)}`;
    const text = `${s.side === 'BUY' ? 'Bullish' : 'Bearish'} ${kind} from ${rt.preBias!.label.toLowerCase()} M5 structure`;
    this.setState(rt, 'WAITING_M1', 'WAITING_PULLBACK', 3, K, `${text} — close through ${cand.price}${preSweep ? ' (pre-sweep swing)' : ''}${s.m5.displacement.displaced ? ' + displacement' : ''}`);
    this.emit(kind === 'CHOCH' ? 'M5_CHOCH' : 'M5_BOS', K, 'M5', bar.close, s.id, `${text} (close ${bar.close} through ${cand.price})`);
  }

  private pullback(rt: SetupRt, j: number, K: number): void {
    const st = this.settings;
    const s = rt.s;
    const bar = this.tf.M1.bars[j]!;
    s.entry = { time: bar.time, knownAt: K, price: bar.close };
    this.emit('M1_PULLBACK', K, 'M1', bar.close, s.id, `M1 pullback into ${s.zone!.low} – ${s.zone!.high}`);
    const m15 = this.tf.M15;
    const fp15 = frame(rt.sign, m15.bars[m15.length - 1]!).c;
    const fEntry = Math.max(rt.fzlo, Math.min(rt.fzhi, fp15));
    const risk = Math.abs(fEntry - rt.fSL);
    const want = rt.sign === 1 ? 'high' : 'low';
    const cands = this.levels
      .filter((x) => x.l.kind === want && x.l.retiredAt === null && x.l.state !== 'CONSUMED' && x.l.validFrom <= K && x.l.createdAt <= K && rt.sign * x.l.price > fEntry + st.minTargetRisk * risk)
      .sort((a, b) => rt.sign * a.l.price - rt.sign * b.l.price || (a.l.id < b.l.id ? -1 : 1));
    const t1 = cands[0];
    if (!t1) {
      this.setState(rt, 'NO_TARGET', 'NO_TARGET', 4, K, `No opposing liquidity ${s.side === 'BUY' ? 'above' : 'below'} the entry to target. The engine will not invent one.`);
      this.emit('NO_TARGET', K, 'M1', null, s.id, 'Pullback reached, but there is no opposing liquidity to target — no entry.');
      return;
    }
    const t2 = cands[1] ?? null;
    const label = (x: LevelRt) => this.levelView(x, null).label;
    const rr = (x: LevelRt) => (risk > 0 ? Math.abs(rt.sign * x.l.price - fEntry) / risk : 0);
    s.risk = {
      entry: rt.sign * fEntry,
      stop: rt.sign * rt.fSL,
      tp1: t1.l.price,
      tp1Source: label(t1),
      tp2: t2 ? t2.l.price : null,
      tp2Source: t2 ? label(t2) : null,
      risk,
      rr1: rr(t1),
      rr2: t2 ? rr(t2) : null,
      belowMinRR: rr(t1) < st.minRR,
      targetsConsidered: cands.length,
    };
    const conf = this.confluence(rt, this.tf.M1.length);
    s.confluence = { fvg: conf.fvg, ob: conf.ob, at: K };
    const h4 = directionOf(this.tf.H4, st.minBars.H4, st.dirSwings);
    const h1 = directionOf(this.tf.H1, 60, st.contextSwings);
    s.context = { h4: h4.raw, h4Dir: h4.dir, h1: h1.raw, h1Dir: h1.dir, counterTrend: h4.dir !== 0 && h4.dir !== rt.sign };
    this.setState(rt, 'ENTRY_READY', 'NONE', 5, K, `${s.side} CONFIRMED — every mandatory stage passed (entry ${s.risk.entry}, SL ${s.risk.stop}, TP1 ${s.risk.tp1})`);
    s.score = this.scoreOf(rt, true);
    this.emit('ENTRY_READY', K, 'M1', s.risk.entry, s.id, `${s.side} CONFIRMED — entry ${s.risk.entry}, SL ${s.risk.stop}, TP1 ${s.risk.tp1} (${s.risk.tp1Source})${s.context.counterTrend ? ' · counter-trend' : ''}`);
  }

  /**
   * M1 FVG / order-block confluence overlapping the zone (score only, 5 points). The handoff does not
   * document these detectors, so TLUXE defines them: FVG = 3-candle gap (bar i−1 high < bar i+1 low for
   * a BUY) that started at/after the M5 break and was neither closed through nor fully filled later;
   * OB = last opposite candle whose high is closed above within 3 bars and that no later close broke.
   */
  private confluence(rt: SetupRt, len: number): { fvg: ConfluenceItem[]; ob: ConfluenceItem[] } {
    const m1 = this.tf.M1;
    const start = Math.max(1, len - this.settings.confluenceBars);
    const breakT = this.tf.M5.bars[rt.brokeIdx]!.time;
    const f = (i: number) => frame(rt.sign, m1.bars[i]!);
    const overlaps = (lo: number, hi: number) => lo <= rt.fzhi && hi >= rt.fzlo;
    const real = (lo: number, hi: number, time: number): ConfluenceItem => (rt.sign === 1 ? { low: lo, high: hi, time } : { low: -hi, high: -lo, time });
    const fvg: ConfluenceItem[] = [];
    const ob: ConfluenceItem[] = [];
    for (let i = start; i < len - 1; i++) {
      const a = f(i - 1);
      const c = f(i + 1);
      if (m1.bars[i - 1]!.time >= breakT && c.l > a.h) {
        let dead = false;
        for (let j = i + 2; j < len && !dead; j++) if (f(j).l <= a.h) dead = true;
        if (!dead && overlaps(a.h, c.l)) fvg.push(real(a.h, c.l, m1.bars[i - 1]!.time));
      }
      const x = f(i);
      if (x.c < x.o) {
        let disp = -1;
        for (let j = i + 1; j <= Math.min(len - 1, i + 3); j++)
          if (f(j).c > x.h) {
            disp = j;
            break;
          }
        if (disp < 0) continue;
        let broken = false;
        for (let j = disp + 1; j < len && !broken; j++) if (f(j).c < x.l) broken = true;
        if (!broken && overlaps(x.l, x.h)) ob.push(real(x.l, x.h, m1.bars[i]!.time));
      }
    }
    return { fvg, ob };
  }

  /* ------------------------------ evaluation ------------------------------ */

  private majors(): Set<string> {
    const price = this.lastM15Close();
    const out = new Set<string>();
    for (const kind of ['high', 'low'] as const) {
      let best: LevelRt | null = null;
      for (const lv of this.clusters.values()) {
        if (lv.l.kind !== kind) continue;
        if (!best || lv.l.touches > best.l.touches || (lv.l.touches === best.l.touches && price !== null && Math.abs(lv.l.price - price) < Math.abs(best.l.price - price))) best = lv;
      }
      if (best) out.add(best.l.id);
    }
    return out;
  }

  private lastM15Close(): number | null {
    const m = this.tf.M15;
    return m.length ? m.bars[m.length - 1]!.close : null;
  }

  /** Level rating (handoff §4.6) and display fields, evaluated now. */
  private levelView(lv: LevelRt, majors: Set<string> | null): Level {
    const st = this.settings;
    const l = lv.l;
    const h1 = this.tf.H1;
    const len = h1.length;
    const major = l.source === 'swing' && (majors ?? this.majors()).has(l.id);
    const hl = l.kind === 'high' ? 'High' : 'Low';
    const label = l.source !== 'swing' ? LEVEL_TYPE_LABEL[l.type] : major ? LEVEL_TYPE_LABEL[l.type] : l.touches >= 2 ? `Equal ${hl}s` : `Swing ${hl}`;
    let reaction = 0;
    let freshness = 0;
    if (len) {
      const now = h1.bars[len - 1]!.time;
      const span = Math.max(1, now - h1.bars[Math.max(0, len - st.zoneSwings)]!.time);
      freshness = c01(1 - (now - l.formedAt) / span);
      const from = h1.firstFrom(l.validFrom);
      if (from >= 0) {
        const a = h1.atrAt(Math.min(from, len - 1)) ?? 0;
        let best = 0;
        for (let i = from + 1; i <= Math.min(len - 1, from + st.reactionBars); i++) best = Math.max(best, l.kind === 'high' ? l.price - h1.bars[i]!.low : h1.bars[i]!.high - l.price);
        reaction = a ? best / a : 0;
      }
    }
    const parts = {
      kind: major ? KIND_WEIGHT.major : KIND_WEIGHT[l.source],
      touches: c01((l.touches - 1) / 3),
      reaction: c01(reaction / st.reactionNorm),
      freshness,
      untouched: l.state === 'ACTIVE' ? 1 : l.state === 'SWEPT' ? 0.5 : 0,
    };
    const score = RATING_WEIGHTS.kind * parts.kind + RATING_WEIGHTS.touches * parts.touches + RATING_WEIGHTS.reaction * parts.reaction + RATING_WEIGHTS.freshness * parts.freshness + RATING_WEIGHTS.untouched * parts.untouched;
    const rating: LevelRating = { score, label: score >= RATING_BANDS.strong ? 'STRONG' : score >= RATING_BANDS.medium ? 'MEDIUM' : 'WEAK', parts };
    const price = this.lastM15Close();
    const a15 = this.tf.M15.lastAtr();
    const distanceAtr = price !== null && a15 ? Math.abs(price - l.price) / a15 : null;
    return {
      ...clone(l),
      label,
      major,
      rating,
      distance: this.displayPrice === null ? null : l.price - this.displayPrice,
      distanceAtr,
      near: distanceAtr !== null && distanceAtr <= st.nearAtr,
    };
  }

  private scoreOf(rt: SetupRt, frozen: boolean): HLESetupScore {
    const st = this.settings;
    const h4 = directionOf(this.tf.H4, st.minBars.H4, st.dirSwings);
    const h1 = directionOf(this.tf.H1, 60, st.contextSwings);
    let fvg = !!rt.s.confluence?.fvg.length;
    let ob = !!rt.s.confluence?.ob.length;
    if (rt.s.zone && !rt.s.confluence) {
      const len = this.tf.M1.length;
      if (!rt.conf || rt.conf.len !== len) rt.conf = { len, ...this.confluence(rt, len) };
      fvg = rt.conf.fvg.length > 0;
      ob = rt.conf.ob.length > 0;
    }
    return finalizeHLEScore(hleScoreFractions(rt.s, { h4Dir: h4.dir, h1Dir: h1.dir, levelRating: this.levelView(rt.lv, null).rating.score, fvg, ob }), frozen);
  }

  /** Where one direction's walk stands now (handoff §5.1 / §8.3), from tracked setups and the level pool. */
  private candidate(side: Side, levels: Map<string, Level>): Candidate {
    const st = this.settings;
    const m15 = this.tf.M15;
    const price = this.lastM15Close();
    const a15 = this.tf.M15.lastAtr();
    const buy = side === 'BUY';
    const dAtr = (p: number) => (price !== null && a15 ? Math.abs(price - p) / a15 : null);
    const list: Candidate[] = [];
    for (const rt of this.setups) {
      const s = rt.s;
      if (s.side !== side) continue;
      const since = m15.length - 1 - rt.sIdx;
      const open = OPEN.includes(s.state);
      // A consumed level leaves the pool entirely (handoff §5.1); other dead walks stay visible while their sweep is recent.
      const visible = s.state === 'INVALIDATED' && s.code !== 'LEVEL_CONSUMED' && (s.code === 'LEVEL_BROKEN' ? since <= st.brokenVisibleBars : since <= st.sweepWindow);
      if (!open && !visible) continue;
      list.push({ side, stage: s.stage, invalidated: !open, code: s.code, why: this.whyOf(s), levelId: s.levelId, setupId: s.id, distanceAtr: dAtr(s.level) });
    }
    for (const lv of this.levels) {
      const l = lv.l;
      if (l.side !== side || l.retiredAt !== null || lv.setup || l.state === 'CONSUMED' || price === null || !a15) continue;
      if (!(lv.fP < lv.sign * price + a15)) continue;
      const view = levels.get(l.id);
      const name = view?.label ?? LEVEL_TYPE_LABEL[l.type];
      const d = dAtr(l.price);
      if (m15.firstFrom(l.validFrom) < 0) {
        list.push({ side, stage: 0, invalidated: false, code: 'NOT_AT_LEVEL', why: `${name} at ${l.price} became valid at ${hhmm(l.validFrom)} UTC; no M15 candle has opened since.`, levelId: l.id, setupId: null, distanceAtr: d });
        continue;
      }
      if (d !== null && d <= st.nearAtr)
        list.push({
          side,
          stage: 1,
          invalidated: false,
          code: 'WAITING_SWEEP',
          why: l.touchedAt !== null ? `Price is at ${name} but the ${buy ? 'sell' : 'buy'}-side liquidity ${buy ? 'below' : 'above'} it has not been taken yet.` : `Price is within ${d.toFixed(2)} ATR of ${name} but has not reached it yet.`,
          levelId: l.id,
          setupId: null,
          distanceAtr: d,
        });
      else list.push({ side, stage: 0, invalidated: false, code: 'TOO_FAR', why: `Nearest ${buy ? 'low' : 'high'}-side setup is too far away (${(d ?? 0).toFixed(2)} ATR). Watching needs ${st.nearAtr.toFixed(1)} ATR or closer.`, levelId: l.id, setupId: null, distanceAtr: d });
    }
    const rank = (c: Candidate) => (c.invalidated ? c.stage - 0.5 : c.stage);
    const best = list.sort((a, b) => rank(b) - rank(a) || (a.distanceAtr ?? Infinity) - (b.distanceAtr ?? Infinity) || ((a.setupId ?? a.levelId ?? '') < (b.setupId ?? b.levelId ?? '') ? -1 : 1))[0];
    return best ?? { side, stage: 0, invalidated: false, code: 'NO_LEVEL', why: `No un-broken important ${buy ? 'low below' : 'high above'} price to work from.`, levelId: null, setupId: null, distanceAtr: null };
  }

  private whyOf(s: Setup): string {
    const buy = s.side === 'BUY';
    switch (s.code) {
      case 'WAITING_RECLAIM':
        return `${buy ? 'SSL' : 'BSL'} taken at ${s.levelLabel}; waiting for an M15 close back ${buy ? 'above' : 'below'} ${s.level} (within ${this.settings.reclaimWindow} M15 candles).`;
      case 'WAITING_STRUCTURE':
        return `The sweep is confirmed. Waiting for a closed M5 ${buy ? 'bullish' : 'bearish'} CHOCH / BOS.`;
      case 'WAITING_PULLBACK':
        return `M5 ${s.m5!.kind} confirmed. Waiting for an M1 pullback into ${s.zone!.low} – ${s.zone!.high}.`;
      case 'NONE':
        return 'Every mandatory condition passed.';
      default:
        return s.history[s.history.length - 1]!.reason;
    }
  }

  /** Live internal records WITHOUT copying — read-only, for the anti-repaint audit. */
  inspect(): { knowledgeTime: number | null; setups: readonly Setup[]; levels: readonly Level[]; events: readonly HLEEvent[] } {
    return { knowledgeTime: this.K, setups: this.setups.map((r) => r.s), levels: this.levels.map((x) => x.l), events: this.events };
  }

  snapshot(): HLESnapshot {
    const st = this.settings;
    const timeframes = {} as Record<HLETimeframe, HLETfStatus>;
    let reason: string | null = null;
    for (const t of HLE_TIMEFRAMES) {
      const s = this.tf[t];
      const n = s.length;
      timeframes[t] = { state: n === 0 ? 'NO_DATA' : n < st.minBars[t] ? 'INSUFFICIENT_HISTORY' : 'READY', bars: n, required: st.minBars[t], lastClosedTime: n ? s.bars[n - 1]!.time : null, atr: s.lastAtr(), rejected: this.rejected[t] };
      if (!reason && n < st.minBars[t]) reason = `need ${st.minBars[t]} closed ${t} candles, have ${n}`;
    }
    const states = HLE_TIMEFRAMES.map((t) => timeframes[t].state);
    const majors = this.majors();
    const finished = this.setups.filter((r) => !OPEN.includes(r.s.state)).sort((a, b) => b.s.lastUpdate - a.s.lastUpdate || (a.s.id < b.s.id ? -1 : 1));
    const keep = new Set([...this.setups.filter((r) => OPEN.includes(r.s.state)), ...finished.slice(0, st.maxFinishedSetups)]);
    const kept = this.setups.filter((r) => keep.has(r));
    const keptLevels = new Set(kept.map((r) => r.lv.l.id));
    const levelViews = new Map<string, Level>();
    for (const lv of this.levels) if (lv.l.retiredAt === null || keptLevels.has(lv.l.id)) levelViews.set(lv.l.id, this.levelView(lv, majors));
    const setups = kept.map((r) => {
      const s = clone(r.s);
      s.levelLabel = levelViews.get(s.levelId)?.label ?? s.levelLabel;
      s.distance = this.displayPrice === null ? null : this.displayPrice - s.level;
      if (!s.score.frozen) s.score = this.scoreOf(r, false);
      return s;
    });
    const BUY = this.candidate('BUY', levelViews);
    const SELL = this.candidate('SELL', levelViews);
    const rank = (c: Candidate) => (c.invalidated ? c.stage - 0.5 : c.stage);
    const res = rank(BUY) !== rank(SELL) ? (rank(BUY) > rank(SELL) ? BUY : SELL) : (BUY.distanceAtr ?? Infinity) <= (SELL.distanceAtr ?? Infinity) ? BUY : SELL;
    return {
      instrumentId: this.instrumentId,
      state: states.every((x) => x === 'READY') ? 'READY' : states.every((x) => x === 'NO_DATA') ? 'NO_DATA' : 'INSUFFICIENT_HISTORY',
      reason,
      knowledgeTime: this.K,
      price: this.lastM15Close(),
      displayPrice: this.displayPrice,
      atr15: this.tf.M15.lastAtr(),
      timeframes,
      h4: directionOf(this.tf.H4, st.minBars.H4, st.dirSwings),
      h1: directionOf(this.tf.H1, 60, st.contextSwings),
      levels: [...levelViews.values()],
      setups,
      candidates: { BUY, SELL },
      pick: res.stage > 0 || res.invalidated ? res.side : null,
      events: clone(this.events.slice(-st.maxEvents)),
      settingsKey: hleSettingsKey(st),
    };
  }
}

type HLESetupScore = Setup['score'];

export function analyzeHighLow(o: HLEEngineOptions & { candles: HLEInput; currentPrice?: number | null }): HLESnapshot {
  const e = new HighLowEngine(o);
  e.update(o.candles, o.currentPrice === undefined ? {} : { currentPrice: o.currentPrice });
  return e.snapshot();
}
