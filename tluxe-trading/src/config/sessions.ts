import type { SessionDefinition } from '../utils/sessions';

const MON_FRI = [1, 2, 3, 4, 5];

/**
 * Regular-hours session schedule. Each session is anchored to its own local
 * wall clock, so DST shifts are applied per region automatically.
 * Exchange holidays and early closes are NOT modelled in Phase 1.
 */
export const SESSIONS: SessionDefinition[] = [
  {
    id: 'asia',
    name: 'Asia',
    timeZone: 'Asia/Tokyo',
    open: { hour: 9, minute: 0 },
    close: { hour: 18, minute: 0 },
    openDays: MON_FRI,
    rule: '09:00–18:00 Tokyo',
  },
  {
    id: 'london',
    name: 'London',
    timeZone: 'Europe/London',
    open: { hour: 8, minute: 0 },
    close: { hour: 17, minute: 0 },
    openDays: MON_FRI,
    rule: '08:00–17:00 London',
  },
  {
    id: 'new-york',
    name: 'New York',
    shortName: 'NY',
    timeZone: 'America/New_York',
    open: { hour: 8, minute: 0 },
    close: { hour: 17, minute: 0 },
    openDays: MON_FRI,
    rule: '08:00–17:00 New York',
  },
  {
    // CME Globex metals: Sun–Fri 17:00–16:00 CT with a daily 60-minute break.
    id: 'globex',
    name: 'COMEX / Globex',
    shortName: 'Globex',
    timeZone: 'America/Chicago',
    open: { hour: 17, minute: 0 },
    close: { hour: 16, minute: 0 },
    openDays: [0, 1, 2, 3, 4],
    rule: 'Sun–Fri 17:00–16:00 CT',
  },
];

/** A closed session opening within this window is shown as UPCOMING. */
export const UPCOMING_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Session timeline window relative to now. */
export const TIMELINE_PAST_MS = 6 * 60 * 60 * 1000;
export const TIMELINE_FUTURE_MS = 18 * 60 * 60 * 1000;
