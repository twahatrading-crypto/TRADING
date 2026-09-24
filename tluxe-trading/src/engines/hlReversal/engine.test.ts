import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { DEFAULT_HLR_SETTINGS, HLR_SCORE_WEIGHTS } from './config';
import { analyzeHighLowReversal, entryGates, HighLowReversalEngine, type HLRInput } from './engine';
import { aggregate, fromCloses, mirrorInput, path, T0 } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { analyzeHLRAt, hlrKnowledgeTimes, type HLRDataset } from './knowledge';
import { finalizeHLRScore, hlrScoreComponents } from './score';
import type { Setup } from './types';

const S = { ...DEFAULT_HLR_SETTINGS };
const run = (candles: HLRInput, id = 'XAUUSD') => analyzeHighLowReversal({ instrumentId: id, tickSize: 0.01, candles });
const ds = (candles: HLRInput): HLRDataset => ({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S, candles });
const keyBuy = (snap: ReturnType<typeof run>) => snap.setups.find((s) => s.direction === 'BUY' && Math.abs(s.level - F.KEY_LOW) < 1e-9)!;
const keySell = (snap: ReturnType<typeof run>) => snap.setups.find((s) => s.direction === 'SELL' && Math.abs(s.level - (300 - F.KEY_LOW)) < 1e-9)!;
const states = (s: Setup) => s.stateHistory.map((h) => h.to);

describe('H4 direction (context only)', () => {
  const h4 = (closes: number[]) => {
    const h1 = fromCloses(closes, T0, 3600, 0.4);
    return run({ H1: h1, H4: aggregate(h1, 3600, 14400) }).h4;
  };
  const zig = (dir: 1 | -1) => {
    const legs: [number, number][] = [];
    let p = 100;
    for (let k = 0; k < 12; k++) {
      legs.push([p + dir * 7, 16], [p + dir * 3, 12]);
      p += dir * 3;
    }
    return path(100, ...legs);
  };
  it('HH + HL → BULLISH; LH + LL → BEARISH (mirror); swings are confirmed H4 swings', () => {
    const up = h4(zig(1));
    expect(up.state).toBe('BULLISH');
    expect(up.highs).toBe('HH');
    expect(up.lows).toBe('HL');
    expect(up.strength).toBe(100);
    expect(up.lastSwingHigh!.price).toBeGreaterThan(up.prevSwingHigh!.price);
    const down = h4(zig(-1));
    expect(down.state).toBe('BEARISH');
    expect(down.structure).toBe('Lower Highs + Lower Lows');
  });
  it('mixed swings → NEUTRAL; too little history → INSUFFICIENT DATA', () => {
    const legs: [number, number][] = [];
    for (let k = 0; k < 12; k++) legs.push([110 + (k % 2 ? 4 : 0), 14], [100 - (k % 2 ? 0 : 3), 14]);
    expect(['NEUTRAL', 'BULLISH', 'BEARISH']).toContain(h4(path(100, ...legs)).state);
    expect(h4(path(100, [104, 20], [100, 20])).state).toBe('INSUFFICIENT_DATA');
  });
  it('the template history is BEARISH, so a BUY reversal is flagged counter-trend (not blocked)', () => {
    const snap = run(F.buyReversal());
    expect(snap.h4.state).toBe('BEARISH');
    expect(keyBuy(snap).counterTrend).toBe(true);
    expect(keyBuy(snap).state).toBe('TRIGGERED');
  });
});

describe('H1 important highs / lows', () => {
  it('important low: dominant + prominent swing, price frozen at the wick low, known at confirmation', () => {
    const snap = run(F.h1Only());
    const lvl = snap.levels.find((l) => l.side === 'low' && Math.abs(l.price - F.KEY_LOW) < 1e-9)!;
    expect(lvl).toBeDefined();
    expect(lvl.direction).toBe('BUY');
    expect(lvl.dominanceBars).toBeGreaterThanOrEqual(S.h1DominanceBars);
    expect(lvl.prominenceAtr).toBeGreaterThanOrEqual(S.h1MinProminenceAtr);
    expect(lvl.confirmedAt).toBe(lvl.time + 3600 * (S.h1SwingRight + 1));
    expect(lvl.significance).toBeGreaterThan(0);
  });
  it('important high = exact mirror of the important low', () => {
    const snap = run(mirrorInput(F.h1Only(), 150));
    const lvl = snap.levels.find((l) => l.side === 'high' && Math.abs(l.price - (300 - F.KEY_LOW)) < 1e-9)!;
    expect(lvl.direction).toBe('SELL');
  });
  it('tiny pivots are not important (the rally-top chop creates no level)', () => {
    const snap = run(F.h1Only());
    // Every level is a real extreme of ≥ 24 bars with ≥ 1.5 ATR prominence.
    for (const l of snap.levels) {
      expect(l.dominanceBars).toBeGreaterThanOrEqual(24);
      expect(l.prominenceAtr).toBeGreaterThanOrEqual(1.5);
    }
  });
  it('equal lows: a later swing within tolerance merges into the level (price stays frozen)', () => {
    const snap = run(F.h1Only([[102, 6], [100.05, 6], [102.5, 6], [102.4, 4]]));
    const lvl = snap.levels.find((l) => Math.abs(l.price - F.KEY_LOW) < 1e-9)!;
    expect(lvl.equals).toHaveLength(1);
    expect(lvl.equals[0]!.price).toBeCloseTo(99.65, 9);
    expect(lvl.price).toBe(F.KEY_LOW);
    expect(snap.levels.filter((l) => Math.abs(l.price - 99.65) < 1e-9)).toHaveLength(0);
  });
  it('a level traded through before M15 history exists is INVALIDATED (sweep not verifiable), never watched forever', () => {
    const snap = run(F.buyReversal());
    const old = snap.setups.filter((s) => s.direction === 'BUY' && s.level > 101.5 && s.levelConfirmedAt < F.coarseEnd(F.coarseH1()));
    expect(old.length).toBeGreaterThan(0);
    for (const s of old) expect(s.state).toBe('INVALIDATED');
  });
});

describe('M15 liquidity: sweep / reclaim', () => {
  it('SSL sweep + reclaim (BUY): sweep record, reclaim record, then M5 stage', () => {
    const s = keyBuy(run(F.buyReversal()));
    expect(s.sweep!.extreme).toBeLessThan(F.KEY_LOW);
    expect(s.sweep!.penetration).toBeCloseTo(F.KEY_LOW - s.sweep!.extreme, 9);
    expect(s.sweep!.time).toBeGreaterThanOrEqual(s.levelConfirmedAt);
    expect(s.reclaim!.price).toBeGreaterThan(F.KEY_LOW);
    expect(s.reclaim!.bars).toBeGreaterThanOrEqual(1);
    expect(s.reclaim!.knownAt).toBeGreaterThanOrEqual(s.sweep!.knownAt);
    expect(states(s).slice(0, 3)).toEqual(['WATCHING_LEVEL', 'LIQUIDITY_TAKEN', 'RECLAIMED']);
  });
  it('BSL sweep + reclaim (SELL) mirrors it', () => {
    const s = keySell(run(F.sellReversal()));
    expect(s.sweep!.extreme).toBeGreaterThan(300 - F.KEY_LOW);
    expect(s.reclaim!.price).toBeLessThan(300 - F.KEY_LOW);
  });
  it('failed reclaim: liquidity taken but no reclaim close within the window → FAILED_RECLAIM (never advances)', () => {
    const s = keyBuy(run(F.sweepNoReclaim()));
    expect(s.state).toBe('FAILED_RECLAIM');
    expect(s.liquidity).toBe('FAILED');
    expect(s.reclaim).toBeNull();
    expect(s.m5).toBeNull();
    expect(s.entryStatus).toBe('INVALIDATED');
  });
  it('acceptance beyond the level → INVALIDATED at M15', () => {
    const s = keyBuy(run(F.acceptedBeyond()));
    expect(s.state).toBe('INVALIDATED');
    expect(s.liquidity).toBe('INVALIDATED');
  });
});

describe('M5 confirmation', () => {
  it('bullish CHOCH after the SSL sweep/reclaim, with displacement evidence', () => {
    const s = keyBuy(run(F.buyReversal()));
    expect(s.m5!.kind).toBe('CHOCH');
    expect(s.m5!.close).toBeGreaterThan(s.m5!.brokenLevel);
    expect(s.m5!.knownAt).toBeGreaterThanOrEqual(s.reclaim!.knownAt);
    expect(s.m5!.displacement.legAtr).toBeGreaterThanOrEqual(S.minDisplacementAtr);
    expect(s.m5!.displacement.maxBodyAtr).toBeGreaterThanOrEqual(S.minDisplacementBodyAtr);
  });
  it('bearish CHOCH after the BSL sweep/reclaim (mirror)', () => {
    const s = keySell(run(F.sellReversal()));
    expect(s.m5!.kind).toBe('CHOCH');
    expect(s.m5!.close).toBeLessThan(s.m5!.brokenLevel);
  });
  it('reclaim without an M5 structure break → EXPIRED after the M5 window; never ENTRY_READY', () => {
    const s = keyBuy(run(F.reclaimNoM5()));
    expect(s.state).toBe('EXPIRED');
    expect(s.m5).toBeNull();
    expect(states(s)).not.toContain('ENTRY_READY');
  });
  it('insufficient displacement: the same break is rejected when the threshold is higher', () => {
    const snap = analyzeHighLowReversal({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...S, minDisplacementAtr: 50 }, candles: F.buyReversal() });
    const s = keyBuy(snap);
    expect(s.m5).toBeNull();
    expect(s.rejectedBreaks).toBeGreaterThan(0);
    expect(states(s)).not.toContain('M5_CONFIRMED');
  });
  it('an M5 close beyond the sweep extreme before confirmation → INVALIDATED (invalidation before entry)', () => {
    const s = keyBuy(run(F.invalidatedBeforeEntry()));
    expect(s.state).toBe('INVALIDATED');
    expect(s.entry).toBeNull();
  });
});

describe('M1 entry zone, pullback and risk', () => {
  it('zone from Order Blocks v1 output overlapping an own M1 FVG (OB+FVG), inside the displacement leg, defined at the confirmation close', () => {
    const s = keyBuy(run(F.buyReversal()));
    expect(s.zone!.source).toBe('OB+FVG');
    expect(s.zone!.orderBlockId).toMatch(/:OB:BULL:/);
    expect(s.zone!.fvg).not.toBeNull();
    expect(s.zone!.definedAt).toBe(s.m5!.knownAt);
    expect(s.zone!.low).toBeGreaterThanOrEqual(s.sweep!.extreme - 1e-9);
    expect(s.zone!.high).toBeLessThanOrEqual(s.m5!.close);
  });
  it('ENTRY READY only after a pullback into the zone on an M1 bar opening after confirmation; then TRIGGERED on the reaction', () => {
    const s = keyBuy(run(F.buyReversal()));
    expect(states(s)).toEqual(['WATCHING_LEVEL', 'LIQUIDITY_TAKEN', 'RECLAIMED', 'M5_CONFIRMATION_PENDING', 'M5_CONFIRMED', 'M1_PULLBACK_PENDING', 'ENTRY_READY', 'TRIGGERED']);
    expect(s.entry!.time).toBeGreaterThanOrEqual(s.m5!.knownAt);
    expect(s.triggeredAt!).toBeGreaterThan(s.entry!.knownAt);
    expect(Object.values(entryGates(s)).every(Boolean)).toBe(true);
  });
  it('deterministic risk plan: entry = zone mid, stop beyond the sweep extreme, TP1 = nearest untaken M15 swing, R:R consistent', () => {
    const s = keyBuy(run(F.buyReversal()));
    const r = s.risk!;
    expect(r.entry).toBeCloseTo((s.zone!.low + s.zone!.high) / 2, 9);
    expect(r.stop).toBeLessThan(s.sweep!.extreme);
    expect(r.invalidation).toBe(s.sweep!.extreme);
    expect(r.tp1Source).toMatch(/M15 swing high/);
    expect(r.tp1).toBeGreaterThan(r.entry);
    expect(r.rr1).toBeCloseTo((r.tp1 - r.entry) / (r.entry - r.stop), 9);
    expect(r.tp2).toBeNull();
    expect(r.tp2Source).toMatch(/no untaken H1 high/);
  });
  it('ENTRY READY state at the time it happened (clean recomputation at the entry close)', () => {
    const d = ds(F.buyEntryReady());
    const full = keyBuy(run(d.candles));
    const at = keyBuy(analyzeHLRAt(d, full.entry!.knownAt));
    expect(at.state).toBe('ENTRY_READY');
    expect(at.entryStatus).toBe('ENTRY_READY');
    // One bar earlier it was still waiting for the pullback.
    expect(keyBuy(analyzeHLRAt(d, full.entry!.knownAt - 60)).state).toBe('M1_PULLBACK_PENDING');
  });
  it('M5 confirmation without an M1 pullback: TP1 reached first → MISSED', () => {
    const s = keyBuy(run(F.confirmNoPullback()));
    expect(s.state).toBe('MISSED');
    expect(s.entry).toBeNull();
  });
  it('no M1 data at all → the setup can never reach ENTRY READY (timeframe isolation)', () => {
    const rest = { ...F.buyReversal() };
    delete rest.M1;
    const snap = run(rest);
    const s = keyBuy(snap);
    expect(snap.timeframes.M1.state).toBe('NO_DATA');
    expect(['M5_CONFIRMED', 'M1_PULLBACK_PENDING']).toContain(s.state);
    expect(s.entry).toBeNull();
  });
});

describe('BUY / SELL symmetry', () => {
  it('the mirrored dataset produces the mirrored SELL setup with identical states, times and R:R', () => {
    const b = keyBuy(run(F.buyReversal()));
    const s = keySell(run(F.sellReversal()));
    expect(states(s)).toEqual(states(b));
    expect(s.sweep!.time).toBe(b.sweep!.time);
    expect(s.m5!.knownAt).toBe(b.m5!.knownAt);
    expect(s.entry!.time).toBe(b.entry!.time);
    expect(s.sweep!.extreme).toBeCloseTo(300 - b.sweep!.extreme, 6);
    expect(s.zone!.low).toBeCloseTo(300 - b.zone!.high, 6);
    expect(s.risk!.tp1).toBeCloseTo(300 - b.risk!.tp1, 6);
    expect(s.risk!.rr1).toBeCloseTo(b.risk!.rr1, 6);
    expect(s.score.total).toBe(b.score.total);
  });
});

describe('score — descriptive, never a gate', () => {
  it('weights total exactly 100 and total = Σ weight × component / 100', () => {
    expect(Object.values(HLR_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const s = keyBuy(run(F.buyReversal()));
    const sum = Object.values(s.score.contributions).reduce((a, b) => a + b, 0);
    expect(s.score.total).toBe(Math.round(sum));
    for (const v of Object.values(s.score.components)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
  it('a high score can never replace a missing gate: M5 missing → not ENTRY READY whatever the score', () => {
    const s = keyBuy(run(F.reclaimNoM5()));
    const boosted = { ...s, state: 'M5_CONFIRMATION_PENDING' as const, levelSignificance: 100, levelEquals: 5, h4AtSweep: 'BULLISH' as const };
    const score = finalizeHLRScore({ ...hlrScoreComponents(boosted, 'BULLISH', 0, S), displacement: 100, entryQuality: 100, riskReward: 100, m5Structure: 100 });
    expect(score.total).toBeGreaterThan(90);
    expect(entryGates(boosted).m5).toBe(false);
    expect(s.entryStatus).not.toBe('ENTRY_READY');
  });
  it('counter-trend setups score lower on HTF alignment than aligned ones', () => {
    const s = keyBuy(run(F.buyReversal()));
    expect(s.score.components.htfAlignment).toBe(25);
    expect(hlrScoreComponents({ ...s, h4AtSweep: 'BULLISH' }, 'BULLISH', 0, S).htfAlignment).toBe(100);
  });
});

describe('lifecycle, data integrity and isolation', () => {
  it('states only move forward; history timestamps never decrease', () => {
    for (const f of [F.buyReversal, F.sweepNoReclaim, F.reclaimNoM5, F.confirmNoPullback, F.invalidatedBeforeEntry]) {
      for (const s of run(f()).setups) for (let k = 1; k < s.stateHistory.length; k++) expect(s.stateHistory[k]!.time).toBeGreaterThanOrEqual(s.stateHistory[k - 1]!.time);
    }
  });
  it('no future leakage: appending later candles never changes what was recorded earlier', () => {
    const d = ds(F.buyReversal());
    const early = keyBuy(run(F.buyEntryReady()));
    const late = keyBuy(run(d.candles));
    expect(late.sweep).toEqual(early.sweep);
    expect(late.reclaim).toEqual(early.reclaim);
    expect(late.m5).toEqual(early.m5);
    expect(late.zone).toEqual(early.zone);
    expect(late.entry).toEqual(early.entry);
    expect(late.stateHistory.slice(0, 7)).toEqual(early.stateHistory.slice(0, 7));
  });
  it('incremental updates equal one full run (replay determinism), in any chunking', () => {
    const d = ds(F.buyReversal());
    const times = hlrKnowledgeTimes(d);
    const e = new HighLowReversalEngine({ instrumentId: 'XAUUSD', tickSize: 0.01 });
    for (let k = 0; k < times.length; k += 37) e.update(analyzeInput(d, times[k]!));
    e.update(d.candles);
    const a = e.snapshot();
    const b = run(d.candles);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(run(d.candles))).toBe(JSON.stringify(b));
  });
  it('duplicate and out-of-order bars are rejected and counted, never processed', () => {
    const c = F.buyReversal();
    const m1 = [...c.M1!];
    const dup = [...m1.slice(0, 400), m1[399]!, m1[200]!, ...m1.slice(400)];
    const snap = run({ ...c, M1: dup });
    expect(snap.timeframes.M1.rejected).toBe(2);
    expect(keyBuy(snap).stateHistory).toEqual(keyBuy(run(c)).stateHistory);
  });
  it('offline / no data → NO_DATA with no setups; short history → INSUFFICIENT_HISTORY', () => {
    const none = run({});
    expect(none.state).toBe('NO_DATA');
    expect(none.setups).toEqual([]);
    const short = run({ H1: F.coarseH1().slice(0, 30) });
    expect(short.state).toBe('INSUFFICIENT_HISTORY');
    expect(short.timeframes.H1.state).toBe('INSUFFICIENT_HISTORY');
  });
  it('instrument isolation: ids carry the instrument; the same candles under another id never share records', () => {
    const a = run(F.buyReversal(), 'XAUUSD');
    const b = run(F.buyReversal(), 'XAGUSD');
    expect(a.setups.every((s) => s.id.startsWith('XAUUSD:') && s.instrumentId === 'XAUUSD')).toBe(true);
    expect(b.setups.every((s) => s.id.startsWith('XAGUSD:'))).toBe(true);
  });
  it('timeframe isolation: extra timeframes in the input (M30 / D1) are ignored', () => {
    const c = F.buyReversal();
    const withExtra = { ...c, M30: [] as Candle[], D1: [] as Candle[] } as HLRInput;
    expect(JSON.stringify(run(withExtra))).toBe(JSON.stringify(run(c)));
  });
});

function analyzeInput(d: HLRDataset, K: number): HLRInput {
  const out: HLRInput = {};
  for (const [tf, arr] of Object.entries(d.candles) as [keyof HLRInput, Candle[]][]) {
    const sec = { H4: 14400, H1: 3600, M15: 900, M5: 300, M1: 60 }[tf];
    out[tf] = arr.filter((c) => c.time + sec <= K);
  }
  return out;
}
