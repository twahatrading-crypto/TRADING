import { describe, expect, it } from 'vitest';
import { timelineTicks, toPercent } from './timeline';

describe('timeline helpers', () => {
  it('clamps positions to 0–100', () => {
    expect(toPercent(50, 0, 100)).toBe(50);
    expect(toPercent(-10, 0, 100)).toBe(0);
    expect(toPercent(500, 0, 100)).toBe(100);
  });

  it('ticks on whole local hours in 3h steps', () => {
    const start = Date.parse('2026-09-22T00:00:00Z');
    const ticks = timelineTicks(start, start + 12 * 3600_000, 'UTC', 3);
    expect(ticks.map((t) => new Date(t).getUTCHours())).toEqual([0, 3, 6, 9, 12]);
  });

  it('yields no ticks for half-hour zones (caller falls back to UTC)', () => {
    const start = Date.parse('2026-09-22T00:00:00Z');
    expect(timelineTicks(start, start + 12 * 3600_000, 'Asia/Yangon', 3)).toEqual([]);
  });
});
