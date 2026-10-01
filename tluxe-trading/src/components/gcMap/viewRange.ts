import type { MapColumn } from './liquidityMap';

/* ============================================================================
 * GC Liquidity Map - visible TIME WINDOW (viewport only; never an input to recorded depth or to any calculation).
 *   LIVE SESSION = from the start of the current continuous recorded-depth session to now; 1H .. 24H = fixed spans.
 * The session is read from the recorded-valid intervals the page already loaded: holes shorter than SESSION_BREAK_MS
 * stay inside the session (and are still hatched as DEPTH GAP); a longer hole starts a new session.
 * ========================================================================== */

export const MAP_RANGES = ['LIVE', '1H', '3H', '6H', '12H', '24H'] as const;
export type MapRange = (typeof MAP_RANGES)[number];
export const RANGE_LABEL: Record<MapRange, string> = { LIVE: 'LIVE SESSION', '1H': '1H', '3H': '3H', '6H': '6H', '12H': '12H', '24H': '24H' };
export const RANGE_MS: Record<Exclude<MapRange, 'LIVE'>, number> = { '1H': 3_600_000, '3H': 10_800_000, '6H': 21_600_000, '12H': 43_200_000, '24H': 86_400_000 };
/** A recorded-depth hole at least this long ends a session (shorter holes stay inside it, hatched). */
export const SESSION_BREAK_MS = 5 * 60_000;
/** LIVE SESSION never shows less than this (a session that just started still shows the gap before it). */
export const SESSION_MIN_SPAN_MS = 10 * 60_000;
/** How far back the page looks for the session start (also the LIVE SESSION maximum). */
export const SESSION_LOOKBACK_MS = 86_400_000;

export interface SessionInfo {
  /** First recorded-valid time of the current continuous session. */
  start: number;
  /** Last recorded-valid time of it. */
  end: number;
  /** End of the previous session inside the loaded columns (null = none loaded). */
  prevEnd: number | null;
}

/** Recorded-valid intervals of the columns, merged across holes shorter than breakMs, oldest first. Pure. */
export function sessions(cols: readonly MapColumn[], breakMs = SESSION_BREAK_MS): [number, number][] {
  const out: [number, number][] = [];
  for (const c of cols) {
    for (let i = 0; i < c.valid.length; i += 2) {
      const a = c.valid[i]!;
      const b = c.valid[i + 1]!;
      const last = out[out.length - 1];
      if (last && a - last[1] < breakMs) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
  }
  return out;
}

/** The latest session in the loaded columns (null = no recorded depth loaded). Pure. */
export function latestSession(cols: readonly MapColumn[], breakMs = SESSION_BREAK_MS): SessionInfo | null {
  const s = sessions(cols, breakMs);
  const last = s[s.length - 1];
  if (!last) return null;
  return { start: last[0], end: last[1], prevEnd: s.length > 1 ? s[s.length - 2]![1] : null };
}
