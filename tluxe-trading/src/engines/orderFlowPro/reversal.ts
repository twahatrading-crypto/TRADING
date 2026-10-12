import { toTick } from './classify';
import type { FootprintBar } from './footprint';

/* ============================================================================
 * Order Flow Pro reversal detector - RESEARCH ONLY. It describes evidence; it never places, suggests or sizes a
 * trade. The score is an additive evidence score (sum of the weights of the evidence that is PRESENT), shown out
 * of the weight that could be evaluated. It is NOT a probability of a winning trade.
 *
 * Causality: a signal is created at the CLOSE of bar i using bars <= i only. Later bars may only add the
 * follow-through evidence (structure shift, retest) or invalidate it; the original score at signal time is kept.
 * Footprint evidence (absorption, delta divergence) is UNAVAILABLE when prints cannot be classified.
 * Bearish logic = bullish logic on the price-mirrored series (identical rules, no separate tuning).
 * ========================================================================== */

export type Direction = 'BULLISH' | 'BEARISH';
export type EvidenceState = 'PRESENT' | 'ABSENT' | 'UNAVAILABLE' | 'PENDING';
export type EvidenceKey = 'sweep' | 'reclaim' | 'rejection' | 'absorption' | 'deltaDivergence' | 'ofi' | 'structureShift' | 'retest';

export const EVIDENCE_WEIGHTS: Record<EvidenceKey, number> = {
  sweep: 20,
  reclaim: 15,
  rejection: 10,
  absorption: 15,
  deltaDivergence: 15,
  ofi: 10,
  structureShift: 10,
  retest: 5,
};

export const EVIDENCE_LABEL: Record<EvidenceKey, string> = {
  sweep: 'Liquidity sweep',
  reclaim: 'Reclaim',
  rejection: 'Rejection wick',
  absorption: 'Absorption',
  deltaDivergence: 'Delta divergence',
  ofi: 'Order-flow imbalance',
  structureShift: 'Market structure shift',
  retest: 'Retest confirmation',
};

export interface Evidence {
  key: EvidenceKey;
  state: EvidenceState;
  weight: number;
  detail: string;
}

export interface ReversalSignal {
  id: string;
  direction: Direction;
  /** Open time of the signal bar; the signal exists from that bar's close. */
  t: number;
  knownAt: number;
  setup: 'Liquidity Sweep' | 'Rejection';
  price: number;
  sweptLevel: number | null;
  invalidation: number;
  scoreAtSignal: number;
  score: number;
  maxScore: number;
  evidence: Evidence[];
  status: 'CANDIDATE' | 'CONFIRMED' | 'RETESTED' | 'INVALIDATED';
}

export interface ReversalInput {
  bars: readonly FootprintBar[];
  /** Cumulative delta at each bar's close (classified prints only), by bar open time. */
  cvdAt: ReadonlyMap<number, number>;
  /** Top-of-book OFI summed over each bar, by bar open time. */
  ofiAt: ReadonlyMap<number, number>;
  tick: number;
  /** Prints can be side-classified (quote rule). False -> footprint evidence UNAVAILABLE. */
  classified: boolean;
}

export interface ReversalParams {
  pivot: number; // bars each side of a swing
  lookback: number; // bars a swing stays eligible
  followBars: number; // bars allowed for structure shift / retest
  minScore: number; // signals below are not emitted
  absorbShare: number; // share of classified volume hitting into the extreme quarter
  rejectionWick: number; // wick / range
  minClassifiedShare: number; // footprint evidence needs this share of the bar's prints classified
}

export const DEFAULT_REVERSAL_PARAMS: ReversalParams = { pivot: 2, lookback: 40, followBars: 6, minScore: 40, absorbShare: 0.35, rejectionWick: 0.5, minClassifiedShare: 0.7 };

interface MBar {
  t: number;
  ms: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** share of classified volume that SOLD into the lowest quarter of the (mirrored) range; null = unavailable */
  absorb: number | null;
  cvd: number | null;
  ofi: number | null;
}

function absorbShares(b: FootprintBar, tick: number, minClassified: number): { bull: number | null; bear: number | null } {
  const classified = b.buy + b.sell;
  const total = classified + b.unknown;
  if (b.trades === 0 || total <= 0 || classified / total < minClassified || b.h <= b.l) return { bull: null, bear: null };
  const lowCut = toTick(b.l + (b.h - b.l) * 0.25, tick);
  const highCut = toTick(b.h - (b.h - b.l) * 0.25, tick);
  let sellLow = 0;
  let buyHigh = 0;
  for (const [k, lv] of b.levels) {
    if (k <= lowCut) sellLow += lv.sell;
    if (k >= highCut) buyHigh += lv.buy;
  }
  return { bull: sellLow / classified, bear: buyHigh / classified };
}

function mirror(m: MBar): MBar {
  return { ...m, o: -m.o, h: -m.l, l: -m.h, c: -m.c, cvd: m.cvd === null ? null : -m.cvd, ofi: m.ofi === null ? null : -m.ofi };
}

const isPivotLow = (b: readonly MBar[], j: number, k: number) => {
  if (j - k < 0 || j + k >= b.length) return false;
  for (let x = j - k; x <= j + k; x++) if (x !== j && (x < j ? b[x]!.l <= b[j]!.l : b[x]!.l < b[j]!.l)) return false;
  return true;
};

/** Bullish detection on (possibly mirrored) bars; returns signals in mirrored price space. */
function detectBull(b: readonly MBar[], classified: boolean, p: ReversalParams, dir: Direction): ReversalSignal[] {
  const out: ReversalSignal[] = [];
  for (let i = p.pivot * 2 + 1; i < b.length; i++) {
    const bar = b[i]!;
    // most recent confirmed, not-yet-swept swing low inside the lookback
    let swing: { j: number; price: number } | null = null;
    for (let j = i - 1 - p.pivot; j >= Math.max(0, i - p.lookback); j--) {
      if (!isPivotLow(b, j, p.pivot)) continue;
      let swept = false;
      for (let x = j + 1; x < i; x++) if (b[x]!.l < b[j]!.l) swept = true;
      if (!swept) swing = { j, price: b[j]!.l };
      break;
    }
    const range = bar.h - bar.l;
    const sweep = swing !== null && bar.l < swing.price;
    const reclaim = sweep && bar.c > swing!.price;
    const rejection = range > 0 && (Math.min(bar.o, bar.c) - bar.l) / range >= p.rejectionWick;
    const absorbAvail = classified && bar.absorb !== null;
    const absorption = absorbAvail && bar.absorb! >= p.absorbShare && bar.c > bar.l + range / 2;
    if (!(sweep && reclaim) && !(rejection && absorption)) continue;

    const ev: Evidence[] = [];
    const add = (key: EvidenceKey, state: EvidenceState, detail: string) => ev.push({ key, state, weight: EVIDENCE_WEIGHTS[key], detail });
    add('sweep', sweep ? 'PRESENT' : 'ABSENT', sweep ? 'Traded through the prior swing extreme' : 'No prior swing extreme taken');
    add('reclaim', reclaim ? 'PRESENT' : 'ABSENT', reclaim ? 'Closed back beyond the swept level' : 'No close back beyond a swept level');
    add('rejection', rejection ? 'PRESENT' : 'ABSENT', range > 0 ? `Wick ${Math.round(((Math.min(bar.o, bar.c) - bar.l) / range) * 100)}% of range` : 'Zero range');
    add('absorption', !absorbAvail ? 'UNAVAILABLE' : absorption ? 'PRESENT' : 'ABSENT', !absorbAvail ? 'Prints not classifiable (quote rule) for this bar' : `${Math.round(bar.absorb! * 100)}% of classified volume hit into the extreme quarter`);
    const sw = swing ? b[swing.j]! : null;
    const divAvail = classified && sw !== null && sw.cvd !== null && bar.cvd !== null;
    const div = divAvail && sweep && bar.cvd! > sw!.cvd!;
    add('deltaDivergence', !divAvail ? 'UNAVAILABLE' : div ? 'PRESENT' : 'ABSENT', !divAvail ? 'Cumulative delta not available at both points' : div ? 'New extreme without a new cumulative-delta extreme' : 'Cumulative delta confirmed the new extreme');
    add('ofi', bar.ofi === null ? 'UNAVAILABLE' : bar.ofi > 0 ? 'PRESENT' : 'ABSENT', bar.ofi === null ? 'No top-of-book quotes for this bar' : `Top-of-book OFI ${bar.ofi > 0 ? '+' : ''}${Math.round(bar.ofi)}`);

    // Follow-through (later bars only).
    const prevHigh = Math.max(...b.slice(Math.max(0, i - 5), i).map((x) => x.h));
    let mssAt = -1;
    let invalid = false;
    for (let x = i + 1; x < Math.min(b.length, i + 1 + p.followBars); x++) {
      if (b[x]!.l < bar.l) {
        invalid = true;
        break;
      }
      if (b[x]!.c > prevHigh) {
        mssAt = x;
        break;
      }
    }
    let retest = false;
    if (mssAt > 0 && !invalid)
      for (let x = mssAt + 1; x < Math.min(b.length, mssAt + 1 + p.followBars); x++) {
        if (b[x]!.l < bar.l) {
          invalid = true;
          break;
        }
        if (b[x]!.l <= bar.c && b[x]!.c > bar.c) {
          retest = true;
          break;
        }
      }
    const pending = i + p.followBars >= b.length;
    add('structureShift', mssAt > 0 ? 'PRESENT' : pending && !invalid ? 'PENDING' : 'ABSENT', mssAt > 0 ? 'Closed beyond the recent opposite swing' : 'No close beyond the recent opposite swing yet');
    add('retest', retest ? 'PRESENT' : mssAt > 0 && pending && !invalid ? 'PENDING' : 'ABSENT', retest ? 'Retested the signal close and held' : 'No held retest yet');

    const atSignal: EvidenceKey[] = ['sweep', 'reclaim', 'rejection', 'absorption', 'deltaDivergence', 'ofi'];
    const scoreOf = (keys: readonly EvidenceKey[]) => ev.filter((e) => keys.includes(e.key) && e.state === 'PRESENT').reduce((s, e) => s + e.weight, 0);
    const scoreAtSignal = scoreOf(atSignal);
    if (scoreAtSignal < p.minScore) continue;
    const maxScore = ev.filter((e) => e.state !== 'UNAVAILABLE').reduce((s, e) => s + e.weight, 0);
    out.push({
      id: `${dir}:${bar.t}`,
      direction: dir,
      t: bar.t,
      knownAt: bar.t + bar.ms,
      setup: sweep && reclaim ? 'Liquidity Sweep' : 'Rejection',
      price: bar.c,
      sweptLevel: sweep ? swing!.price : null,
      invalidation: bar.l,
      scoreAtSignal,
      score: scoreOf(Object.keys(EVIDENCE_WEIGHTS) as EvidenceKey[]),
      maxScore,
      evidence: ev,
      status: invalid ? 'INVALIDATED' : retest ? 'RETESTED' : mssAt > 0 ? 'CONFIRMED' : 'CANDIDATE',
    });
  }
  return out;
}

/** Evaluate CLOSED bars only (the forming bar never creates a signal). */
export function detectReversals(input: ReversalInput, params: ReversalParams = DEFAULT_REVERSAL_PARAMS): ReversalSignal[] {
  const closed = input.bars.filter((b) => b.closed);
  const base: MBar[] = [];
  const bearAbsorb: Array<number | null> = [];
  for (const b of closed) {
    const a = absorbShares(b, input.tick, params.minClassifiedShare);
    base.push({ t: b.t, ms: b.ms, o: b.o, h: b.h, l: b.l, c: b.c, absorb: a.bull, cvd: input.cvdAt.get(b.t) ?? null, ofi: input.ofiAt.get(b.t) ?? null });
    bearAbsorb.push(a.bear);
  }
  const bull = detectBull(base, input.classified, params, 'BULLISH');
  const mirrored = base.map((m, i) => ({ ...mirror(m), absorb: bearAbsorb[i]! }));
  const bear = detectBull(mirrored, input.classified, params, 'BEARISH').map((s) => ({
    ...s,
    price: -s.price,
    sweptLevel: s.sweptLevel === null ? null : -s.sweptLevel,
    invalidation: -s.invalidation,
  }));
  return [...bull, ...bear].sort((a, b) => a.t - b.t || a.direction.localeCompare(b.direction));
}
