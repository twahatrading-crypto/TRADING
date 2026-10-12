import type { OfpSession } from './config';

/* America/New_York session windows for COMEX metals (DST-correct via Intl, no hard-coded offsets).
 *   ETH (Globex day): 18:00 ET (previous evening) -> 17:00 ET.
 *   RTH (day session): 08:20 ET -> 13:30 ET. */

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface NyParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function nyParts(t: number): NyParts {
  const p: Record<string, number> = {};
  for (const x of fmt.formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute!, s: p.second! };
}

/** UTC ms of a New York wall-clock time (two-pass to land on the right side of a DST change). */
export function nyToUtc(y: number, m: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = nyParts(t);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    t = guess - (asUtc - t);
  }
  return t;
}

const DAY = 86_400_000;

export interface SessionWindow {
  session: OfpSession;
  start: number;
  end: number;
}

/** The session window containing (or, for RTH outside hours, most recently before) `t`. */
export function sessionWindow(t: number, session: OfpSession): SessionWindow {
  const p = nyParts(t);
  if (session === 'ETH') {
    let start = nyToUtc(p.y, p.m, p.d, 18, 0);
    if (start > t) {
      const q = nyParts(t - DAY);
      start = nyToUtc(q.y, q.m, q.d, 18, 0);
    }
    return { session, start, end: start + 23 * 3_600_000 };
  }
  let start = nyToUtc(p.y, p.m, p.d, 8, 20);
  if (start > t) {
    const q = nyParts(t - DAY);
    start = nyToUtc(q.y, q.m, q.d, 8, 20);
  }
  return { session, start, end: start + (5 * 60 + 10) * 60_000 };
}

export const inWindow = (t: number, w: SessionWindow) => t >= w.start && t < w.end;

/**
 * Where `t` falls in the CME Globex metals WEEKLY SCHEDULE (Sun 18:00 ET -> Fri 17:00 ET, daily break 17:00-18:00
 * ET). Schedule only: exchange holidays, early closes and halts are NOT known here, so this must never be shown
 * as "market open" - only as "inside / outside scheduled hours".
 */
export type ScheduleState = 'IN_SCHEDULE' | 'DAILY_BREAK' | 'WEEKEND';

export function globexSchedule(t: number): ScheduleState {
  const p = nyParts(t);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // New York calendar weekday, 0 = Sunday
  const mins = p.h * 60 + p.mi;
  if (dow === 6) return 'WEEKEND';
  if (dow === 0) return mins >= 18 * 60 ? 'IN_SCHEDULE' : 'WEEKEND';
  if (dow === 5) return mins < 17 * 60 ? 'IN_SCHEDULE' : 'WEEKEND';
  return mins >= 17 * 60 && mins < 18 * 60 ? 'DAILY_BREAK' : 'IN_SCHEDULE';
}
