import { SESSIONS } from '../../config/sessions';
import { getSessionState } from '../../utils/sessions';

export const fmtTime = (sec: number | null, tz: string) =>
  sec === null
    ? '—'
    : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(sec * 1000);

export const fmtUtc = (sec: number | null) => (sec === null ? '—' : `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);

/** Regular sessions open at a bar time (tag only — never changes price facts). */
export function sessionsAt(sec: number): string[] {
  return SESSIONS.filter((s) => getSessionState(s, sec * 1000, 0).status === 'OPEN').map((s) => s.shortName ?? s.name);
}

export function formatBars(n: number): string {
  return `${n.toLocaleString('en-US')} bar${n === 1 ? '' : 's'}`;
}
