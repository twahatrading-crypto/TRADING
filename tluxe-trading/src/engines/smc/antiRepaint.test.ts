import { describe, expect, it } from 'vitest';
import type { Timeframe } from '../../types/market';
import { auditSmc } from './antiRepaint';
import { DEFAULT_SMC_SETTINGS } from './config';
import { SmcEngine, type SmcInput } from './engine';
import { aggregate, walk } from './fixtures/builders';
import * as S from './fixtures/scenarios';
import { analyzeSmcAt, smcKnowledgeTimes, smcKnownInput, type SmcDataset } from './knowledge';

/* TEST DATA ONLY — anti-repaint / replay parity on synthetic data (fuzzed with seeded random walks). */

const ds = (candles: SmcInput, instrumentId = 'XAUUSD'): SmcDataset => ({ instrumentId, tickSize: 0.01, settings: { ...DEFAULT_SMC_SETTINGS }, candles });

/** A consistent multi-timeframe dataset: M1 random walk aggregated to every higher timeframe. */
function mtfWalk(seed: number, minutes: number): SmcInput {
  const m1 = walk(minutes, { seed, start: 2400, vol: 0.8, tf: 'M1' });
  const out: SmcInput = { M1: m1 };
  for (const tf of ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as Timeframe[]) out[tf] = aggregate(m1, tf).slice(0, -1); // last bucket still forming
  return out;
}

describe('anti-repaint: incremental = clean recomputation at every knowledge time', () => {
  it('scenarios (every candle close): structure, BOS, CHOCH, FVG creation / fill, displacement, liquidity, dealing range', () => {
    for (const c of [S.bullishTrend(), S.bearishTrend(), S.range(), S.bullishReversal(), S.bearishReversal()]) {
      const r = auditSmc(ds({ M15: c }));
      expect(r.checks).toBe(c.length);
      expect(r.mismatches).toEqual([]);
      expect(r.leaks).toEqual([]);
      expect(r.mutations).toEqual([]);
    }
  });

  it('fuzz: random single-timeframe walks, several seeds, every close', () => {
    const seen = { BOS: 0, CHOCH: 0, fvg: 0, disp: 0 };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const c = walk(260, { seed, start: 100, vol: 1 });
      const fin = analyzeSmcAt(ds({ M15: c }), Infinity).byTimeframe.M15!;
      for (const b of fin.breaks) seen[b.kind] += 1;
      seen.fvg += fin.fvgs.length;
      seen.disp += fin.displacements.length;
      const r = auditSmc(ds({ M15: c }));
      expect(r.mismatches).toEqual([]);
      expect(r.leaks).toEqual([]);
      expect(r.mutations).toEqual([]);
    }
    // The fuzz really exercises the rules (not an empty engine).
    expect(Math.min(seen.BOS, seen.CHOCH, seen.fvg, seen.disp)).toBeGreaterThan(0);
  });

  it('fuzz: consistent seven-timeframe datasets incl. MTF aggregation (strided knowledge times)', () => {
    for (const seed of [11, 12]) {
      const d = ds(mtfWalk(seed, 3 * 24 * 60));
      const r = auditSmc(d, { stride: 37 });
      expect(r.checks).toBeGreaterThan(100);
      expect(r.mismatches).toEqual([]);
      expect(r.leaks).toEqual([]);
      expect(r.mutations).toEqual([]);
    }
  }, 120_000);

  it('no future leakage: analysis at K never changes when later candles are appended to the dataset', () => {
    const full = S.bullishReversal();
    const times = smcKnowledgeTimes(ds({ M15: full }));
    for (const K of [times[70]!, times[97]!, times[110]!]) {
      const a = analyzeSmcAt(ds({ M15: full }), K);
      const b = analyzeSmcAt(ds({ M15: full.filter((x) => x.time + 900 <= K) }), K);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('replay step-by-step = one-shot, and the last step equals the live engine', () => {
    const d = ds(mtfWalk(21, 2 * 24 * 60));
    const times = smcKnowledgeTimes(d);
    const e = new SmcEngine({ instrumentId: d.instrumentId, tickSize: d.tickSize, settings: d.settings });
    for (const K of times.filter((_, k) => k % 97 === 0)) e.update(smcKnownInput(d, K));
    const last = times[times.length - 1]!;
    e.update(smcKnownInput(d, last));
    const live = new SmcEngine({ instrumentId: d.instrumentId, tickSize: d.tickSize, settings: d.settings });
    live.update(d.candles);
    expect(JSON.stringify(e.snapshot('REPLAY'))).toBe(JSON.stringify(live.snapshot('REPLAY')));
  }, 60_000);
});
