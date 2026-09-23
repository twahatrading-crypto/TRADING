import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { finalizeScore, scoreComponents } from './scoring';
import { DEFAULT_SR_SETTINGS, settingsKey, TIMEFRAME_SECONDS, type SRSettings } from './settings';
import { assertTransition, isHolding } from './stateMachine';
import type {
  BreakEvidence,
  DataGap,
  Interaction,
  Pivot,
  RoleChange,
  SRSnapshot,
  SRZone,
  SRZoneDefinition,
  SRZoneType,
  StatusChange,
  ZoneStatus,
} from './types';

/* ============================================================================
 * Support & Resistance engine — one instrument, one timeframe.
 *
 * Pure and deterministic. Candles in, snapshot out. No React, no I/O.
 *
 * Only CLOSED bars are analysed. By default the newest candle is treated as
 * still forming and is used for the current price only, so a pivot/zone can
 * never be derived from an unfinished bar.
 *
 * All price logic is written once in a "support frame": for resistance
 * (and for retests of a broken support), prices are negated so that the
 * zone's facing edge is always above its far edge and price approaches from
 * above. This guarantees support and resistance follow identical rules.
 * ========================================================================== */

interface Frame {
  role: SRZoneType;
  /** +1 support, −1 resistance */
  s: 1 | -1;
}

const frameOf = (role: SRZoneType): Frame => ({ role, s: role === 'support' ? 1 : -1 });
const opposite = (r: SRZoneType): SRZoneType => (r === 'support' ? 'resistance' : 'support');

interface Episode {
  interaction: Interaction;
  frame: Frame;
  open: boolean;
  startIndex: number;
  extremeIndex: number;
  /** Frame-space extreme (lowest low in frame). */
  extreme: number;
  windowEnd: number;
  sweepWick: { index: number; depth: number } | null;
  /** A close went beyond the break threshold: this episode can no longer be a pure sweep. */
  sweepVoid: boolean;
  /** Consecutive closes beyond the far edge (for break confirmation). */
  beyondRun: { time: number; close: number }[];
  wasBeyond: boolean;
}

interface ZoneRuntime {
  def: SRZoneDefinition;
  role: SRZoneType;
  status: ZoneStatus;
  statusHistory: StatusChange[];
  roleHistory: RoleChange[];
  pivotIds: string[];
  formationExcursionsAtr: number[];
  prominenceAtr: number;
  interactions: Interaction[];
  episode: Episode | null;
  weakened: boolean;
  brokenAt: number | null;
  breakEvidence: BreakEvidence | null;
  flippedAt: number | null;
  /** After a break: armed once price has moved away on the new side; only then can a retest count. */
  retest: { deadlineIndex: number; cancelled: boolean; armed: boolean } | null;
  lastInteractionIndex: number | null;
  seq: number;
}

export interface SREngineOptions {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  /** Instrument tick size (absolute zone-width floor). */
  tickSize: number;
  settings?: SRSettings;
}

export interface UpdateOptions {
  /** Treat the final candle as closed (closed-only streams, fixtures, replays). Default false. */
  lastBarClosed?: boolean;
  /** Current price for distance calculations (e.g. the forming bar's close). Defaults to the last candle's close. */
  currentPrice?: number | null;
}

const sameBar = (a: Candle, b: Candle) =>
  a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

export class SRTimeframeEngine {
  readonly instrumentId: InstrumentId;
  readonly timeframe: Timeframe;
  readonly settings: SRSettings;
  private readonly tick: number;

  private bars: Candle[] = [];
  private atrs: number[] = [];
  private pivots: Pivot[] = [];
  private zones: ZoneRuntime[] = [];
  private gaps: DataGap[] = [];
  private lastPrice: number | null = null;

  constructor(opts: SREngineOptions) {
    this.instrumentId = opts.instrumentId;
    this.timeframe = opts.timeframe;
    this.settings = opts.settings ?? { ...DEFAULT_SR_SETTINGS };
    this.tick = opts.tickSize > 0 ? opts.tickSize : 0;
  }

  /* --------------------------------- input -------------------------------- */

  /**
   * Feed the full candle history (ascending). Only bars not yet analysed are
   * processed; if already-analysed history changed, the engine rebuilds
   * deterministically from scratch.
   */
  update(candles: readonly Candle[], opts: UpdateOptions = {}): void {
    const closedCount = opts.lastBarClosed ? candles.length : Math.max(0, candles.length - 1);
    let consistent = closedCount >= this.bars.length;
    for (let k = 0; consistent && k < this.bars.length; k++) if (!sameBar(this.bars[k]!, candles[k]!)) consistent = false;
    if (!consistent) this.reset();
    for (let k = this.bars.length; k < closedCount; k++) {
      const c = candles[k]!;
      const prev = this.bars[this.bars.length - 1];
      if (prev && c.time <= prev.time) continue; // defensive: never go backwards in time
      this.processBar(c);
    }
    this.lastPrice = opts.currentPrice !== undefined ? opts.currentPrice : candles.length ? candles[candles.length - 1]!.close : null;
  }

  private reset(): void {
    this.bars = [];
    this.atrs = [];
    this.pivots = [];
    this.zones = [];
    this.gaps = [];
  }

  /* ------------------------------ bar pipeline ----------------------------- */

  private processBar(bar: Candle): void {
    const i = this.bars.length;
    const prev = this.bars[i - 1];
    this.bars.push(bar);

    // Missing-data detection (reported, never filled in).
    if (prev) {
      const tf = TIMEFRAME_SECONDS[this.timeframe];
      const delta = bar.time - prev.time;
      if (delta > tf * this.settings.gapToleranceBars) {
        this.gaps.push({ after: prev.time, before: bar.time, missingBars: Math.round(delta / tf) - 1 });
        if (this.gaps.length > 100) this.gaps.shift();
      }
    }

    // Wilder ATR — uses bars ≤ i only.
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
    } else if (i >= p) {
      atr = (this.atrs[i - 1]! * (p - 1) + tr) / p;
    }
    this.atrs.push(atr);
    if (!(atr > 0)) return;

    // 1) Existing zones react to this bar (zones confirmed on this bar are created after).
    for (const z of this.zones) this.updateZone(z, i);
    // 2) Pivots confirmed by this bar's close.
    this.detectPivots(i);
  }

  /* -------------------------------- pivots -------------------------------- */

  /**
   * Swing low at c: low[c] < low[j] for the pivotLeft bars before, and
   * low[c] ≤ low[j] for the pivotRight bars after. Confirmed on the close of
   * bar c + pivotRight (never earlier). Swing highs mirror this.
   */
  private detectPivots(i: number): void {
    const { pivotLeft: L, pivotRight: R } = this.settings;
    const c = i - R;
    if (c - L < 0) return;
    const atr = this.atrs[i]!;
    const b = this.bars;
    const pc = b[c]!;

    let isLow = true;
    let isHigh = true;
    for (let j = c - L; j < c; j++) {
      if (!(pc.low < b[j]!.low)) isLow = false;
      if (!(pc.high > b[j]!.high)) isHigh = false;
    }
    for (let j = c + 1; j <= c + R; j++) {
      if (!(pc.low <= b[j]!.low)) isLow = false;
      if (!(pc.high >= b[j]!.high)) isHigh = false;
    }

    if (isLow) {
      let legHigh = -Infinity;
      for (let j = c - L; j < c; j++) legHigh = Math.max(legHigh, b[j]!.high);
      let after = -Infinity;
      for (let j = c; j <= i; j++) after = Math.max(after, b[j]!.close);
      this.onPivot({
        id: `${this.instrumentId}:${this.timeframe}:PL:${pc.time}`,
        kind: 'low',
        index: c,
        pivotTime: pc.time,
        price: pc.low,
        confirmedAt: b[i]!.time,
        confirmedIndex: i,
        atr,
        prominenceAtr: (legHigh - pc.low) / atr,
        formationExcursionAtr: (after - pc.low) / atr,
      });
    }
    if (isHigh) {
      let legLow = Infinity;
      for (let j = c - L; j < c; j++) legLow = Math.min(legLow, b[j]!.low);
      let after = Infinity;
      for (let j = c; j <= i; j++) after = Math.min(after, b[j]!.close);
      this.onPivot({
        id: `${this.instrumentId}:${this.timeframe}:PH:${pc.time}`,
        kind: 'high',
        index: c,
        pivotTime: pc.time,
        price: pc.high,
        confirmedAt: b[i]!.time,
        confirmedIndex: i,
        atr,
        prominenceAtr: (pc.high - legLow) / atr,
        formationExcursionAtr: (pc.high - after) / atr,
      });
    }
  }

  /* --------------------------- zones + clustering -------------------------- */

  /**
   * Zone boundaries (frozen at confirmation), support from swing low at bar c:
   *   minW  = max(zoneMinAtr × ATR, minZoneTicks × tick)
   *   wickBody: width = clamp(min(open,close)[c] − low[c], minW, max(minW, zoneMaxAtr × ATR))
   *   atr:      width = max(minW, zoneAtrMultiplier × ATR)
   *   zoneLow = low[c], zoneHigh = low[c] + width
   * Resistance mirrors: zoneHigh = high[c], zoneLow = high[c] − width (body = max(open,close)).
   */
  private zoneBounds(p: Pivot): { low: number; high: number; width: number } {
    const s = this.settings;
    const bar = this.bars[p.index]!;
    const minW = Math.max(s.zoneMinAtr * p.atr, s.minZoneTicks * this.tick);
    let width: number;
    if (s.zoneWidthMethod === 'atr') {
      width = Math.max(minW, s.zoneAtrMultiplier * p.atr);
    } else {
      const raw = p.kind === 'low' ? Math.min(bar.open, bar.close) - bar.low : bar.high - Math.max(bar.open, bar.close);
      width = Math.min(Math.max(raw, minW), Math.max(minW, s.zoneMaxAtr * p.atr));
    }
    return p.kind === 'low' ? { low: bar.low, high: bar.low + width, width } : { low: bar.high - width, high: bar.high, width };
  }

  /**
   * Clustering: a new pivot joins an existing HOLDING zone of the same current
   * role when the gap between the candidate zone and that zone is
   * ≤ clusterToleranceAtr × ATR (overlap = gap 0). The closest by midpoint wins
   * (ties → older zone). The existing zone's frozen boundaries do NOT change;
   * the pivot is recorded as provenance. Otherwise a new zone is created.
   */
  private onPivot(p: Pivot): void {
    this.pivots.push(p);
    const type: SRZoneType = p.kind === 'low' ? 'support' : 'resistance';
    const { low, high, width } = this.zoneBounds(p);
    const mid = (low + high) / 2;
    const tol = this.settings.clusterToleranceAtr * p.atr;

    let target: ZoneRuntime | null = null;
    let best = Infinity;
    for (const z of this.zones) {
      if (z.role !== type || !isHolding(z.status)) continue;
      const gap = Math.max(0, Math.max(low, z.def.zoneLow) - Math.min(high, z.def.zoneHigh));
      if (gap > tol) continue;
      const d = Math.abs(z.def.midPrice - mid);
      if (d < best) {
        best = d;
        target = z;
      }
    }
    if (target) {
      target.pivotIds.push(p.id);
      target.formationExcursionsAtr.push(p.formationExcursionAtr);
      return;
    }

    const def: SRZoneDefinition = Object.freeze({
      id: `${this.instrumentId}:${this.timeframe}:${type === 'support' ? 'S' : 'R'}:${p.pivotTime}`,
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      type,
      zoneLow: low,
      zoneHigh: high,
      midPrice: mid,
      width,
      pivotId: p.id,
      createdAt: p.pivotTime,
      confirmedAt: p.confirmedAt,
      confirmedIndex: p.confirmedIndex,
      atrAtConfirmation: p.atr,
    });
    this.zones.push({
      def,
      role: type,
      status: 'FRESH',
      statusHistory: [{ from: null, to: 'FRESH', time: p.confirmedAt, reason: 'pivot confirmed' }],
      roleHistory: [],
      pivotIds: [p.id],
      formationExcursionsAtr: [p.formationExcursionAtr],
      prominenceAtr: p.prominenceAtr,
      interactions: [],
      episode: null,
      weakened: false,
      brokenAt: null,
      breakEvidence: null,
      flippedAt: null,
      retest: null,
      lastInteractionIndex: null,
      seq: 0,
    });
  }

  /* ----------------------------- zone lifecycle ---------------------------- */

  private setStatus(z: ZoneRuntime, to: ZoneStatus, time: number, reason: string): void {
    if (z.status === to) return;
    assertTransition(z.status, to);
    z.statusHistory.push({ from: z.status, to, time, reason });
    z.status = to;
  }

  private updateZone(z: ZoneRuntime, i: number): void {
    if (z.status === 'EXPIRED' || i <= z.def.confirmedIndex) return;
    const time = this.bars[i]!.time;
    const s = this.settings;

    if (z.status === 'BROKEN') {
      if (z.retest && !z.retest.cancelled && !z.retest.armed) {
        // Arm only after price has separated from the zone on the new side.
        const fr = frameOf(opposite(z.role));
        const bar = this.bars[i]!;
        const lo = fr.s === 1 ? bar.low : -bar.high;
        const F = fr.s === 1 ? z.def.zoneHigh : -z.def.zoneLow;
        if (lo > F + s.touchSeparationAtr * this.atrs[i]!) z.retest.armed = true;
      } else if (z.retest && !z.retest.cancelled) {
        const r = this.stepEpisode(z, i, frameOf(opposite(z.role)), 'retest');
        if (r.brokeNow) {
          // Price went back through: the break failed as a flip candidate.
          z.retest.cancelled = true;
        } else if (z.episode && z.episode.interaction.rejected === true && z.episode.interaction.phase === 'retest') {
          // Flip rule: valid retest from the other side, rejected → role reversal.
          const from = z.role;
          z.role = opposite(z.role);
          z.roleHistory.push({ from, to: z.role, time });
          z.flippedAt = time;
          z.retest = null;
          z.weakened = false;
          this.setStatus(z, 'FLIPPED', time, `retest rejected as ${z.role}`);
          return;
        }
      }
      const open = z.episode?.open ?? false;
      if (z.retest && i > z.retest.deadlineIndex && !open) {
        this.setStatus(z, 'EXPIRED', time, z.retest.cancelled ? 'broken back through; no flip' : 'no valid retest within flip window');
      }
      return;
    }

    // Holding statuses.
    const r = this.stepEpisode(z, i, frameOf(z.role), 'hold');
    if (r.brokeNow) {
      z.brokenAt = time;
      z.breakEvidence = r.evidence;
      z.retest = { deadlineIndex: i + s.flipWindowBars, cancelled: false, armed: false };
      z.weakened = false;
      this.setStatus(z, 'BROKEN', time, `confirmed break (${r.evidence!.rule})`);
      return;
    }

    const open = z.episode?.open ?? false;
    const resolved = z.interactions.filter((x) => x.rejected !== null || x.broke);
    const lastTwo = resolved.slice(-2);
    if (
      resolved.length >= s.weakeningTouches ||
      z.interactions.some((x) => x.closedThrough) ||
      (lastTwo.length === 2 && lastTwo.every((x) => x.rejected === false))
    ) {
      z.weakened = true;
    }

    const idle = i - (z.lastInteractionIndex ?? z.def.confirmedIndex);
    if (!open && idle > s.expiryBars) {
      this.setStatus(z, 'EXPIRED', time, `no interaction for ${s.expiryBars} bars`);
      return;
    }
    if (z.status === 'FLIPPED') return; // stays FLIPPED while holding its new role
    let next: ZoneStatus;
    if (open) next = 'ACTIVE';
    else if (z.weakened) next = 'WEAKENING';
    else next = z.interactions.length > 0 ? 'TESTED' : 'FRESH';
    this.setStatus(z, next, time, open ? 'price interacting' : next === 'WEAKENING' ? 'repeated / failed tests' : 'price left zone');
  }

  /**
   * Interaction episode step, in frame space (support frame).
   *   F = facing edge, L = far edge, W = width, all ATR = ATR of this bar.
   * TOUCH:     an episode starts when low ≤ F + touchToleranceAtr·ATR (not already open)
   *            and ends when low > F + touchSeparationAtr·ATR. One episode = one touch,
   *            however many bars it lasts.
   * REJECTION: within rejectionWindowBars of the episode start, a CLOSE ≥ F +
   *            rejectionMinAtr·ATR(start). Otherwise the touch resolves as not rejected
   *            (also if a new episode starts first). The high-based excursion is
   *            recorded as maxExcursion but does not decide.
   * SWEEP:     a wick below L − sweepMinAtr·ATR followed, within sweepReclaimBars
   *            (same bar allowed), by a close ≥ L, with no close beyond the break
   *            threshold during the episode (otherwise it is a close-through/break).
   * CLOSE-THROUGH: a close < L − breakToleranceAtr·ATR that is followed by a close
   *            back ≥ that threshold before the break confirms.
   * BREAK:     breakConfirmCloses consecutive closes < L − breakToleranceAtr·ATR, OR one
   *            close < L − breakDisplacementAtr·ATR. A wick alone never breaks a zone.
   * FLIP (see updateZone): after a break the zone is re-evaluated in the opposite role.
   *            Once price has moved ≥ touchSeparationAtr·ATR away on the new side (armed),
   *            the next episode that REJECTS (same rejection rule) within flipWindowBars
   *            flips the role. A confirmed break back through cancels the flip.
   */
  private stepEpisode(
    z: ZoneRuntime,
    i: number,
    fr: Frame,
    phase: 'hold' | 'retest',
  ): { brokeNow: boolean; evidence: BreakEvidence | null } {
    const s = this.settings;
    const bar = this.bars[i]!;
    const atr = this.atrs[i]!;
    const lo = fr.s === 1 ? bar.low : -bar.high;
    const hi = fr.s === 1 ? bar.high : -bar.low;
    const cl = fr.s * bar.close;
    const F = fr.s === 1 ? z.def.zoneHigh : -z.def.zoneLow;
    const L = fr.s === 1 ? z.def.zoneLow : -z.def.zoneHigh;
    const W = z.def.width;

    let ep = z.episode;
    if (ep && ep.frame.role !== fr.role) ep = z.episode = null; // role changed (break/flip)

    // A closed episode keeps tracking its rejection window.
    if (ep && !ep.open) {
      this.trackRejection(ep, i, hi, cl, F);
      if (ep.interaction.rejected === null && i > ep.windowEnd) this.resolve(ep, false, bar.time);
    }

    // Start a new episode.
    if (lo <= F + s.touchToleranceAtr * atr && !(ep && ep.open)) {
      if (ep && ep.interaction.rejected === null) this.resolve(ep, false, bar.time);
      z.seq += 1;
      const interaction: Interaction = {
        id: `${z.def.id}#${z.seq}`,
        role: fr.role,
        phase,
        startTime: bar.time,
        endTime: null,
        extremeTime: bar.time,
        extremePrice: fr.s * lo,
        penetration: 0,
        penetrationRatio: 0,
        closeLocation: 0.5,
        swept: false,
        sweepTime: null,
        sweepDepth: 0,
        closedThrough: false,
        broke: false,
        rejected: null,
        rejectionDistance: 0,
        rejectionAtr: 0,
        maxExcursion: 0,
        maxExcursionAtr: 0,
        barsToRejection: null,
        atr,
        outcome: 'pending',
        resolvedTime: null,
      };
      ep = z.episode = {
        interaction,
        frame: fr,
        open: true,
        startIndex: i,
        extremeIndex: i,
        extreme: Infinity,
        windowEnd: i + s.rejectionWindowBars,
        sweepWick: null,
        sweepVoid: false,
        beyondRun: [],
        wasBeyond: false,
      };
      z.interactions.push(interaction);
    }

    if (!ep || !ep.open) return { brokeNow: false, evidence: null };
    const it = ep.interaction;
    z.lastInteractionIndex = i;

    // Deepest point + close location of that bar.
    if (lo < ep.extreme) {
      ep.extreme = lo;
      ep.extremeIndex = i;
      it.extremeTime = bar.time;
      it.extremePrice = fr.s * lo;
      it.closeLocation = hi > lo ? (cl - lo) / (hi - lo) : 0.5;
    }
    it.penetration = Math.max(0, F - ep.extreme);
    it.penetrationRatio = W > 0 ? it.penetration / W : 0;

    // Close-through bookkeeping first (a close beyond voids any sweep).
    const threshold = L - s.breakToleranceAtr * atr;
    if (cl < threshold) {
      ep.beyondRun.push({ time: bar.time, close: bar.close });
      ep.wasBeyond = true;
      ep.sweepVoid = true;
      it.swept = false;
      it.sweepTime = null;
      it.sweepDepth = 0;
    } else {
      if (ep.wasBeyond) it.closedThrough = true;
      ep.beyondRun = [];
      ep.wasBeyond = false;
    }

    // Sweep: wick beyond L − sweepMinAtr·ATR, reclaimed by a close ≥ L within
    // sweepReclaimBars, with no close beyond the break threshold in the episode.
    if (!ep.sweepVoid) {
      if (lo < L - s.sweepMinAtr * atr) {
        if (!ep.sweepWick) ep.sweepWick = { index: i, depth: L - lo };
        else ep.sweepWick.depth = Math.max(ep.sweepWick.depth, L - lo);
      }
      if (ep.sweepWick && !it.swept) {
        if (cl >= L && i - ep.sweepWick.index <= s.sweepReclaimBars) {
          it.swept = true;
          it.sweepTime = this.bars[ep.sweepWick.index]!.time;
          it.sweepDepth = ep.sweepWick.depth;
        } else if (i - ep.sweepWick.index >= s.sweepReclaimBars && cl < L) {
          ep.sweepWick = null; // not reclaimed in time
        }
      }
    }

    const displacement = cl < L - s.breakDisplacementAtr * atr;
    if (ep.beyondRun.length >= s.breakConfirmCloses || displacement) {
      const evidence: BreakEvidence = {
        rule: ep.beyondRun.length >= s.breakConfirmCloses ? 'consecutiveCloses' : 'displacement',
        closeTimes: ep.beyondRun.map((x) => x.time),
        closes: ep.beyondRun.map((x) => x.close),
        threshold: fr.s * threshold,
        atr,
        role: fr.role,
      };
      it.broke = true;
      it.swept = false;
      it.sweepTime = null;
      it.endTime = bar.time;
      // Resolve only if still undecided: a rejection decided earlier keeps its own decision time
      // (the break time is recorded in endTime / breakEvidence). Never rewrite past records.
      if (it.rejected === null) {
        it.rejected = false;
        it.resolvedTime = bar.time;
      }
      it.outcome = 'break';
      z.episode = null;
      return { brokeNow: true, evidence };
    }

    this.trackRejection(ep, i, hi, cl, F);

    // Leave the zone → episode ends (rejection may still resolve inside its window).
    if (lo > F + s.touchSeparationAtr * atr) {
      ep.open = false;
      it.endTime = bar.time;
    }
    it.outcome = outcomeOf(it);
    return { brokeNow: false, evidence: null };
  }

  private trackRejection(ep: Episode, i: number, hi: number, cl: number, F: number): void {
    const it = ep.interaction;
    if (i > ep.windowEnd) return;
    const excursion = hi - F;
    if (excursion > it.maxExcursion) {
      it.maxExcursion = excursion;
      it.maxExcursionAtr = excursion / it.atr;
    }
    if (it.rejected !== null) return;
    const away = cl - F;
    if (away > it.rejectionDistance) {
      it.rejectionDistance = away;
      it.rejectionAtr = away / it.atr;
    }
    if (it.rejectionDistance >= this.settings.rejectionMinAtr * it.atr) {
      it.rejected = true;
      it.barsToRejection = i - ep.extremeIndex;
      it.resolvedTime = this.bars[i]!.time;
      it.outcome = outcomeOf(it);
    }
  }

  private resolve(ep: Episode, rejected: boolean, time: number): void {
    const it = ep.interaction;
    it.rejected = rejected;
    it.resolvedTime = time;
    it.outcome = outcomeOf(it);
  }

  /* -------------------------------- output -------------------------------- */

  snapshot(): SRSnapshot {
    const s = this.settings;
    const n = this.bars.length;
    const last = n - 1;
    const atrNow = n ? this.atrs[last]! : Number.NaN;
    const state = n === 0 ? 'NO_DATA' : n < s.minHistoryBars ? 'INSUFFICIENT_HISTORY' : 'READY';
    const price = this.lastPrice;
    const zones: SRZone[] =
      state !== 'READY'
        ? []
        : this.zones.map((z) => {
            const components = scoreComponents(
              {
                timeframe: this.timeframe,
                status: z.status,
                interactions: z.interactions,
                formationExcursionsAtr: z.formationExcursionsAtr,
                prominenceAtr: z.prominenceAtr,
                sourcePivotCount: z.pivotIds.length,
                barsSinceLastInteraction: last - (z.lastInteractionIndex ?? z.def.confirmedIndex),
                confluence: 0,
              },
              s,
            );
            const distance = price === null ? null : z.def.midPrice - price;
            const inside = price !== null && price >= z.def.zoneLow && price <= z.def.zoneHigh;
            return {
              ...z.def,
              role: z.role,
              status: z.status,
              statusHistory: z.statusHistory.map((x) => ({ ...x })),
              roleHistory: z.roleHistory.map((x) => ({ ...x })),
              sourcePivotIds: [...z.pivotIds],
              interactions: z.interactions.map((x) => ({ ...x })),
              touchCount: z.interactions.length,
              rejectionCount: z.interactions.filter((x) => x.rejected === true && !x.broke).length,
              sweepCount: z.interactions.filter((x) => x.swept).length,
              closeThroughCount: z.interactions.filter((x) => x.closedThrough).length,
              brokenAt: z.brokenAt,
              breakEvidence: z.breakEvidence ? { ...z.breakEvidence, closeTimes: [...z.breakEvidence.closeTimes], closes: [...z.breakEvidence.closes] } : null,
              flippedAt: z.flippedAt,
              lastInteractionAt: z.lastInteractionIndex === null ? null : this.bars[z.lastInteractionIndex]!.time,
              inZone: z.episode?.open ?? false,
              score: finalizeScore(components, z.status),
              distanceFromPrice: distance,
              distanceAtr: distance === null || !(atrNow > 0) ? null : inside ? 0 : Math.abs(distance) / atrNow,
              confluenceIds: [],
            };
          });
    return {
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      state,
      barsProcessed: n,
      requiredBars: s.minHistoryBars,
      lastClosedTime: n ? this.bars[last]!.time : null,
      currentPrice: price,
      atr: atrNow > 0 ? atrNow : null,
      zones,
      pivots: this.pivots.map((p) => ({ ...p })),
      gaps: this.gaps.map((g) => ({ ...g })),
      settingsKey: settingsKey(s),
    };
  }
}

/** Precedence: break > closeThrough > sweep > rejection > touch; pending until resolved. */
export function outcomeOf(it: Interaction): Interaction['outcome'] {
  if (it.broke) return 'break';
  if (it.rejected === null) return 'pending';
  if (it.closedThrough) return 'closeThrough';
  if (it.swept) return 'sweep';
  return it.rejected ? 'rejection' : 'touch';
}

/** Convenience: analyse a full history in one call (identical to incremental updates). */
export function analyzeTimeframe(
  opts: SREngineOptions & { candles: readonly Candle[]; lastBarClosed?: boolean },
): SRSnapshot {
  const e = new SRTimeframeEngine(opts);
  e.update(opts.candles, { lastBarClosed: opts.lastBarClosed });
  return e.snapshot();
}
