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

/* The last date this table is asserted to cover. Past it every answer is
   UNKNOWN, and the producer withholds analysis rather than guessing.

   WHY 2026 AND NOT 2027. CME had not published a 2027 holiday schedule when
   this was written, so any 2027 date here would have been invention dressed as
   data. An earlier draft did carry 2027 rows; they are removed. The cost is
   explicit and deliberate: from 1 Jan 2027 this calendar answers UNKNOWN and GC
   analysis stops until the table is extended from CME's published schedule.
   That is the instructed behaviour - withhold on an unverifiable session - but
   it is a diary entry, not a background detail. */
const VALID_THROUGH = '2026-12-31';

/** Full closures - no GC session at all. From CME's 2026 holiday windows. */
const CLOSED = new Set([
  '2026-01-01',   // New Year's Day
  '2026-04-03',   // Good Friday - NYMEX/COMEX do not reopen after Thursday's close
  '2026-11-26',   // Thanksgiving
  '2026-12-25',   // Christmas
]);

/* Early closes. NOTE ON PRECISION: published sources disagree on the exact
   metals close time on these days - 13:00 ET, 13:30 CT, 12:45 CT and 12:30 CT
   all appear, and some are marked provisional. The exact minute is NOT relied
   on anywhere in this module. `earlyClose` is used only to lower the number of
   H1 candles a session is expected to contain, and that threshold is already
   set well below any of those variants, so a wrong minute cannot cause a false
   "incomplete session". The DATES are what matter here, and they agree. */
const EARLY_CLOSE = new Set([
  '2026-01-19',   // Martin Luther King Jr. Day
  '2026-02-16',   // Presidents' Day
  '2026-05-25',   // Memorial Day
  '2026-06-19',   // Juneteenth
  '2026-07-03',   // Independence Day observed
  '2026-09-07',   // Labor Day
  '2026-11-27',   // day after Thanksgiving
  '2026-12-24',   // Christmas Eve
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
    /* CALENDAR_EXPIRED is deliberately distinct from UNKNOWN. UNKNOWN would
       read as "something odd about this date"; this is a specific, fixable
       operational state with a named remedy - see HOW_TO_EXTEND below. The
       producer treats both as "withhold", but an operator reading the status
       learns which one they are looking at and what to do. */
    return { status: 'CALENDAR_EXPIRED', date, earlyClose: false,
             reason: `calendar verified only through ${VALID_THROUGH}; extend it from CME's published schedule`,
             remedy: HOW_TO_EXTEND };
  }
  /* Neither a Saturday nor a Sunday KEY is a trading session, and it is worth
     being precise about why, because the two are different:

       key = Saturday  spans Fri 18:00 -> Sat 17:00 ET. The week already closed
                       at Fri 17:00, so nothing trades in it.
       key = Sunday    spans Sat 18:00 -> Sun 17:00 ET. The week has not opened
                       yet - it opens Sun 18:00 ET, which belongs to MONDAY's
                       session day.

     An earlier version excluded only Saturday, on the mistaken assumption that
     a Sunday key could not occur. It can, and it was reported as TRADING, which
     would have made the producer treat a legitimately closed weekend as a data
     gap and withhold analysis every Monday. */
  const dow = new Date(dayKey).getUTCDay();         // key is a UTC-midnight date
  if (dow === 6) {
    return { status: 'WEEKEND', date, earlyClose: false, reason: 'Saturday - the week closed Friday 17:00 ET' };
  }
  if (dow === 0) {
    return { status: 'WEEKEND', date, earlyClose: false, reason: 'Sunday - the week opens 18:00 ET, which is Monday\'s session' };
  }
  if (CLOSED.has(date)) {
    return { status: 'HOLIDAY', date, earlyClose: false, reason: 'CME full closure' };
  }
  if (EARLY_CLOSE.has(date)) {
    return { status: 'TRADING', date, earlyClose: true, reason: 'CME early close (exact metals time disputed across sources)' };
  }
  return { status: 'TRADING', date, earlyClose: false, reason: '' };
}

/** Printed with a CALENDAR_EXPIRED status, and in /api/calendar. */
const HOW_TO_EXTEND = [
  'Open https://www.cmegroup.com/trading-hours.html and the COMEX metals holiday schedule.',
  'For each new year add FULL CLOSURES to CLOSED and shortened days to EARLY_CLOSE (ISO dates).',
  'Raise VALID_THROUGH to the last date you actually transcribed - never beyond it.',
  'Run bridge/gc-hlr/tests/producer.test.cjs; the calendar tests must stay green.',
  'Do not infer a date from missing candles: a feed outage looks identical to a holiday.',
].join(' ');

/**
 * SESSION COVERAGE - does what arrived actually SPAN the session?
 *
 * An earlier version judged completeness by counting candles and lowered the
 * count for an early close. That was wrong twice over, and the second way is
 * the dangerous one:
 *
 *   1. A count cannot distinguish "the exchange closed early" from "the feed
 *      dropped the last four hours". Both are simply fewer bars.
 *   2. Lowering the bar for a day already flagged earlyClose means a genuine
 *      outage ON an early-close day passes silently - precisely the day the
 *      check is least able to notice.
 *
 * So completeness is judged on BOUNDARIES and CONTIGUITY instead:
 *
 *   - the first candle must land near the session OPEN (18:00 ET, undisputed)
 *   - candles must be contiguous, allowing exactly one maintenance break
 *   - the last candle is REPORTED, never asserted against a disputed minute
 *
 * `earlyClose` therefore no longer relaxes any threshold. It only explains a
 * short tail in the report, so a human reads the right story.
 *
 * @returns {{ok:boolean, reason:string, firstGapMin:number|null, spanHours:number, lastBarEt:string|null}}
 */
function sessionCoverage(bars, dayKey, barMs) {
  const s = sessionStatus(dayKey);
  if (s.status !== 'TRADING') return { ok: false, reason: `not a trading session (${s.status})`, firstGapMin: null, spanHours: 0, lastBarEt: null };
  const b = sessionBounds(dayKey);
  const inside = bars.filter((x) => x.t >= b.start && x.t < b.end).sort((p, q) => p.t - q.t);
  if (!inside.length) {
    return { ok: false, reason: 'no candles inside the session window', firstGapMin: null, spanHours: 0, lastBarEt: null };
  }
  const OPEN_TOL = 2 * 3600000;        // the open is undisputed; allow two hours of thin start
  const startLag = inside[0].t - b.start;
  if (startLag > OPEN_TOL) {
    return { ok: false, reason: `first candle is ${Math.round(startLag / 60000)} min after the 18:00 ET open - the start of the session is missing`,
             firstGapMin: Math.round(startLag / 60000), spanHours: 0, lastBarEt: null };
  }
  /* Contiguity. One gap is allowed for the daily maintenance break; a second,
     or an oversized one, means data is missing rather than the market pausing.

     THE TOLERANCE MUST INCLUDE ONE BAR WIDTH. The break is 60 minutes of closed
     market, but it shows up as the DISTANCE BETWEEN BAR STARTS: with no 17:00
     H1 bar, 16:00 is followed by 18:00 - a two hour step. A flat 90 minute
     ceiling therefore rejected every ordinary session, and GC analysis would
     have been withheld permanently. Caught by the maintenance-break test. */
  const MAINT_MAX = barMs + 90 * 60000;
  let breaks = 0, worst = 0;
  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i].t - inside[i - 1].t;
    if (gap > barMs * 1.5) { breaks++; worst = Math.max(worst, gap); }
  }
  if (breaks > 1 || worst > MAINT_MAX) {
    return { ok: false, reason: `${breaks} interruption(s), largest ${Math.round(worst / 60000)} min - more than the single maintenance break`,
             firstGapMin: Math.round(worst / 60000), spanHours: 0, lastBarEt: null };
  }
  const last = inside[inside.length - 1];
  const p = nyParts(last.t);
  return {
    ok: true,
    reason: s.earlyClose ? 'early-close day: a short tail is expected' : '',
    firstGapMin: breaks ? Math.round(worst / 60000) : 0,
    spanHours: Math.round((last.t - inside[0].t) / 3600000),
    lastBarEt: `${String(p.h).padStart(2, '0')}:00 ET`,
  };
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
  nyParts, sessionDayKey, keyToIso, sessionStatus, sessionCoverage, sessionBounds, HOW_TO_EXTEND,
  _tables: { CLOSED, EARLY_CLOSE },
};
