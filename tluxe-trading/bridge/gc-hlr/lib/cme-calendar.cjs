/* ============================================================================
   CME / COMEX GC trading calendar.

   WHY THIS EXISTS. An earlier draft inferred holidays from the data: "no candles
   for this day, therefore the market was shut." That is wrong and dangerous. A
   feed outage, a bad request, a rollover gap and a holiday all look identical
   from the candle side, so inferring the calendar from the data turns a DATA
   LOSS into a confident "market closed" and the dashboard would show a stale
   previous day as if it were real.

   This module separates the two:

       calendar says TRADING + candles missing  -> DATA GAP, withhold analysis
       calendar says HOLIDAY  + candles missing -> expected, skip the session
       calendar does not know                   -> UNKNOWN, withhold analysis

   HONESTY ABOUT THE TABLE BELOW. These dates are transcribed from CME Group's
   published holiday rules for COMEX metals. They are NOT machine-verified
   against CME's own calendar feed, and CME can amend them. The table therefore
   carries VALID_THROUGH, and every lookup past that date returns UNKNOWN rather
   than a guess - which makes the producer withhold instead of inventing a
   session. Extend the table deliberately, do not let it silently expire.

   SESSION MODEL. GC trades 18:00 ET (D-1) -> 17:00 ET (D), with a 60 minute
   break from 17:00 to 18:00 ET. An early close ends the session at 13:00 ET on
   the stated day. DST is resolved through Intl in America/New_York, never a
   fixed offset.
   ========================================================================= */
'use strict';

const NY = 'America/New_York';
const DAY = 86400000;

/** The last date this table is asserted to cover. Past it, every answer is UNKNOWN. */
const VALID_THROUGH = '2027-12-31';

/** Full closures - no GC session at all on these dates. */
const CLOSED = new Set([
  '2026-01-01', '2026-04-03', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-03-26', '2027-11-25', '2027-12-25',
]);

/** Early closes: the session ends at 13:00 ET instead of 17:00 ET. */
const EARLY_CLOSE_1300 = new Set([
  '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-27', '2026-12-24',
  '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-26', '2027-12-23', '2027-12-24',
]);

let _fmt = null;
function nyParts(ms) {
  if (!_fmt) {
    _fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: NY, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', weekday: 'short',
    });
  }
  const p = {};
  for (const part of _fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h: p.hour === '24' ? 0 : Number(p.hour),
    wd: p.weekday,
  };
}

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The CME session day a timestamp belongs to, as a UTC-midnight key. */
function sessionDayKey(ms) {
  const p = nyParts(ms);
  let key = Date.UTC(p.y, p.m - 1, p.d);
  if (p.h >= 17) key += DAY;      // 17:00 ET closes; 18:00 ET opens the next session day
  return key;
}

const keyToIso = (key) => new Date(key).toISOString().slice(0, 10);

/**
 * What the calendar says about one session day.
 * @returns {{status:'TRADING'|'HOLIDAY'|'WEEKEND'|'UNKNOWN', date:string, earlyClose:boolean, reason:string}}
 */
function sessionStatus(dayKey) {
  const date = keyToIso(dayKey);
  if (date > VALID_THROUGH) {
    return { status: 'UNKNOWN', date, earlyClose: false,
             reason: `calendar is only verified through ${VALID_THROUGH}` };
  }
  // Saturday has no GC session. Sunday's session belongs to Monday's session day,
  // so a Sunday KEY never occurs - the weekend test is Saturday only.
  const dow = new Date(dayKey).getUTCDay();         // key is a UTC-midnight date
  if (dow === 6) {
    return { status: 'WEEKEND', date, earlyClose: false, reason: 'Saturday - no GC session' };
  }
  if (CLOSED.has(date)) {
    return { status: 'HOLIDAY', date, earlyClose: false, reason: 'CME full closure' };
  }
  if (EARLY_CLOSE_1300.has(date)) {
    return { status: 'TRADING', date, earlyClose: true, reason: 'CME early close 13:00 ET' };
  }
  return { status: 'TRADING', date, earlyClose: false, reason: '' };
}

/**
 * Minimum H1 candles a completed session should contain.
 * A normal session is 23 hours of trading; an early close is 19.
 * Used to tell "short session" from "missing data", never to fabricate bars.
 */
function expectedMinBars(dayKey) {
  const s = sessionStatus(dayKey);
  if (s.status !== 'TRADING') return 0;
  return s.earlyClose ? 12 : 16;   // deliberately below the theoretical count: thin hours exist
}

/** Real start/end instants of a session day, DST included. */
function sessionBounds(dayKey) {
  const HOUR = 3600000;
  let start = null, end = null;
  for (let t = dayKey - 36 * HOUR; t <= dayKey + 36 * HOUR; t += HOUR) {
    if (sessionDayKey(t) === dayKey) { if (start === null) start = t; end = t + HOUR; }
  }
  return { start, end };
}

module.exports = {
  VALID_THROUGH, NY, DAY,
  nyParts, sessionDayKey, keyToIso, sessionStatus, expectedMinBars, sessionBounds,
  _tables: { CLOSED, EARLY_CLOSE_1300 },
};
