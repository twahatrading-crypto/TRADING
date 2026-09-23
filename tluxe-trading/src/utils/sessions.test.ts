import { describe, expect, it } from 'vitest';
import { SESSIONS, UPCOMING_WINDOW_MS } from '../config/sessions';
import { formatCountdown, getSessionIntervals, getSessionState, type SessionDefinition } from './sessions';

const utc = (s: string) => Date.parse(s);
const def = (id: string): SessionDefinition => {
  const d = SESSIONS.find((s) => s.id === id);
  if (!d) throw new Error(id);
  return d;
};
const state = (id: string, now: string) => getSessionState(def(id), utc(now), UPCOMING_WINDOW_MS);

describe('London session', () => {
  it('opens 08:00 GMT in winter and 08:00 BST (07:00Z) in summer', () => {
    expect(state('london', '2026-01-14T08:30:00Z').current).toEqual({
      open: utc('2026-01-14T08:00:00Z'),
      close: utc('2026-01-14T17:00:00Z'),
    });
    expect(state('london', '2026-07-14T07:30:00Z').current).toEqual({
      open: utc('2026-07-14T07:00:00Z'),
      close: utc('2026-07-14T16:00:00Z'),
    });
  });

  it('is CLOSED at weekends and reopens Monday', () => {
    const s = state('london', '2026-09-19T12:00:00Z'); // Saturday
    expect(s.status).toBe('CLOSED');
    expect(s.next.open).toBe(utc('2026-09-21T07:00:00Z'));
  });
});

describe('New York session across the US/UK DST gap', () => {
  // 2026-03-09 → 2026-03-27: US on DST, UK not yet.
  it('opens at 12:00Z during the gap week', () => {
    const s = state('new-york', '2026-03-10T12:30:00Z');
    expect(s.status).toBe('OPEN');
    expect(s.current?.open).toBe(utc('2026-03-10T12:00:00Z'));
  });

  it('opens at 13:00Z in winter', () => {
    expect(state('new-york', '2026-01-14T12:30:00Z').status).not.toBe('OPEN');
    expect(state('new-york', '2026-01-14T13:30:00Z').status).toBe('OPEN');
  });
});

describe('Asia session (Tokyo, no DST)', () => {
  it('runs 00:00–09:00Z on weekdays', () => {
    const s = state('asia', '2026-09-22T03:00:00Z');
    expect(s.status).toBe('OPEN');
    expect(s.current).toEqual({ open: utc('2026-09-22T00:00:00Z'), close: utc('2026-09-22T09:00:00Z') });
  });
});

describe('COMEX / Globex session', () => {
  it('is open overnight Sunday into Monday (CT)', () => {
    // Sun 2026-09-20 17:00 CDT = 22:00Z → Mon 16:00 CDT = 21:00Z
    const s = state('globex', '2026-09-21T02:00:00Z');
    expect(s.status).toBe('OPEN');
    expect(s.current).toEqual({ open: utc('2026-09-20T22:00:00Z'), close: utc('2026-09-21T21:00:00Z') });
  });

  it('is in the daily maintenance break between 16:00 and 17:00 CT', () => {
    const s = state('globex', '2026-09-22T21:30:00Z');
    expect(s.status).toBe('UPCOMING');
    expect(s.countdownMs).toBe(30 * 60 * 1000);
  });

  it('is CLOSED from Friday close until Sunday evening', () => {
    const s = state('globex', '2026-09-19T12:00:00Z'); // Saturday
    expect(s.status).toBe('CLOSED');
    expect(s.next.open).toBe(utc('2026-09-20T22:00:00Z'));
  });

  it('shifts by one UTC hour after US DST ends', () => {
    const s = state('globex', '2026-11-02T02:00:00Z'); // Sun Nov 1 evening, CST
    expect(s.current?.open).toBe(utc('2026-11-01T23:00:00Z'));
  });
});

describe('status, countdown and progress', () => {
  it('reports UPCOMING only inside the upcoming window', () => {
    expect(state('london', '2026-09-22T05:00:00Z').status).toBe('UPCOMING'); // opens 07:00Z, 2h away
    expect(state('london', '2026-09-22T02:00:00Z').status).toBe('CLOSED'); // 5h away
  });

  it('counts down to close while open and reports progress', () => {
    const s = state('london', '2026-09-22T11:30:00Z');
    expect(s.countdownMs).toBe(4.5 * 3600_000);
    expect(s.progress).toBeCloseTo(0.5, 5);
  });

  it('counts down to the next open while closed', () => {
    const s = state('london', '2026-09-22T17:00:00Z');
    expect(s.status).toBe('CLOSED');
    expect(s.countdownMs).toBe(14 * 3600_000);
    expect(s.progress).toBeNull();
  });

  it('lists intervals overlapping a window', () => {
    const ivs = getSessionIntervals(def('london'), utc('2026-09-21T00:00:00Z'), utc('2026-09-23T00:00:00Z'));
    expect(ivs.map((i) => new Date(i.open).toISOString())).toEqual(['2026-09-21T07:00:00.000Z', '2026-09-22T07:00:00.000Z']);
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0s'],
    [42_000, '42s'],
    [16 * 60_000 + 5_000, '16m 05s'],
    [(7 * 60 + 16) * 60_000, '7h 16m'],
    [(52 * 60) * 60_000, '2d 4h'],
    [-5000, '0s'],
  ])('%i ms → %s', (ms, out) => expect(formatCountdown(ms)).toBe(out));
});
