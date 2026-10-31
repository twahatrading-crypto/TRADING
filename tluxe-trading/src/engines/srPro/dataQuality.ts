/**
 * Contract liquidity quality — protects S&R ratings from thin back-month history.
 *
 * WHY. The candle endpoint serves the CURRENT contract (e.g. GCZ6) back to its
 * listing. Long before it became the active month it traded a handful of lots a
 * day; swing highs and lows printed then are not levels anyone defended. The
 * S&R engine (unchanged) treats every bar alike, so this layer decides which
 * zones may receive a normal strength rating. No bar is deleted: thin history
 * stays on the chart and every zone stays listed — thin-history zones are
 * marked UNRATED instead of Strong / Medium / Weak.
 *
 * METHOD (objective, reproducible, and not one magic threshold):
 *   1. Daily exchange volume per day (D1 bars when present — Databento D1 is a
 *      UTC day, fine for regime detection — else H1 summed per CME session day).
 *   2. Reference R = median volume of the latest `refDays` days (≥ `minDays` required).
 *   3. For each threshold θ in THRESHOLDS, a day is LIQUID when volume ≥ θ·R. Walking
 *      back from the newest day, the active regime continues while thin days come in
 *      runs of at most `maxThinRun` (holidays, half days); it ends at the first longer
 *      thin run. activeSince(θ) = first liquid day after that run.
 *   4. activeSince = the LATEST of the activeSince(θ) — the most conservative cut-off.
 *      `stable` = the thresholds agree within `stableDays` days; when they do not, the
 *      transition is reported as ambiguous (the conservative date still applies).
 */
import type { Candle } from '../../types/market';
import { sessionDate } from './cmeCalendar';

export const THRESHOLDS = [0.05, 0.1, 0.2] as const;

export interface QualityOptions {
  refDays: number;
  minDays: number;
  maxThinRun: number;
  stableDays: number;
}
export const DEFAULT_QUALITY: QualityOptions = { refDays: 20, minDays: 10, maxThinRun: 2, stableDays: 10 };

export interface DailyVolume {
  day: string;
  /** Start of the day (s) — the earliest bar time in it. */
  time: number;
  volume: number;
}

export interface QualityResult {
  state: 'OK' | 'INSUFFICIENT_DATA' | 'NO_VOLUME';
  source: 'D1' | 'H1' | null;
  referenceVolume: number | null;
  /** Bars (any TF) with time < activeSince belong to thin history. null = whole history usable. */
  activeSince: number | null;
  activeSinceDay: string | null;
  perThreshold: { threshold: number; activeSinceDay: string | null }[];
  stable: boolean;
  thinDays: number;
  totalDays: number;
  explanation: string;
}

export function dailyVolumes(d1: readonly Candle[] | undefined, h1: readonly Candle[] | undefined): { source: 'D1' | 'H1' | null; days: DailyVolume[] } {
  const closed = (b: readonly Candle[]) => b.filter((c) => c.isClosed !== false && typeof c.volume === 'number');
  if (d1 && closed(d1).length) {
    return { source: 'D1', days: closed(d1).map((c) => ({ day: new Date(c.time * 1000).toISOString().slice(0, 10), time: c.time, volume: c.volume as number })) };
  }
  if (h1 && closed(h1).length) {
    const map = new Map<string, DailyVolume>();
    for (const c of closed(h1)) {
      const day = sessionDate(c.time);
      const e = map.get(day);
      if (e) e.volume += c.volume as number;
      else map.set(day, { day, time: c.time, volume: c.volume as number });
    }
    return { source: 'H1', days: [...map.values()].sort((a, b) => a.time - b.time) };
  }
  return { source: null, days: [] };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

function activeSinceIndex(days: readonly DailyVolume[], cut: number, maxThinRun: number): number {
  let start = days.length - 1;
  let thin = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]!.volume >= cut) {
      start = i;
      thin = 0;
    } else if (++thin > maxThinRun) break;
  }
  // Leading thin days of the newest edge do not start a regime: skip to the first liquid day.
  while (start < days.length && days[start]!.volume < cut) start++;
  return Math.min(start, days.length - 1);
}

export function assessQuality(d1: readonly Candle[] | undefined, h1: readonly Candle[] | undefined, o: QualityOptions = DEFAULT_QUALITY): QualityResult {
  const { source, days } = dailyVolumes(d1, h1);
  const base = { source, perThreshold: [], stable: true, thinDays: 0, totalDays: days.length };
  if (!days.length) return { ...base, state: 'NO_VOLUME', referenceVolume: null, activeSince: null, activeSinceDay: null, explanation: 'No exchange volume — the liquidity check cannot run; zones keep their engine rating and are labelled UNVERIFIED LIQUIDITY.' };
  if (days.length < o.minDays) return { ...base, state: 'INSUFFICIENT_DATA', referenceVolume: null, activeSince: null, activeSinceDay: null, explanation: `Only ${days.length} days of volume (need ${o.minDays}).` };
  const ref = median(days.slice(-o.refDays).map((d) => d.volume));
  const per = THRESHOLDS.map((t) => {
    const i = activeSinceIndex(days, t * ref, o.maxThinRun);
    return { threshold: t, index: i, activeSinceDay: days[i]!.day };
  });
  const idx = Math.max(...per.map((p) => p.index));
  const spread = Math.max(...per.map((p) => p.index)) - Math.min(...per.map((p) => p.index));
  const stable = spread <= o.stableDays;
  const activeSince = idx === 0 ? null : days[idx]!.time;
  const thinDays = idx;
  const pct = (t: number) => `${Math.round(t * 100)}%`;
  const explanation =
    activeSince === null
      ? `All ${days.length} days trade at ≥ ${pct(THRESHOLDS[THRESHOLDS.length - 1]!)} of the reference volume (${Math.round(ref).toLocaleString('en-US')} / day): no thin history.`
      : `Reference: median of the latest ${Math.min(o.refDays, days.length)} days = ${Math.round(ref).toLocaleString('en-US')} contracts/day (${source}). ` +
        `The current liquid regime starts ${days[idx]!.day} (latest of: ${per.map((p) => `${pct(p.threshold)} → ${p.activeSinceDay}`).join(', ')}). ` +
        `${thinDays} earlier day(s) are thin history: their bars stay visible, zones formed there are UNRATED.` +
        (stable ? '' : ' The thresholds disagree by more than ' + o.stableDays + ' days — the transition is ambiguous; the most conservative date applies.');
  return {
    state: 'OK',
    source,
    referenceVolume: ref,
    activeSince,
    activeSinceDay: activeSince === null ? null : days[idx]!.day,
    perThreshold: per.map(({ threshold, activeSinceDay }) => ({ threshold, activeSinceDay })),
    stable,
    thinDays,
    totalDays: days.length,
    explanation,
  };
}
