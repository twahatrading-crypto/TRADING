import { SESSIONS } from '../../config/sessions';
import { addDays, getZonedParts, zonedTimeToUtc } from '../../utils/time';
import { getSessionIntervals } from '../../utils/sessions';
import { DAY_START_HOUR, DAY_TZ } from './config';

/*
 * PROFILE WINDOWS (deterministic, IANA time zones — DST handled by the zone database, never by offsets):
 *   trading day   [17:00 New York, next 17:00 New York)  (metals / FX convention)
 *   week          starts at the trading day that opens Sunday 17:00 New York; 7 trading days
 *   sessions      Asia 09:00–18:00 Tokyo · London 08:00–17:00 London · New York 08:00–17:00 New York
 *                 (the shared TLUXE session definitions); current session = the one with the latest open
 *                 at or before the knowledge time; previous session = the one opened just before it.
 * All values are epoch SECONDS.
 */
export function tradingDayStart(tSec: number): number {
  const p = getZonedParts(tSec * 1000, DAY_TZ);
  let s = zonedTimeToUtc(p, DAY_START_HOUR, 0, DAY_TZ);
  if (s > tSec * 1000) s = zonedTimeToUtc(addDays(p, -1), DAY_START_HOUR, 0, DAY_TZ);
  return Math.floor(s / 1000);
}
export function nextTradingDayStart(startSec: number): number {
  const p = getZonedParts(startSec * 1000, DAY_TZ);
  return Math.floor(zonedTimeToUtc(addDays(p, 1), DAY_START_HOUR, 0, DAY_TZ) / 1000);
}
export function previousTradingDayStart(startSec: number): number {
  return tradingDayStart(startSec - 1);
}
export function weekStart(tSec: number): number {
  let s = tradingDayStart(tSec);
  for (let k = 0; k < 7 && getZonedParts(s * 1000, DAY_TZ).weekday !== 0; k++) s = previousTradingDayStart(s);
  return s;
}
export function nextWeekStart(startSec: number): number {
  let s = startSec;
  for (let k = 0; k < 7; k++) s = nextTradingDayStart(s);
  return s;
}

export type SessionId = 'asia' | 'london' | 'new-york';
export interface SessionWindow {
  id: SessionId;
  name: string;
  from: number;
  to: number;
}
const DEFS = SESSIONS.filter((s) => s.id === 'asia' || s.id === 'london' || s.id === 'new-york');

/** All session windows overlapping [fromSec, toSec], ordered by open. */
export function sessionWindows(fromSec: number, toSec: number): SessionWindow[] {
  const out: SessionWindow[] = [];
  for (const d of DEFS)
    for (const iv of getSessionIntervals(d, fromSec * 1000, toSec * 1000)) out.push({ id: d.id as SessionId, name: d.name, from: Math.floor(iv.open / 1000), to: Math.floor(iv.close / 1000) });
  return out.sort((a, b) => a.from - b.from || (a.id < b.id ? -1 : 1));
}

/** Current / previous session and the latest instance of each session, relative to knowledge time K. */
export function sessionsAt(K: number): { current: SessionWindow | null; previous: SessionWindow | null; latest: Partial<Record<SessionId, SessionWindow>> } {
  const started = sessionWindows(K - 5 * 86_400, K).filter((w) => w.from < K);
  const current = started[started.length - 1] ?? null;
  const previous = started[started.length - 2] ?? null;
  const latest: Partial<Record<SessionId, SessionWindow>> = {};
  for (const w of started) latest[w.id] = w;
  return { current, previous, latest };
}
