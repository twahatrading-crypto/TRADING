import { describe, expect, it } from 'vitest';
import cjsSource from '../../../bridge/gc-hlr/lib/cme-calendar.cjs?raw';
import { CLOSED, dayBounds, dayInfo, EARLY_CLOSE, marketClock, previousTradingDate, previousWeekDates, sessionDate, VALID_THROUGH, weekMonday } from './cmeCalendar';

const t = (isoUtc: string) => Date.parse(isoUtc) / 1000;
const z = (sec: number) => new Date(sec * 1000).toISOString().replace('.000', '');

describe('CME session days (18:00 ET → 17:00 ET, DST via Intl)', () => {
  it('assigns 17:00 ET onwards to the next session day', () => {
    expect(sessionDate(t('2026-10-29T20:59:00Z'))).toBe('2026-10-29'); // 16:59 EDT
    expect(sessionDate(t('2026-10-29T22:00:00Z'))).toBe('2026-10-30'); // 18:00 EDT opens Friday's session
    expect(sessionDate(t('2026-11-01T23:00:00Z'))).toBe('2026-11-02'); // Sunday 18:00 EST opens Monday
  });

  it('session bounds follow the DST change on 1 Nov 2026', () => {
    expect(dayBounds('2026-10-30')).toEqual({ start: t('2026-10-29T22:00:00Z'), end: t('2026-10-30T21:00:00Z') });
    expect(dayBounds('2026-11-02')).toEqual({ start: t('2026-11-01T23:00:00Z'), end: t('2026-11-02T22:00:00Z') });
  });

  it('weekends, holidays and the previous trading day', () => {
    expect(dayInfo('2026-10-31').status).toBe('WEEKEND');
    expect(dayInfo('2026-11-01').status).toBe('WEEKEND');
    expect(dayInfo('2026-11-26').status).toBe('HOLIDAY');
    expect(dayInfo('2026-11-27')).toMatchObject({ status: 'TRADING', earlyClose: true });
    expect(previousTradingDate('2026-11-02').date).toBe('2026-10-30');
    expect(previousTradingDate('2026-11-27').date).toBe('2026-11-25'); // Thanksgiving skipped
  });

  it('previous CME week skips holidays', () => {
    expect(weekMonday('2026-11-27')).toBe('2026-11-23');
    expect(previousWeekDates('2026-12-02').dates).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']);
    expect(previousWeekDates('2026-11-02').dates).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
  });

  it('market clock: open, maintenance break, weekend, early close', () => {
    expect(marketClock(t('2026-10-30T14:00:00Z')).open).toBe(true);
    expect(marketClock(t('2026-10-29T21:30:00Z'))).toMatchObject({ open: false, reason: expect.stringMatching(/maintenance/i) });
    expect(marketClock(t('2026-10-31T12:00:00Z'))).toMatchObject({ open: false, status: 'WEEKEND' });
    expect(marketClock(t('2026-11-27T15:00:00Z')).open).toBe(true); // 10:00 EST
    expect(marketClock(t('2026-11-27T18:30:00Z')).open).toBe(false); // 13:30 EST, early close
  });

  it('fails safe past VALID_THROUGH: no guessing', () => {
    expect(dayInfo('2027-01-04').status).toBe('CALENDAR_EXPIRED');
    expect(previousTradingDate('2027-01-05').date).toBeNull();
    expect(previousWeekDates('2027-01-13').dates).toBeNull();
    expect(marketClock(t('2027-01-05T15:00:00Z'))).toMatchObject({ open: false, status: 'CALENDAR_EXPIRED' });
  });
});

describe('parity with the GC HLR producer calendar (bridge/gc-hlr/lib/cme-calendar.cjs)', () => {
  // The producer's own file, evaluated as CommonJS (it only uses Intl and Date).
  const mod = { exports: {} as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  new Function('module', 'exports', cjsSource)(mod, mod.exports);
  const cjs = mod.exports;

  it('same tables and validity date', () => {
    expect(VALID_THROUGH).toBe(cjs.VALID_THROUGH);
    expect([...CLOSED].sort()).toEqual([...cjs._tables.CLOSED].sort());
    expect([...EARLY_CLOSE].sort()).toEqual([...cjs._tables.EARLY_CLOSE].sort());
  });

  it('same session day and status for every hour of 2026', () => {
    for (let s = t('2026-01-01T00:00:00Z'); s < t('2027-01-03T00:00:00Z'); s += 3600) {
      const ours = sessionDate(s);
      const theirs = cjs.keyToIso(cjs.sessionDayKey(s * 1000));
      if (ours !== theirs) throw new Error(`session day differs at ${z(s)}: ${ours} vs ${theirs}`);
      const a = dayInfo(ours).status;
      const b = cjs.sessionStatus(cjs.sessionDayKey(s * 1000)).status;
      if (a !== b) throw new Error(`status differs at ${z(s)}: ${a} vs ${b}`);
    }
  });
});
