import { describe, expect, it } from 'vitest';
import type { MapColumn } from './liquidityMap';
import { latestSession, SESSION_BREAK_MS, sessions } from './viewRange';

/* TEST DATA ONLY: recorded-valid intervals of hand-built columns (sizes do not matter here). */
const T0 = 1_800_000_000_000;
const col = (t: number, w: number, valid: number[]): MapColumn => ({ t, w, valid: Float64Array.from(valid), bidTicks: new Int32Array(), bidSizes: new Float64Array(), askTicks: new Int32Array(), askSizes: new Float64Array() });

describe('LIVE SESSION = the current continuous recorded-depth session', () => {
  it('nothing recorded -> no session (never invented)', () => {
    expect(latestSession([])).toBeNull();
  });
  it('a long hole starts a new session; the previous one ends where its recording ended (real outage boundary)', () => {
    const OUT = T0 + 3_600_000 + 844;
    const BACK = OUT + 25 * 3_600_000;
    const cols = [col(T0, 60_000, [T0, T0 + 60_000]), col(OUT - 844, 60_000, [OUT - 844, OUT]), col(BACK - 3_341, 60_000, [BACK, BACK - 3_341 + 60_000]), col(BACK + 56_659, 60_000, [BACK + 56_659, BACK + 116_659])];
    expect(latestSession(cols)).toEqual({ start: BACK, end: BACK + 116_659, prevEnd: OUT });
  });
  it('a short hole (redeploy blip) stays inside the session - it is still a hole in the data, only not a new session', () => {
    const cols = [col(T0, 10_000, [T0, T0 + 4_000, T0 + 11_000 - 1_000, T0 + 10_000]), col(T0 + 10_000, 10_000, [T0 + 10_000, T0 + 20_000])];
    expect(sessions(cols)).toEqual([[T0, T0 + 20_000]]);
    const far = [col(T0, 10_000, [T0, T0 + 10_000]), col(T0 + 10_000 + SESSION_BREAK_MS, 10_000, [T0 + 10_000 + SESSION_BREAK_MS, T0 + 20_000 + SESSION_BREAK_MS])];
    expect(sessions(far)).toHaveLength(2);
  });
});
