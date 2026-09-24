export const fmtTime = (sec: number | null, tz: string) =>
  sec === null
    ? '—'
    : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(sec * 1000);

export const fmtClock = (sec: number | null, tz: string) =>
  sec === null ? '—' : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(sec * 1000);

export const fmtUtc = (sec: number | null) => (sec === null ? '—' : `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
