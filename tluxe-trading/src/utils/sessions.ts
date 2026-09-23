import { addDays, getZonedParts, zonedTimeToUtc } from './time';

export interface WallTime {
  hour: number;
  minute: number;
}

export interface SessionDefinition {
  id: string;
  name: string;
  /** Compact label for narrow layouts. */
  shortName?: string;
  /** IANA zone whose wall clock defines the session (DST follows this zone). */
  timeZone: string;
  open: WallTime;
  /** If close <= open the session ends on the following calendar day. */
  close: WallTime;
  /** Weekdays (0 = Sun … 6 = Sat, in `timeZone`) on which a session opens. */
  openDays: number[];
  /** Short human description of the rule, e.g. "09:00–18:00 Tokyo". */
  rule: string;
}

export type SessionStatus = 'OPEN' | 'CLOSED' | 'UPCOMING';

export interface SessionInterval {
  open: number; // epoch ms
  close: number; // epoch ms
}

export interface SessionState {
  id: string;
  status: SessionStatus;
  /** The interval in progress, if open. */
  current: SessionInterval | null;
  /** The next interval to open (always defined for a weekly schedule). */
  next: SessionInterval;
  /** Milliseconds until close (when OPEN) or until open (otherwise). */
  countdownMs: number;
  /** 0–1 elapsed fraction of the current interval; null when not open. */
  progress: number | null;
}

const DAY_MS = 86_400_000;

function toMinutes(t: WallTime): number {
  return t.hour * 60 + t.minute;
}

/** All session intervals that overlap [fromMs, toMs]. */
export function getSessionIntervals(def: SessionDefinition, fromMs: number, toMs: number): SessionInterval[] {
  const overnight = toMinutes(def.close) <= toMinutes(def.open);
  const start = getZonedParts(fromMs, def.timeZone);
  const spanDays = Math.ceil((toMs - fromMs) / DAY_MS) + 2;
  const out: SessionInterval[] = [];
  for (let i = -2; i <= spanDays; i++) {
    const day = addDays(start, i);
    if (!def.openDays.includes(day.weekday)) continue;
    const open = zonedTimeToUtc(day, def.open.hour, def.open.minute, def.timeZone);
    const closeDay = overnight ? addDays(day, 1) : day;
    const close = zonedTimeToUtc(closeDay, def.close.hour, def.close.minute, def.timeZone);
    if (close > fromMs && open < toMs) out.push({ open, close });
  }
  return out.sort((a, b) => a.open - b.open);
}

export function getSessionState(def: SessionDefinition, now: number, upcomingWindowMs: number): SessionState {
  // A two-week window always contains the current and next interval for weekly schedules.
  const intervals = getSessionIntervals(def, now - DAY_MS, now + 14 * DAY_MS);
  const current = intervals.find((iv) => iv.open <= now && now < iv.close) ?? null;
  const next = intervals.find((iv) => iv.open > now);
  if (!next) throw new Error(`Session "${def.id}" has no upcoming interval — check openDays`);

  if (current) {
    return {
      id: def.id,
      status: 'OPEN',
      current,
      next,
      countdownMs: current.close - now,
      progress: (now - current.open) / (current.close - current.open),
    };
  }
  const countdownMs = next.open - now;
  return {
    id: def.id,
    status: countdownMs <= upcomingWindowMs ? 'UPCOMING' : 'CLOSED',
    current: null,
    next,
    countdownMs,
    progress: null,
  };
}

/** "2d 4h", "7h 16m", "16m 05s", "42s". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
