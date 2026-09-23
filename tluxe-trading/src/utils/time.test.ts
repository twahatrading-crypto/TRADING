import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatUtcOffset,
  getTimeZoneOffsetMinutes,
  getZonedParts,
  isValidTimeZone,
  zonedTimeToUtc,
} from './time';

const utc = (s: string) => Date.parse(s);

describe('getTimeZoneOffsetMinutes', () => {
  it('returns fixed offsets for non-DST zones', () => {
    expect(getTimeZoneOffsetMinutes(utc('2026-01-15T00:00:00Z'), 'Asia/Yangon')).toBe(390);
    expect(getTimeZoneOffsetMinutes(utc('2026-07-15T00:00:00Z'), 'Asia/Yangon')).toBe(390);
    expect(getTimeZoneOffsetMinutes(utc('2026-07-15T00:00:00Z'), 'Asia/Kuala_Lumpur')).toBe(480);
    expect(getTimeZoneOffsetMinutes(utc('2026-07-15T00:00:00Z'), 'UTC')).toBe(0);
  });

  it('follows US daylight saving (2026: Mar 8 → Nov 1)', () => {
    expect(getTimeZoneOffsetMinutes(utc('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(getTimeZoneOffsetMinutes(utc('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
    expect(getTimeZoneOffsetMinutes(utc('2026-01-15T12:00:00Z'), 'America/Denver')).toBe(-420);
    expect(getTimeZoneOffsetMinutes(utc('2026-07-15T12:00:00Z'), 'America/Denver')).toBe(-360);
    // Transition instant: 2026-03-08 02:00 EST = 07:00Z
    expect(getTimeZoneOffsetMinutes(utc('2026-03-08T06:59:00Z'), 'America/New_York')).toBe(-300);
    expect(getTimeZoneOffsetMinutes(utc('2026-03-08T07:00:00Z'), 'America/New_York')).toBe(-240);
  });

  it('follows UK daylight saving (2026: Mar 29 → Oct 25)', () => {
    expect(getTimeZoneOffsetMinutes(utc('2026-03-29T00:59:00Z'), 'Europe/London')).toBe(0);
    expect(getTimeZoneOffsetMinutes(utc('2026-03-29T01:00:00Z'), 'Europe/London')).toBe(60);
    expect(getTimeZoneOffsetMinutes(utc('2026-10-25T00:59:00Z'), 'Europe/London')).toBe(60);
    expect(getTimeZoneOffsetMinutes(utc('2026-10-25T01:00:00Z'), 'Europe/London')).toBe(0);
  });
});

describe('formatUtcOffset', () => {
  it('formats whole, fractional, negative and zero offsets', () => {
    expect(formatUtcOffset(390)).toBe('UTC+6:30');
    expect(formatUtcOffset(480)).toBe('UTC+8');
    expect(formatUtcOffset(-360)).toBe('UTC−6');
    expect(formatUtcOffset(0)).toBe('UTC+0');
    expect(formatUtcOffset(345)).toBe('UTC+5:45');
  });
});

describe('zonedTimeToUtc', () => {
  it('converts wall time to UTC on both sides of DST', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 1, day: 15 }, 8, 0, 'America/New_York')).toBe(utc('2026-01-15T13:00:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 15 }, 8, 0, 'America/New_York')).toBe(utc('2026-07-15T12:00:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 9 }, 8, 0, 'America/New_York')).toBe(utc('2026-03-09T12:00:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 30 }, 8, 0, 'Europe/London')).toBe(utc('2026-03-30T07:00:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 27 }, 8, 0, 'Europe/London')).toBe(utc('2026-03-27T08:00:00Z'));
  });

  it('handles half-hour zones', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 9, day: 20 }, 11, 43, 'Asia/Yangon')).toBe(utc('2026-09-20T05:13:00Z'));
  });
});

describe('getZonedParts / addDays / isValidTimeZone', () => {
  it('reads wall-clock parts including weekday and midnight', () => {
    const p = getZonedParts(utc('2026-09-20T17:30:00Z'), 'Asia/Yangon');
    expect(p).toMatchObject({ year: 2026, month: 9, day: 21, hour: 0, minute: 0, weekday: 1 });
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1, weekday: 5 });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toMatchObject({ year: 2026, month: 2, day: 28 });
  });

  it('validates IANA zone names', () => {
    expect(isValidTimeZone('America/Denver')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
