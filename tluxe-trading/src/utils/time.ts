/**
 * Time-zone utilities built on the platform IANA database (Intl).
 * No offsets are hard-coded: every conversion asks Intl for the rules in force
 * at that instant, so daylight-saving transitions are handled automatically.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function getZonedParts(instant: Date | number, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: hour === 24 ? 0 : hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (east positive, e.g. Yangon = +390). */
export function getTimeZoneOffsetMinutes(instant: Date | number, timeZone: string): number {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  const p = getZonedParts(ms, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(ms / 1000) * 1000;
  return Math.round((wallAsUtc - truncated) / 60000);
}

/** "UTC+6:30", "UTC−6", "UTC+0". Uses a true minus sign for legibility. */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '−' : '+';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant (epoch ms).
 * Two-pass offset resolution handles instants either side of a DST change.
 */
export function zonedTimeToUtc(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const firstOffset = getTimeZoneOffsetMinutes(wallAsUtc, timeZone);
  let result = wallAsUtc - firstOffset * 60000;
  const secondOffset = getTimeZoneOffsetMinutes(result, timeZone);
  if (secondOffset !== firstOffset) result = wallAsUtc - secondOffset * 60000;
  return result;
}

/** Calendar arithmetic on a local date (no time-zone involvement). */
export function addDays(date: LocalDate, days: number): LocalDate & { weekday: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
