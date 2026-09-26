import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { ANALYSIS_TF, DEFAULT_VP_SETTINGS, MTF_LOOKBACK, MTF_TFS, RES_INTRADAY, RES_WEEKLY, VP_TF_SECONDS, VP_TIMEFRAMES, type VPSettings } from './config';
import { accumulate, rowSize, rowsOf, valueArea } from './histogram';
import { acceptance, locate, nodeStates, profileState } from './location';
import { nextTradingDayStart, nextWeekStart, previousTradingDayStart, sessionsAt, tradingDayStart, weekStart } from './periods';
import { buildProfile } from './profile';
import type { KeyLevel, MtfRow, NodeState, ProfileKind, VPEvent, VPSnapshot, VolumeNode, VolumeProfile, VolumeSource } from './types';
import { chooseVolume, type InstrumentVolumeContext } from './volume';

/* ============================================================================
 * VOLUME PROFILE ENGINE — pure and deterministic over CLOSED candles. Every profile is a function
 * of the bars that closed by the knowledge time K, so incremental updates equal a clean
 * recomputation at every K (audited in antiRepaint.ts). Event history comes from candle-by-candle
 * folds (M5 for the developing daily POC, M15 for value interactions), never from a later view.
 * Revised closed candles: ACCEPT + LOG — the timeframe is rebuilt and the revision is reported.
 * ========================================================================== */

export type VPInput = Partial<Record<Timeframe, readonly Candle[]>>;
export interface VPEngineOptions {
  instrumentId: InstrumentId;
  tickSize: number;
  /** Instrument kind / exchange — decides whether exchange volume can exist (e.g. GC on COMEX). */
  instrument: InstrumentVolumeContext;
  settings?: VPSettings;
}
export interface VPUpdateResult {
  rebuilt: Timeframe[];
  revised: { tf: Timeframe; time: number }[];
}

const same = (a: Candle | undefined, b: Candle | undefined) => !!a && !!b && a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume && a.tickVolume === b.tickVolume && a.realVolume === b.realVolume;
const MAX_EVENTS = 1000;
const f5 = (x: number) => Number(x.toFixed(6)).toString();

export function wilderAtr(bars: readonly Candle[], p: number): number | null {
  if (bars.length < p) return null;
  let atr = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const pr = bars[i - 1];
    const tr = pr ? Math.max(b.high - b.low, Math.abs(b.high - pr.close), Math.abs(b.low - pr.close)) : b.high - b.low;
    if (i < p) atr += tr / p;
    else atr = (atr * (p - 1) + tr) / p;
  }
  return atr;
}

interface FoldA {
  cursor: number;
  day: number | null;
  size: number;
  hist: Map<number, number>;
  lastPocIndex: number | null;
  dayBars: Candle[];
}
interface FoldB {
  cursor: number;
  day: number | null;
  testedVah: boolean;
  testedVal: boolean;
  rejectedVah: boolean;
  inside: boolean | null;
  prevClose: number | null;
}

export class VolumeProfileEngine {
  readonly instrumentId: InstrumentId;
  readonly settings: VPSettings;
  private readonly tick: number;
  private readonly ctx: InstrumentVolumeContext;
  private bars: Record<Timeframe, Candle[]> = { M1: [], M5: [], M15: [], M30: [], H1: [], H4: [], D1: [] };
  private inputs: Record<Timeframe, Candle[]> = { M1: [], M5: [], M15: [], M30: [], H1: [], H4: [], D1: [] };
  private price: number | null = null;
  private events: VPEvent[] = [];
  private a!: FoldA;
  private b!: FoldB;
  private refCache = new Map<number, VolumeProfile>();

  constructor(o: VPEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.tick = o.tickSize;
    this.ctx = o.instrument;
    this.settings = o.settings ?? { ...DEFAULT_VP_SETTINGS };
    this.resetFolds();
  }

  private resetFolds(): void {
    this.events = [];
    this.refCache = new Map();
    this.a = { cursor: 0, day: null, size: 0, hist: new Map(), lastPocIndex: null, dayBars: [] };
    this.b = { cursor: 0, day: null, testedVah: false, testedVal: false, rejectedVah: false, inside: null, prevClose: null };
  }

  update(input: VPInput, o: { currentPrice?: number | null } = {}): VPUpdateResult {
    const res: VPUpdateResult = { rebuilt: [], revised: [] };
    let rebuild = false;
    for (const tf of VP_TIMEFRAMES) {
      const next = input[tf] ?? [];
      const prev = this.inputs[tf];
      let ok = next.length >= prev.length;
      for (let j = 0; ok && j < prev.length; j++) if (prev[j] !== next[j] && !same(prev[j], next[j])) ok = false;
      if (!ok) {
        const byTime = new Map(next.map((c) => [c.time, c]));
        for (const c of prev) {
          const n = byTime.get(c.time);
          if (n && !same(n, c)) res.revised.push({ tf, time: c.time });
        }
        res.rebuilt.push(tf);
        this.inputs[tf] = [];
        this.bars[tf] = [];
        rebuild = true;
      }
      for (let j = this.inputs[tf].length; j < next.length; j++) {
        const c = next[j]!;
        this.inputs[tf].push(c);
        const last = this.bars[tf][this.bars[tf].length - 1];
        if (!last || c.time > last.time) this.bars[tf].push(c); // duplicate / out-of-order bars are never processed
      }
    }
    if (rebuild) this.resetFolds();
    this.runFolds();
    const low = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
    const lastClose = low.map((tf) => this.bars[tf][this.bars[tf].length - 1]?.close).find((x) => x !== undefined) ?? null;
    this.price = o.currentPrice !== undefined && o.currentPrice !== null ? o.currentPrice : lastClose;
    return res;
  }

  /** Knowledge time: the latest close among all loaded timeframes. */
  knowledgeTime(): number | null {
    let k: number | null = null;
    for (const tf of VP_TIMEFRAMES) {
      const b = this.bars[tf][this.bars[tf].length - 1];
      if (b && (k === null || b.time + VP_TF_SECONDS[tf] > k)) k = b.time + VP_TF_SECONDS[tf];
    }
    return k;
  }

  private emit(type: VPEvent['type'], time: number, key: string, price: number | null, profile: string, message: string): void {
    this.events.push({ id: `${this.instrumentId}:${type}:${key}`, time, instrumentId: this.instrumentId, type, price, profile, message });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  private dayProfile(dayStart: number, K: number, kind: ProfileKind, label: string): VolumeProfile {
    return buildProfile({ instrumentId: this.instrumentId, kind, label, id: `${this.instrumentId}:${kind}:${dayStart}`, resolution: RES_INTRADAY, bars: this.bars[RES_INTRADAY], from: dayStart, to: nextTradingDayStart(dayStart), K, bp: this.settings.rowBpIntraday, tick: this.tick, ctx: this.ctx, settings: this.settings, datasetStart: this.bars[RES_INTRADAY][0]?.time ?? null });
  }

  /** The completed trading day before `dayStart` that has bars (weekends / holidays skipped, ≤ 5 back). */
  private referenceDay(dayStart: number): VolumeProfile | undefined {
    const cached = this.refCache.get(dayStart);
    if (cached) return cached;
    let d = previousTradingDayStart(dayStart);
    for (let k = 0; k < 5; k++) {
      const p = this.dayProfile(d, dayStart, 'PREVIOUS_DAY', 'Previous Day');
      if (p.bars) {
        this.refCache.set(dayStart, p);
        return p;
      }
      d = previousTradingDayStart(d);
    }
    return undefined;
  }

  /* ---------------------------------- folds ---------------------------------- */

  private runFolds(): void {
    const s = this.settings;
    const m5 = this.bars[RES_INTRADAY];
    const tf5 = VP_TF_SECONDS[RES_INTRADAY];
    // Fold A — developing daily profile, bar by bar (M5).
    for (; this.a.cursor < m5.length; this.a.cursor++) {
      const bar = m5[this.a.cursor]!;
      const day = tradingDayStart(bar.time);
      if (day !== this.a.day) {
        if (this.a.day !== null && this.a.dayBars.length) {
          const done = this.dayProfile(this.a.day, nextTradingDayStart(this.a.day), 'PREVIOUS_DAY', 'Day');
          for (const n of [...done.hvn, ...done.lvn]) this.emit(n.type === 'HVN' ? 'HVN CREATED' : 'LVN CREATED', done.lastBarClose ?? nextTradingDayStart(this.a.day), n.id, n.price, `Day ${this.a.day}`, `${n.type} ${f5(n.low)}–${f5(n.high)} (${n.strengthLabel}) confirmed when the trading day completed.`);
        }
        this.a = { cursor: this.a.cursor, day, size: rowSize(bar.open, s.rowBpIntraday, this.tick), hist: new Map(), lastPocIndex: null, dayBars: [] };
      }
      this.a.dayBars.push(bar);
      const { vol } = chooseVolume(this.a.dayBars, this.ctx);
      // Rebuild from the day's bars so the volume type stays consistent across the day (never mixed).
      const hist = new Map<number, number>();
      for (const b of this.a.dayBars) {
        const v = vol(b);
        if (v !== null) accumulate(hist, b, v, this.a.size);
      }
      this.a.hist = hist;
      const rows = rowsOf(hist, this.a.size);
      const va = valueArea(rows, this.a.size, s.valueAreaPct);
      if (!va) continue;
      const pocIndex = Math.round((va.poc - this.a.size / 2) / this.a.size);
      const t = bar.time + tf5;
      if (this.a.lastPocIndex === null) this.emit('NEW POC', t, `${day}`, va.poc, 'Daily', `New trading day — first POC ${f5(va.poc)}.`);
      else if (Math.abs(pocIndex - this.a.lastPocIndex) >= s.pocShiftRows) this.emit('POC SHIFTED', t, `${day}:${bar.time}`, va.poc, 'Daily', `Developing daily POC moved to ${f5(va.poc)} (${pocIndex > this.a.lastPocIndex ? 'up' : 'down'} ${Math.abs(pocIndex - this.a.lastPocIndex)} rows).`);
      if (this.a.lastPocIndex === null || Math.abs(pocIndex - this.a.lastPocIndex) >= s.pocShiftRows) this.a.lastPocIndex = pocIndex;
    }
    // Fold B — value interactions of the analysis timeframe against the previous day's value.
    const m15 = this.bars[ANALYSIS_TF];
    const tfA = VP_TF_SECONDS[ANALYSIS_TF];
    const m5Close = m5.length ? m5[m5.length - 1]!.time + tf5 : -Infinity;
    for (; this.b.cursor < m15.length; this.b.cursor++) {
      const bar = m15[this.b.cursor]!;
      const t = bar.time + tfA;
      if (t > m5Close) break; // the intraday resolution must cover this bar before it is judged (deterministic)
      const day = tradingDayStart(bar.time);
      if (day !== this.b.day) this.b = { cursor: this.b.cursor, day, testedVah: false, testedVal: false, rejectedVah: false, inside: null, prevClose: null };
      const ref = this.referenceDay(day);
      if (!ref || ref.vah === null || ref.val === null) continue;
      const { vah, val } = ref;
      const k = `${day}:${bar.time}`;
      if (!this.b.testedVah && bar.high >= vah && bar.low <= vah) {
        this.b.testedVah = true;
        this.emit('VAH TESTED', t, k, vah, ref.label, `Previous-day VAH ${f5(vah)} tested.`);
      }
      if (!this.b.testedVal && bar.high >= val && bar.low <= val) {
        this.b.testedVal = true;
        this.emit('VAL TESTED', t, k, val, ref.label, `Previous-day VAL ${f5(val)} tested.`);
      }
      if (!this.b.rejectedVah && bar.high > vah && bar.close <= vah) {
        this.b.rejectedVah = true;
        this.emit('VAH REJECTED', t, k, vah, ref.label, `Traded above VAH ${f5(vah)} to ${f5(bar.high)}, closed back inside at ${f5(bar.close)}.`);
      }
      if (this.b.prevClose !== null && this.b.prevClose < val && bar.close >= val) this.emit('VAL RECLAIMED', t, k, val, ref.label, `Closed back above VAL ${f5(val)} at ${f5(bar.close)}.`);
      const inside = bar.close >= val && bar.close <= vah;
      if (this.b.inside === true && !inside) this.emit('VALUE BREAK', t, k, bar.close, ref.label, `Closed outside previous-day value (${f5(val)}–${f5(vah)}) at ${f5(bar.close)}.`);
      if (this.b.inside === false && inside) this.emit('VALUE RE-ENTRY', t, k, bar.close, ref.label, `Closed back inside previous-day value at ${f5(bar.close)}.`);
      this.b.inside = inside;
      this.b.prevClose = bar.close;
    }
  }

  /* -------------------------------- snapshot -------------------------------- */

  snapshot(): VPSnapshot {
    const s = this.settings;
    const K = this.knowledgeTime();
    const empty: VolumeSource = { mode: 'NONE', label: 'VOLUME DATA UNAVAILABLE', detail: 'No closed candles.', usedBars: 0, missingBars: 0 };
    const unavailableMsg = this.ctx.kind === 'future' ? `${this.instrumentId} VOLUME DATA UNAVAILABLE` : 'VOLUME DATA UNAVAILABLE';
    if (K === null)
      return { instrumentId: this.instrumentId, knowledgeTime: null, price: this.price, atr: null, source: empty, unavailable: unavailableMsg, profiles: {}, sessionName: null, location: null, acceptance: null, sessionAcceptance: null, profileState: 'NO DATA', nodes: [], mtf: MTF_TFS.map((tf) => ({ timeframe: tf, available: false, bars: 0, poc: null, vah: null, val: null, location: null, nearestHvn: null, nearestLvn: null, context: 'no data', source: empty })), keyLevels: [], events: [], settingsKey: JSON.stringify(s) };
    const tfA = VP_TF_SECONDS[ANALYSIS_TF];
    const analysis = this.bars[ANALYSIS_TF].filter((b) => b.time + tfA <= K);
    const atr = wilderAtr(analysis, s.atrPeriod);
    const mk = (kind: ProfileKind, label: string, from: number, to: number, res: Timeframe, bp: number, suffix = `${from}`) =>
      buildProfile({ instrumentId: this.instrumentId, kind, label, id: `${this.instrumentId}:${kind}:${suffix}`, resolution: res, bars: this.bars[res], from, to, K, bp, tick: this.tick, ctx: this.ctx, settings: s, datasetStart: this.bars[res][0]?.time ?? null });
    const profiles: Partial<Record<ProfileKind, VolumeProfile>> = {};
    const day = tradingDayStart(K - 1);
    profiles.DAILY = mk('DAILY', 'Daily (developing)', day, nextTradingDayStart(day), RES_INTRADAY, s.rowBpIntraday);
    const pd = this.referenceDay(day);
    if (pd) profiles.PREVIOUS_DAY = pd;
    const wk = weekStart(K - 1);
    profiles.WEEKLY = mk('WEEKLY', 'Weekly (developing)', wk, nextWeekStart(wk), RES_WEEKLY, s.rowBpWeekly);
    let pw = weekStart(wk - 1);
    for (let k = 0; k < 3; k++) {
      const p = mk('PREVIOUS_WEEK', 'Previous Week', pw, nextWeekStart(pw), RES_WEEKLY, s.rowBpWeekly);
      if (p.bars) {
        profiles.PREVIOUS_WEEK = p;
        break;
      }
      pw = weekStart(pw - 1);
    }
    const ses = sessionsAt(K);
    if (ses.current) profiles.CURRENT_SESSION = mk('CURRENT_SESSION', `${ses.current.name} (${K < ses.current.to ? 'active' : 'ended'})`, ses.current.from, ses.current.to, RES_INTRADAY, s.rowBpIntraday, `${ses.current.id}:${ses.current.from}`);
    if (ses.previous) profiles.PREVIOUS_SESSION = mk('PREVIOUS_SESSION', `${ses.previous.name} (previous)`, ses.previous.from, ses.previous.to, RES_INTRADAY, s.rowBpIntraday, `${ses.previous.id}:${ses.previous.from}`);
    const sk: [ProfileKind, 'asia' | 'london' | 'new-york'][] = [['ASIA', 'asia'], ['LONDON', 'london'], ['NEW_YORK', 'new-york']];
    for (const [kind, id] of sk) {
      const w = ses.latest[id];
      if (w) profiles[kind] = mk(kind, w.name, w.from, w.to, RES_INTRADAY, s.rowBpIntraday, `${id}:${w.from}`);
    }
    const headline = profiles.CURRENT_SESSION ?? profiles.DAILY;
    const price = this.price;
    const location = price !== null && headline ? locate(price, headline, atr, s) : null;
    const acc = acceptance(profiles.PREVIOUS_DAY, analysis, atr, s, tfA);
    const sesAcc = acceptance(profiles.PREVIOUS_SESSION, analysis, atr, s, tfA);
    // Nodes: completed profiles (with states) + developing daily / current-session nodes.
    const priceAt = (p: VolumeProfile | undefined) => {
      if (!p?.lastBarClose) return null;
      const bar = [...this.bars[RES_INTRADAY]].reverse().find((b) => b.time + VP_TF_SECONDS[RES_INTRADAY] <= p.lastBarClose!);
      return bar?.close ?? null;
    };
    const nodes: VolumeNode[] = [];
    for (const p of [profiles.PREVIOUS_DAY, profiles.PREVIOUS_SESSION, profiles.PREVIOUS_WEEK]) if (p) nodes.push(...nodeStates([...p.hvn, ...p.lvn], analysis, priceAt(p), K, s, tfA));
    for (const p of [profiles.DAILY, profiles.CURRENT_SESSION]) if (p) nodes.push(...p.hvn, ...p.lvn);
    // MTF: every timeframe's own profile over its last N closed bars (independent).
    const mtf: MtfRow[] = MTF_TFS.map((tf) => {
      const tfs = VP_TF_SECONDS[tf];
      const all = this.bars[tf].filter((b) => b.time + tfs <= K);
      const n = MTF_LOOKBACK[tf]!;
      const bars = all.slice(-n);
      if (!bars.length) return { timeframe: tf, available: false, bars: 0, poc: null, vah: null, val: null, location: null, nearestHvn: null, nearestLvn: null, context: 'INSUFFICIENT DATA', source: empty };
      const from = bars[0]!.time;
      const p = buildProfile({ instrumentId: this.instrumentId, kind: 'TF', label: `${tf} last ${bars.length}`, id: `${this.instrumentId}:TF:${tf}:${from}`, resolution: tf, bars, from, to: bars[bars.length - 1]!.time + tfs, K, bp: tf === 'D1' || tf === 'H4' ? s.rowBpHtf : tf === 'H1' || tf === 'M30' ? s.rowBpWeekly : s.rowBpIntraday, tick: this.tick, ctx: this.ctx, settings: s, datasetStart: null });
      const loc = price !== null ? locate(price, p, atr, s) : null;
      const near = (xs: VolumeNode[]) => (price === null || !xs.length ? null : [...xs].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0]!.price);
      const enough = bars.length >= Math.min(n, 10) && p.poc !== null;
      return {
        timeframe: tf,
        available: enough,
        bars: bars.length,
        poc: p.poc,
        vah: p.vah,
        val: p.val,
        location: enough ? (loc?.location ?? null) : null,
        nearestHvn: near(p.hvn),
        nearestLvn: near(p.lvn),
        context: !enough ? 'INSUFFICIENT DATA' : !loc ? '—' : loc.location === 'ABOVE VALUE' || loc.location === 'BELOW VALUE' ? `outside value (${loc.location.toLowerCase()})` : loc.location === 'NEAR POC' ? 'balanced at POC' : 'inside value',
        source: p.source,
      };
    });
    const keyLevels = rankLevels(profiles, nodes, price, atr);
    return {
      instrumentId: this.instrumentId,
      knowledgeTime: K,
      price,
      atr,
      source: headline?.source ?? empty,
      unavailable: !headline || headline.source.mode === 'NONE' ? unavailableMsg : null,
      profiles,
      sessionName: ses.current ? ses.current.name : null,
      location,
      acceptance: acc,
      sessionAcceptance: sesAcc,
      profileState: profileState(acc),
      nodes,
      mtf,
      keyLevels,
      // Deterministic order (time, then id) — independent of how updates were batched.
      events: this.events.filter((e) => e.time <= K).map((e) => ({ ...e })).sort((x, y) => x.time - y.time || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
      settingsKey: JSON.stringify(s),
    };
  }

  /** Visible / fixed range profile on demand (pure; chart timeframe bars in [from, to)). */
  rangeProfile(tf: Timeframe, from: number, to: number, label: string): VolumeProfile {
    const K = this.knowledgeTime() ?? 0;
    return buildProfile({ instrumentId: this.instrumentId, kind: 'RANGE', label, id: `${this.instrumentId}:RANGE:${tf}:${from}:${to}`, resolution: tf, bars: this.bars[tf], from, to, K, bp: tf === 'D1' || tf === 'H4' ? this.settings.rowBpHtf : tf === 'H1' || tf === 'M30' ? this.settings.rowBpWeekly : this.settings.rowBpIntraday, tick: this.tick, ctx: this.ctx, settings: this.settings, datasetStart: this.bars[tf][0]?.time ?? null });
  }
}

/*
 * KEY LEVELS (ranked, not trades): importance = profile weight × level weight × freshness × 100.
 *   profile: Previous Week 1.0 · Weekly 0.9 · Previous Day 0.9 · Daily 0.7 · Previous Session 0.7 · Current Session 0.6
 *   level:   POC 1.0 · VAH / VAL 0.85 · HVN 0.3 + 0.7 × strength · LVN 0.2 + 0.6 × strength
 *   freshness: ACTIVE / level 1.0 · TESTED 0.8 · BROKEN 0.4 · EXPIRED 0.2
 */
const PROFILE_WEIGHT: Partial<Record<ProfileKind, number>> = { PREVIOUS_WEEK: 1, WEEKLY: 0.9, PREVIOUS_DAY: 0.9, DAILY: 0.7, PREVIOUS_SESSION: 0.7, CURRENT_SESSION: 0.6 };
const FRESH: Record<NodeState | 'LEVEL', number> = { ACTIVE: 1, LEVEL: 1, TESTED: 0.8, BROKEN: 0.4, EXPIRED: 0.2 };
export function rankLevels(profiles: Partial<Record<ProfileKind, VolumeProfile>>, nodes: readonly VolumeNode[], price: number | null, atr: number | null): KeyLevel[] {
  const out: KeyLevel[] = [];
  for (const [kind, w] of Object.entries(PROFILE_WEIGHT) as [ProfileKind, number][]) {
    const p = profiles[kind];
    if (!p || p.poc === null) continue;
    for (const [k, lw, v] of [['POC', 1, p.poc], ['VAH', 0.85, p.vah], ['VAL', 0.85, p.val]] as const) {
      if (v === null) continue;
      out.push({ id: `${p.id}:${k}`, label: `${p.label} ${k}`, kind: k, price: v, profileId: p.id, profileLabel: p.label, importance: Math.round(w * lw * 100), distanceAtr: price !== null && atr ? (v - price) / atr : null, state: 'LEVEL' });
    }
  }
  for (const n of nodes) {
    const w = PROFILE_WEIGHT[n.profileKind] ?? 0.5;
    const lw = n.type === 'HVN' ? 0.3 + 0.7 * n.strength : 0.2 + 0.6 * n.strength;
    out.push({ id: n.id, label: `${n.type} (${n.profileKind.replace(/_/g, ' ').toLowerCase()})`, kind: n.type, price: n.price, profileId: n.profileId, profileLabel: n.profileKind, importance: Math.round(w * lw * FRESH[n.state] * 100), distanceAtr: price !== null && atr ? (n.price - price) / atr : null, state: n.state });
  }
  return out.sort((a, b) => b.importance - a.importance || a.price - b.price || (a.id < b.id ? -1 : 1)).slice(0, 16);
}

export function analyzeVolumeProfile(o: VPEngineOptions & { candles: VPInput; currentPrice?: number | null }): VPSnapshot {
  const e = new VolumeProfileEngine(o);
  e.update(o.candles, { currentPrice: o.currentPrice });
  return e.snapshot();
}
