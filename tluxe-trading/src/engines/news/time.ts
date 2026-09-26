/* Display-time helpers. Instants are stored as epoch ms (UTC); zones are applied only for display,
 * through the IANA database (Intl) — DST is never hand-coded and UTC offsets are never assumed. */

export const DENVER_TZ = 'America/Denver';

export function zoneParts(ms: number, timeZone: string): { date: string; time: string; zone: string } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.weekday} ${p.month} ${p.day}`, time: `${p.hour}:${p.minute}`, zone: p.timeZoneName ?? timeZone };
}

/** Calendar day key (YYYY-MM-DD) of an instant in a zone — used for Today / Tomorrow / This Week. */
export function dayKey(ms: number, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Day index (Mon = 0) and day key → whether `ms` falls in the same ISO week (Mon–Sun) as `now` in the zone. */
export function sameWeek(ms: number, now: number, timeZone: string): boolean {
  const idx = (t: number) => {
    const [y, m, d] = dayKey(t, timeZone).split('-').map(Number) as [number, number, number];
    const days = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
    return { days, dow: (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 };
  };
  const a = idx(ms);
  const b = idx(now);
  return a.days - a.dow === b.days - b.dow;
}

export function countdown(ms: number): { days: number; hours: number; minutes: number; seconds: number; negative: boolean } {
  const negative = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  return { days, hours, minutes, seconds: s - minutes * 60, negative };
}
