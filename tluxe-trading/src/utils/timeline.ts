import { getZonedParts } from './time';

const HOUR = 3_600_000;

/** Position (0–100) of an instant within [start, end], clamped. */
export function toPercent(t: number, start: number, end: number): number {
  return Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
}

/**
 * Tick instants on whole hours in `tz` that are multiples of `stepHours`.
 * Zones with a :30/:45 offset yield no ticks (whole UTC hours aren't whole local hours);
 * callers fall back to UTC ticks in that case.
 */
export function timelineTicks(start: number, end: number, tz: string, stepHours: number): number[] {
  const ticks: number[] = [];
  for (let t = Math.ceil(start / HOUR) * HOUR; t <= end; t += HOUR) {
    const p = getZonedParts(t, tz);
    if (p.minute === 0 && p.hour % stepHours === 0) ticks.push(t);
  }
  return ticks;
}
