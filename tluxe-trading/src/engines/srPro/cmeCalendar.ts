/**
 * CME / COMEX GC trading calendar for the S&R page — a TypeScript port of
 * bridge/gc-hlr/lib/cme-calendar.cjs (same tables, same rules). A parity test
 * (cmeCalendar.test.ts) reads that file and fails if the two ever disagree, so
 * there is ONE schedule to maintain.
 *
 * SESSION MODEL. GC trades 18:00 ET (D-1) → 17:00 ET (D) with a 60-minute
 * maintenance break 17:00–18:00 ET (= 17:00 CT → 16:00 CT). Sunday 18:00 ET
 * opens Monday's session day. DST is resolved through Intl (America/New_York),
 * never a fixed offset.
 *
 * FAIL SAFE. Past VALID_THROUGH every answer is CALENDAR_EXPIRED: no previous
 * day, no previous week, no "market open" — the page says so instead of
 * guessing. Missing candles are NEVER read as a holiday (an outage looks the
 * same as a closure from the data side).
 *
 * All times are epoch SECONDS (the app's Candle.time).
 */

export const NY = 'America/New_York';

/** Last date the tables below are asserted to cover. Extend deliberately — see HOW_TO_EXTEND. */
export const VALID_THROUGH = '2026-12-31';

/** Full closures — no GC session. Must equal CLOSED in bridge/gc-hlr/lib/cme-calendar.cjs. */
export const CLOSED: ReadonlySet<string> = new Set(['2026-01-01', '2026-04-03', '2026-11-26', '2026-12-25']);

/** Early closes (exact metals minute disputed across sources; only the date is relied on). */
export const EARLY_CLOSE: ReadonlySet<string> = new Set([
  '2026-01-19',
  '2026-02-16',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-27',
  '2026-12-24',
]);

export const HOW_TO_EXTEND =
  "Extend CLOSED / EARLY_CLOSE / VALID_THROUGH in bridge/gc-hlr/lib/cme-calendar.cjs AND src/engines/srPro/cmeCalendar.ts from CME's published COMEX metals holiday schedule; the parity test keeps them identical.";

export type DayStatus = 'TRADING' | 'HOLIDAY' | 'WEEKEND' | 'CALENDAR_EXPIRED';

export interface DayInfo {
  date: string;
  status: DayStatus;
  earlyClose: boolean;
  reason: string;
}

const DAY_S = 86_400;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

export function zonedParts(sec: number, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(new Date(sec * 1000))) if (part.type !== 'literal') p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
}

/** The UTC instant (s) of a wall-clock time in `tz` (DST-correct; for times that exist in the zone). */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, mi) / 1000;
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) / 1000;
    const next = guess + (wall - asUtc);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const parseIso = (date: string) => date.split('-').map(Number) as [number, number, number];
export const addDays = (date: string, n: number) => {
  const [y, m, d] = parseIso(date);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_S * 1000).toISOString().slice(0, 10);
};
const weekday = (date: string) => {
  const [y, m, d] = parseIso(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The CME session day (ISO date) a timestamp belongs to: 17:00 ET onwards counts toward the next day. */
export function sessionDate(sec: number): string {
  const p = zonedParts(sec, NY);
  const date = iso(p.y, p.m, p.d);
  return p.h >= 17 ? addDays(date, 1) : date;
}

export function dayInfo(date: string): DayInfo {
  if (date > VALID_THROUGH) return { date, status: 'CALENDAR_EXPIRED', earlyClose: false, reason: `CME calendar verified only through ${VALID_THROUGH}. ${HOW_TO_EXTEND}` };
  const dow = weekday(date);
  if (dow === 6) return { date, status: 'WEEKEND', earlyClose: false, reason: 'Saturday — the week closed Friday 17:00 ET' };
  if (dow === 0) return { date, status: 'WEEKEND', earlyClose: false, reason: "Sunday — the week opens 18:00 ET (Monday's session)" };
  if (CLOSED.has(date)) return { date, status: 'HOLIDAY', earlyClose: false, reason: 'CME full closure' };
  if (EARLY_CLOSE.has(date)) return { date, status: 'TRADING', earlyClose: true, reason: 'CME early close' };
  return { date, status: 'TRADING', earlyClose: false, reason: '' };
}

/** Session window [start, end) in epoch s: 18:00 ET on the previous calendar day → 17:00 ET on `date`. */
export function dayBounds(date: string): { start: number; end: number } {
  const [py, pm, pd] = parseIso(addDays(date, -1));
  const [y, m, d] = parseIso(date);
  return { start: zonedToUtc(py, pm, pd, 18, 0, NY), end: zonedToUtc(y, m, d, 17, 0, NY) };
}

/** Earliest published early-close time (13:00 ET); after it an early-close day is treated as closed. */
const EARLY_CLOSE_HOUR_ET = 13;

export interface MarketClock {
  open: boolean;
  date: string;
  status: DayStatus;
  reason: string;
}

/** Is GC scheduled to trade at `sec`? (Schedule only — the feed decides LIVE vs STALE.) */
export function marketClock(sec: number): MarketClock {
  const date = sessionDate(sec);
  const info = dayInfo(date);
  if (info.status !== 'TRADING') return { open: false, date, status: info.status, reason: info.reason };
  const b = dayBounds(date);
  if (sec < b.start || sec >= b.end) return { open: false, date, status: 'TRADING', reason: 'Daily maintenance break 17:00–18:00 ET' };
  if (info.earlyClose) {
    const [y, m, d] = parseIso(date);
    if (sec >= zonedToUtc(y, m, d, EARLY_CLOSE_HOUR_ET, 0, NY)) return { open: false, date, status: 'TRADING', reason: 'CME early-close day — session ended' };
  }
  return { open: true, date, status: 'TRADING', reason: '' };
}

/** Previous TRADING session date before `date` (≤ 10 days back); null + reason when unknown. */
export function previousTradingDate(date: string): { date: string | null; reason: string } {
  for (let i = 1; i <= 10; i++) {
    const d = addDays(date, -i);
    const info = dayInfo(d);
    if (info.status === 'CALENDAR_EXPIRED') return { date: null, reason: info.reason };
    if (info.status === 'TRADING') return { date: d, reason: '' };
  }
  return { date: null, reason: 'No trading day within 10 days' };
}

/** Monday (ISO) of the CME week a session date belongs to. */
export function weekMonday(date: string): string {
  const dow = weekday(date);
  return addDays(date, dow === 0 ? 1 : 1 - dow);
}

/** The TRADING session dates of the week before `date`'s week; null when the calendar cannot say. */
export function previousWeekDates(date: string): { dates: string[] | null; monday: string; reason: string } {
  const monday = addDays(weekMonday(date), -7);
  const dates: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i);
    const info = dayInfo(d);
    if (info.status === 'CALENDAR_EXPIRED') return { dates: null, monday, reason: info.reason };
    if (info.status === 'TRADING') dates.push(d);
  }
  return { dates, monday, reason: dates.length ? '' : 'No trading days in the previous week' };
}

/** Wall-clock label for an instant: "22:00 UTC". */
export const utcHm = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 16) + ' UTC';
