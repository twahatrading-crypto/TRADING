/**
 * Display formatting. Every formatter accepts `null` and returns the UNKNOWN
 * glyph — missing data is never rendered as 0.
 */

export const UNKNOWN = '—';

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function formatPrice(value: number | null | undefined, decimals = 1): string {
  if (!isNum(value)) return UNKNOWN;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatSigned(value: number | null | undefined, decimals = 1): string {
  if (!isNum(value)) return UNKNOWN;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + formatPrice(Math.abs(value), decimals);
}

export function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (!isNum(value)) return UNKNOWN;
  return `${formatSigned(value, decimals)}%`;
}

export function formatVolume(value: number | null | undefined): string {
  if (!isNum(value)) return UNKNOWN;
  return Math.round(value).toLocaleString('en-US');
}

export function directionOf(value: number | null | undefined): 'up' | 'down' | 'flat' | 'unknown' {
  if (!isNum(value)) return 'unknown';
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function cached(key: string, make: () => Intl.DateTimeFormat) {
  let f = timeFormatters.get(key);
  if (!f) timeFormatters.set(key, (f = make()));
  return f;
}

export function formatClockTime(instant: number, timeZone: string, withSeconds = false): string {
  return cached(`t|${timeZone}|${withSeconds}`, () =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined,
      hour12: true,
    }),
  ).format(instant);
}

export function formatHm24(instant: number, timeZone: string): string {
  return cached(`hm|${timeZone}`, () =>
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  ).format(instant);
}

export function formatShortDate(instant: number, timeZone: string): string {
  return cached(`d|${timeZone}`, () =>
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }),
  ).format(instant);
}

export function formatLongDate(instant: number, timeZone: string): string {
  return cached(`D|${timeZone}`, () =>
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
  ).format(instant);
}

export function timeZoneAbbrev(instant: number, timeZone: string): string {
  const parts = cached(`z|${timeZone}`, () =>
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }),
  ).formatToParts(instant);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}
