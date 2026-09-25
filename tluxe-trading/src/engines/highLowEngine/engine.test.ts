import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { auditHighLowEngine, normHLE } from './antiRepaint';
import { DEFAULT_HLE_SETTINGS, HLE_SCORE_WEIGHTS, HLE_TIMEFRAMES, type HLESettings } from './config';
import { hleDecision, isPreEntry, type HLEDecision } from './decision';
import { analyzeHighLow, HighLowEngine, mandatoryGates, type HLEInput } from './engine';
import { dataset, fromCloses, T0 } from './fixtures/builders';
import * as F from './fixtures/scenarios';
import { analyzeHLEAt, hleKnownInput, type HLEDataset } from './knowledge';
import { directionOf, inAsia, Tf } from './structure';
import type { HLESnapshot, Setup } from './types';

const S = (o: Partial<HLESettings> = {}): HLESettings => ({ ...DEFAULT_HLE_SETTINGS, ...o });
const run = (c: HLEInput, o: Partial<HLESettings> = {}) => analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S(o), candles: c });
const ds = (c: HLEInput, o: Partial<HLESettings> = {}): HLEDataset => ({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S(o), candles: c });
const DAY = 86400;
const D0 = F.coarseEnd(F.coarseH1());
/** The Previous Day Low (of day 0) setup the template trades on day 1. */
const pdl = (s: HLESnapshot) => s.setups.find((x) => x.levelType === 'PDL' && x.levelValidFrom === D0 + DAY) ?? null;
const pdh = (s: HLESnapshot) => s.setups.find((x) => x.levelType === 'PDH' && x.levelValidFrom === D0 + DAY) ?? null;
const at = (c: HLEInput, K: number, o: Partial<HLESettings> = {}) => analyzeHLEAt(ds(c, o), K, null);
const readyAt = (c: HLEInput) => pdl(run(c))!.entry!.knownAt;
const tfFrom = (bars: Candle[], k = 2) => {
  const t = new Tf(3600, k, 14);
  bars.forEach((b) => t.push(b));
  return t;
};
const bar = (time: number, o: number, h: number, l: number, c: number): Candle => ({ time, open: o, high: h, low: l, close: c, volume: null });

/* ------------------------------------------------------------------------------------------- */

describe('primitives (handoff §3)', () => {
  it('pivots need k STRICTLY lower / higher bars on both sides — an equal neighbour disqualifies; confirmed only after i + k closes', () => {
    const highs = [1, 2, 3, 5, 4, 3, 2, 3, 5, 5, 4, 3, 2];
    const bars = highs.map((h, i) => bar(i * 3600, h - 0.5, h, h - 1, h - 0.5));
    const t = tfFrom(bars);
    expect(t.highs.map((p) => p.index)).toEqual([3]); // the 5-5 twin top is not a pivot
    const early = tfFrom(bars.slice(0, 5));
    expect(early.highs).toEqual([]); // index 3 needs bars 4 AND 5
    expect(tfFrom(bars.slice(0, 6)).highs.map((p) => p.index)).toEqual([3]);
  });
  it('structureBias: last two swing highs + lows → BULLISH / BEARISH / RANGING / UNCLEAR / UNKNOWN; strength = agreeing share of the last ≤4 steps', () => {
    const zig = (pts: number[]) => {
      const closes: number[] = [];
      for (let k = 1; k < pts.length; k++) for (let s = 0; s < 4; s++) closes.push(pts[k - 1]! + ((pts[k]! - pts[k - 1]!) * (s + 1)) / 4);
      return fromCloses([pts[0]!, ...closes], T0, 3600, 0.1);
    };
    const up = directionOf(tfFrom(zig([100, 104, 101, 106, 103, 108, 105, 110, 107, 112, 109, 114, 111, 116, 113, 118, 115])), 60, 200);
    expect(up.raw).toBe('BULLISH');
    expect(up.structure).toBe('Higher High + Higher Low (last two swings)');
    expect(up.strength!.value).toBe(1);
    const down = directionOf(tfFrom(zig([118, 114, 117, 112, 115, 110, 113, 108, 111, 106, 109, 104, 107, 102, 105, 100, 103])), 60, 200);
    expect(down.raw).toBe('BEARISH');
    const mixed = directionOf(tfFrom(zig([100, 110, 102, 108, 101, 111, 103, 107, 100, 112, 101, 109, 99, 113, 102, 108, 100])), 60, 200);
    expect(['RANGING', 'BULLISH', 'BEARISH']).toContain(mixed.raw);
    if (mixed.raw === 'RANGING') expect(mixed.strength).toBeNull();
    expect(directionOf(tfFrom(zig([100, 104, 101])), 60, 200).bias).toBe('INSUFFICIENT_DATA');
    const flat = directionOf(tfFrom(fromCloses(Array(80).fill(100) as number[], T0, 3600, 0)), 60, 200);
    expect(flat.raw).toBe('UNCLEAR');
  });
  it('Asia session = Asia/Tokyo 09:00–18:00 on Tokyo weekdays (00:00–09:00 UTC; Tokyo has no DST)', () => {
    const mon = Date.UTC(2026, 0, 5) / 1000;
    expect(inAsia(mon, 9, 18)).toBe(true); // Mon 09:00 Tokyo
    expect(inAsia(mon + 8.75 * 3600, 9, 18)).toBe(true); // Mon 17:45 Tokyo
    expect(inAsia(mon + 9 * 3600, 9, 18)).toBe(false); // 18:00 Tokyo
    expect(inAsia(mon - 3600, 9, 18)).toBe(false); // Sun 23:00 UTC = Mon 08:00 Tokyo
    expect(inAsia(mon + 5 * DAY, 9, 18)).toBe(false); // Saturday 09:00 Tokyo
    expect(inAsia(mon + 4 * DAY + 2 * 3600, 9, 18)).toBe(true); // Friday 11:00 Tokyo
  });
});

describe('H4 direction — context only, never a gate', () => {
  it('BUY CONFIRMED against a BEARISH H4: counter-trend is allowed, labelled and scored lower (not blocked)', () => {
    const c = F.buyReversal();
    const snap = at(c, readyAt(c));
    expect(snap.h4.bias).toBe('BEARISH');
    const d = hleDecision(snap, 'LIVE');
    expect(d.signal).toBe('BUY_CONFIRMED');
    expect(d.setup!.context!.counterTrend).toBe(true);
    expect(d.conflicts.some((x) => /against this BUY/.test(x))).toBe(true);
    expect(d.setup!.score.components.htfAlignment).toBeLessThan(100);
  });
});

describe('H1 levels (closed candles only, validFrom causality)', () => {
  it('Previous Day High / Low = extremes of the previous UTC day, valid only from the END of that day', () => {
    const c = F.buyReversal();
    const h1 = c.H1!.filter((b) => b.time >= D0 && b.time < D0 + DAY);
    const snap = at(c, D0 + DAY + 3600);
    const lvl = snap.levels.find((l) => l.type === 'PDL' && l.validFrom === D0 + DAY)!;
    expect(lvl.price).toBe(Math.min(...h1.map((b) => b.low)));
    expect(snap.levels.find((l) => l.type === 'PDH' && l.validFrom === D0 + DAY)!.price).toBe(Math.max(...h1.map((b) => b.high)));
    expect(at(c, D0 + DAY - 60).levels.some((l) => l.type === 'PDL' && l.validFrom === D0 + DAY)).toBe(false);
  });
  it('previous day with fewer than 4 H1 bars → walks back to the last day that has them (≤ 7 days)', () => {
    const h1 = F.coarseH1();
    const last = h1[h1.length - 1]!.time;
    const gapDay = last + 3600; // start of the next UTC day
    const thin = fromCloses([102.7, 102.8, 102.9], gapDay, 3600, 0.3); // 3 bars only
    const next = fromCloses(Array(5).fill(103) as number[], gapDay + DAY, 3600, 0.3);
    const snap = run({ H1: [...h1, ...thin, ...next] });
    const pd = snap.levels.filter((l) => l.type === 'PDL' && l.retiredAt === null);
    expect(pd).toHaveLength(1);
    expect(pd[0]!.validFrom).toBe(gapDay); // the day BEFORE the 3-bar day
  });
  it('Asia High and Low become valid separately, each at the close of the M15 candle that set it; ties keep the earliest candle', () => {
    const c = F.buyReversal();
    const d1 = D0 + DAY;
    const snap = at(c, d1 + 9 * 3600);
    const hi = snap.levels.find((l) => l.type === 'ASIA_HIGH' && l.retiredAt === null)!;
    const lo = snap.levels.find((l) => l.type === 'ASIA_LOW' && l.retiredAt === null)!;
    const session = c.M15!.filter((b) => b.time >= d1 && b.time < d1 + 9 * 3600);
    const maxH = Math.max(...session.map((b) => b.high));
    const minL = Math.min(...session.map((b) => b.low));
    expect(hi.price).toBe(maxH);
    expect(lo.price).toBe(minL);
    expect(hi.validFrom).toBe(session.find((b) => b.high === maxH)!.time + 900);
    expect(lo.validFrom).toBe(session.find((b) => b.low === minL)!.time + 900);
  });
  it('a candle before a level’s validFrom can never sweep it (the classic "16:00 candle sweeps the next Asia low" bug)', () => {
    const snap = run(F.buyReversal());
    for (const s of snap.setups) expect(s.sweep.time).toBeGreaterThanOrEqual(s.levelValidFrom);
  });
  it('H1 pivot clusters: strict pivots chained within max(ATR × 0.15, price × 0.00015); the most-pivot cluster is the Major Swing, ≥2 pivots = Equal', () => {
    const snap = run(F.buyReversal());
    const swings = snap.levels.filter((l) => l.source === 'swing' && l.retiredAt === null);
    expect(swings.length).toBeGreaterThan(0);
    for (const kind of ['high', 'low'] as const) {
      const side = swings.filter((l) => l.kind === kind);
      if (!side.length) continue;
      const majors = side.filter((l) => l.major);
      expect(majors).toHaveLength(1);
      expect(majors[0]!.touches).toBe(Math.max(...side.map((l) => l.touches)));
    }
    for (const l of swings) {
      expect(l.touches).toBe(l.members.length);
      if (!l.major) expect(l.label).toBe(l.touches >= 2 ? `Equal ${l.kind === 'high' ? 'High' : 'Low'}s` : `Swing ${l.kind === 'high' ? 'High' : 'Low'}`);
    }
  });
  it('level rating = 0.30 kind + 0.22 touches + 0.20 reaction + 0.16 freshness + 0.12 untouched; bands 0.66 / 0.40', () => {
    for (const l of run(F.buyReversal()).levels) {
      const p = l.rating.parts;
      expect(l.rating.score).toBeCloseTo(0.3 * p.kind + 0.22 * p.touches + 0.2 * p.reaction + 0.16 * p.freshness + 0.12 * p.untouched, 10);
      expect(l.rating.label).toBe(l.rating.score >= 0.66 ? 'STRONG' : l.rating.score >= 0.4 ? 'MEDIUM' : 'WEAK');
      expect(p.untouched).toBe(l.state === 'ACTIVE' ? 1 : l.state === 'SWEPT' ? 0.5 : 0);
    }
  });
  it('G2 / R2: level state is judged with the tolerance frozen at validFrom — an ATR regime change never flips SWEPT back to ACTIVE', () => {
    const calm: number[] = [];
    for (let k = 0; k < 12; k++) calm.push(100.6, 100.8, 101.0, 101.2, 101.4, 101.2, 101.0, 100.8);
    const days = fromCloses(calm.slice(0, 72), T0, 3600, 0.05); // 3 calm UTC days
    const dayB = days.filter((b) => b.time >= T0 + DAY && b.time < T0 + 2 * DAY);
    const P = Math.min(...dayB.map((b) => b.low));
    const eng0 = new HighLowEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S() });
    eng0.update({ H1: days.slice(0, 48) });
    const tol0 = eng0.snapshot().levels.find((l) => l.type === 'PDL')!.tol;
    const wickT = T0 + 2 * DAY + 2 * 3600;
    const dayC: Candle[] = days.filter((b) => b.time >= T0 + 2 * DAY && b.time < T0 + 2 * DAY + 3 * 3600).map((b) => (b.time === wickT ? { ...b, low: P - 2 * tol0 } : b));
    // Same UTC day: a volatility regime 20× the calm one, lows far above the level.
    const wild = fromCloses(Array.from({ length: 18 }, (_, i) => (i % 2 ? 105.5 : 102.5)), T0 + 2 * DAY + 3 * 3600, 3600, 0.8);
    const e = new HighLowEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S() });
    e.update({ H1: [...days.slice(0, 48), ...dayC] });
    const before = e.snapshot().levels.find((l) => l.type === 'PDL' && l.validFrom === T0 + 2 * DAY)!;
    expect(before.state).toBe('SWEPT');
    e.update({ H1: [...days.slice(0, 48), ...dayC, ...wild] });
    const after = e.inspect().levels.find((l) => l.id === before.id)!;
    const nowAtr = e.snapshot().timeframes.H1.atr!;
    expect(before.penetration).toBeLessThan(0.15 * nowAtr); // today's tolerance would call this wick ACTIVE …
    expect(after.state).toBe('SWEPT'); // … but the decided state never changes
    expect(after.tol).toBe(before.tol);
    expect(after.sweptAt).toBe(before.sweptAt);
  });
});

describe('M15 liquidity — a sweep alone never confirms', () => {
  it('BUY: the first M15 bar ≥ 0.10 ATR below the level is the sweep; the run extreme is frozen at the reclaim close', () => {
    const s = pdl(run(F.buyReversal()))!;
    expect(s.sweep.penetrationAtr).toBeGreaterThanOrEqual(0.1);
    expect(s.sweep.extreme).toBeLessThan(s.level);
    expect(s.reclaim!.bars).toBeLessThanOrEqual(5);
    expect(s.reclaim!.price).toBeGreaterThan(s.level);
  });
  it('at the sweep instant the signal is WAITING (stage 2), never a confirmation', () => {
    const c = F.buyReversal();
    const s = pdl(run(c))!;
    const d = hleDecision(at(c, s.sweep.knownAt), 'LIVE');
    expect(d.confirmed).toBe(false);
    expect(d.tradeLevels).toBeNull();
    expect(d.stage).toBe(2);
  });
  it('a poke through the level by less than 0.10 × M15 ATR is not a sweep (the level is only touched)', () => {
    const snap = run(F.shallowPoke());
    expect(snap.setups.some((s) => s.levelType === 'PDL' && s.levelValidFrom === D0 + DAY)).toBe(false);
    expect(snap.levels.find((l) => l.type === 'PDL' && l.validFrom === D0 + DAY)!.touchedAt).not.toBeNull();
  });
  it('closed beyond and no reclaim within 4 M15 candles → LEVEL_BROKEN (stage 1, invalidated); it never reaches M5', () => {
    const s = pdl(run(F.breakNoReclaim()))!;
    expect(s.state).toBe('INVALIDATED');
    expect(s.code).toBe('LEVEL_BROKEN');
    expect(s.stage).toBe(1);
    expect(s.m5).toBeNull();
    expect(s.sweep.closedBeyond).toBe(true);
  });
  it('reclaimed but no M5 structure within 48 M15 candles → EXPIRED, logged (never a silent disappearance)', () => {
    const snap = run(F.reclaimNoM5());
    const s = pdl(snap)!;
    expect(s.state).toBe('EXPIRED');
    expect(s.m5).toBeNull();
    expect(snap.events.some((e) => e.type === 'SETUP_EXPIRED' && e.setupId === s.id)).toBe(true);
  });
  it('a level CONSUMED on H1 (close beyond its tolerance) invalidates the waiting setup and leaves the pool', () => {
    const snap = run(F.buyReversal());
    const consumed = snap.setups.filter((s) => s.code === 'LEVEL_CONSUMED');
    expect(consumed.length).toBeGreaterThan(0);
    for (const s of consumed) {
      expect(s.state).toBe('INVALIDATED');
      expect(snap.candidates.BUY.setupId === s.id || snap.candidates.SELL.setupId === s.id).toBe(false);
    }
  });
});

describe('M5 confirmation — closed candle, strict causality', () => {
  it('bullish CHOCH (prior M5 bias bearish) closes > swing + 0.05 × ATR; the swing formed after the sweep; displacement per formula', () => {
    const c = F.buyReversal();
    const s = pdl(run(c))!;
    const m5 = s.m5!;
    expect(m5.kind).toBe('CHOCH');
    expect(m5.preBias).not.toBe('BULLISH');
    expect(m5.preSweepSwing).toBe(false);
    expect(m5.close).toBeGreaterThan(m5.brokenLevel + 0.05 * m5.atr);
    expect(m5.swingTime).toBeGreaterThanOrEqual(s.sweep.time);
    const b = c.M5!.find((x) => x.time === m5.time)!;
    const body = Math.abs(b.close - b.open);
    expect(m5.displacement.bodyAtr).toBeCloseTo(body / m5.atr, 10);
    expect(m5.displacement.displaced).toBe(body / m5.atr >= 1 && body / (b.high - b.low) >= 0.5);
    expect(m5.knownAt).toBeGreaterThanOrEqual(s.reclaim!.knownAt);
  });
  it('the forming M5 candle cannot confirm: one minute before the break bar closes there is no confirmation', () => {
    const c = F.buyReversal();
    const m5 = pdl(run(c))!.m5!;
    expect(pdl(at(c, m5.time + 300 - 60))!.m5).toBeNull();
    expect(pdl(at(c, m5.time + 300))!.m5).not.toBeNull();
  });
  it('an M5 close back through the swept extreme before structure turns → STRUCTURE_FAILED (stage 2)', () => {
    const s = pdl(run(F.invalidatedBeforeEntry()))!;
    expect(s.state).toBe('INVALIDATED');
    expect(s.code).toBe('STRUCTURE_FAILED');
    expect(s.stage).toBe(2);
    expect(s.entry).toBeNull();
  });
});

describe('M1 entry — Fib band, frozen plan (R1), real targets only', () => {
  it('zone = [to − 0.786 × span, to − 0.5 × span] of the impulse from the swept extreme; SL = extreme − 0.15 × M5 ATR at the break', () => {
    const s = pdl(run(F.buyReversal()))!;
    const z = s.zone!;
    const span = z.impulseTo - z.impulseFrom;
    expect(z.impulseFrom).toBeLessThanOrEqual(s.sweep.extreme);
    expect(z.low).toBeCloseTo(z.impulseTo - 0.786 * span, 10);
    expect(z.high).toBeCloseTo(z.impulseTo - 0.5 * span, 10);
    expect(z.stop).toBeCloseTo(s.sweep.extreme - 0.15 * s.m5!.atr, 10);
    expect(z.definedAt).toBe(s.m5!.knownAt);
  });
  it('G1 / R1: Entry, SL, TP1, TP2, R and R:R are frozen at the pullback close and stay inside the zone while price moves on', () => {
    const c = F.buyReversal();
    const K = readyAt(c);
    const first = pdl(at(c, K))!;
    expect(first.state).toBe('ENTRY_READY');
    expect(first.risk!.entry).toBeGreaterThanOrEqual(first.zone!.low);
    expect(first.risk!.entry).toBeLessThanOrEqual(first.zone!.high);
    for (const dt of [60, 600, 1800, 3600]) {
      const later = pdl(at(c, K + dt))!;
      expect(later.risk).toEqual(first.risk);
      expect(later.score).toEqual(first.score);
      expect(later.score.frozen).toBe(true);
    }
  });
  it('TP1 / TP2 = nearest opposing levels (not consumed, valid by the entry, ≥ 0.25 R beyond the entry); R:R < 1.5 is reported only', () => {
    const c = F.buyReversal();
    const K = readyAt(c);
    const snap = at(c, K);
    const s = pdl(snap)!;
    const r = s.risk!;
    const eligible = snap.levels.filter((l) => l.kind === 'high' && l.retiredAt === null && l.state !== 'CONSUMED' && l.validFrom <= K && l.price > r.entry + 0.25 * r.risk).sort((a, b) => a.price - b.price);
    expect(r.tp1).toBe(eligible[0]!.price);
    expect(r.tp2).toBe(eligible[1]?.price ?? null);
    expect(r.rr1).toBeCloseTo((r.tp1 - r.entry) / r.risk, 10);
    expect(r.belowMinRR).toBe(r.rr1 < 1.5);
  });
  it('no opposing liquidity → NO_TARGET (stage 4): no entry is invented, trade levels withheld', () => {
    const snap = run(F.buyReversal(), { minTargetRisk: 1e6 });
    const s = pdl(snap)!;
    expect(['NO_TARGET', 'EXPIRED']).toContain(s.state);
    expect(s.risk).toBeNull();
    expect(snap.events.some((e) => e.type === 'NO_TARGET' && e.setupId === s.id)).toBe(true);
    expect(mandatoryGates(s).target).toBe(false);
  });
  it('G3 / R5: a confirmed M5 break with no pullback expires after 180 M1 bars (stage 3), logged', () => {
    const snap = run(F.confirmNoPullback());
    const s = pdl(snap)!;
    expect(s.state).toBe('EXPIRED');
    expect(s.stage).toBe(3);
    expect(s.m5).not.toBeNull();
    expect(s.entry).toBeNull();
    expect(snap.events.some((e) => e.type === 'SETUP_EXPIRED' && e.setupId === s.id)).toBe(true);
  });
  it('an M1 close through the SL after confirmation → INVALIDATED (STRUCTURE_FAILED, stage 3); the frozen plan remains for the record', () => {
    const s = pdl(run(F.stopAfterEntry()))!;
    expect(s.state).toBe('INVALIDATED');
    expect(s.code).toBe('STRUCTURE_FAILED');
    expect(s.risk).not.toBeNull();
  });
  it('M1 never sets direction: with no M5 structure, M1 pullbacks produce no entry', () => {
    const s = pdl(run(F.reclaimNoM5()))!;
    expect(s.entry).toBeNull();
    expect(s.risk).toBeNull();
  });
});

describe('the published signal (decision layer, handoff §9 invariants D1–D6)', () => {
  const c = F.buyReversal();
  const K = readyAt(c);
  const snap = at(c, K);
  it('D1/D2: confirmed ⇔ every mandatory boolean + stage 5 + LIVE feed; trade levels exist only when confirmed', () => {
    const live = hleDecision(snap, 'LIVE');
    expect(live.signal).toBe('BUY_CONFIRMED');
    expect(live.mandatory.every((m) => m.pass)).toBe(true);
    expect(live.tradeLevels!.entry).toBe(pdl(snap)!.risk!.entry);
    for (const feed of ['STALE', 'DISCONNECTED'] as const) {
      const d = hleDecision(snap, feed);
      expect(d.signal).toBe('WAITING');
      expect(d.code).toBe(feed === 'STALE' ? 'DATA_STALE' : 'DISCONNECTED');
      expect(d.confirmed).toBe(false);
      expect(d.tradeLevels).toBeNull();
    }
  });
  it('D5: the score never influences the signal (100/100 incomplete = not a trade; 0/100 complete = still confirmed)', () => {
    const early = at(c, pdl(run(c))!.m5!.knownAt);
    const boosted: HLESnapshot = { ...early, setups: early.setups.map((s) => ({ ...s, score: { ...s.score, total: 100 } })) };
    expect(hleDecision(boosted, 'LIVE').confirmed).toBe(false);
    const zero: HLESnapshot = { ...snap, setups: snap.setups.map((s) => ({ ...s, score: { ...s.score, total: 0 } })) };
    expect(hleDecision(zero, 'LIVE').signal).toBe('BUY_CONFIRMED');
  });
  it('D6: a low is not a buy — BUY only from a swept + reclaimed + M5-confirmed LOW; the level alone gives at most WATCHING', () => {
    const d = hleDecision(snap, 'LIVE');
    expect(snap.levels.find((l) => l.id === d.setup!.levelId)!.kind).toBe('low');
    const poke = run(F.shallowPoke());
    for (const feed of ['LIVE'] as const) expect(hleDecision(poke, feed).confirmed).toBe(false);
  });
  it('PRE-ENTRY is derived (M5 confirmed + zone, waiting for the pullback, live feed) — never a signal', () => {
    const d = hleDecision(at(c, pdl(run(c))!.m5!.knownAt), 'LIVE');
    expect(d.code).toBe('WAITING_PULLBACK');
    expect(isPreEntry(d)).toBe(true);
    expect(d.confirmed).toBe(false);
    expect(isPreEntry(hleDecision(at(c, pdl(run(c))!.m5!.knownAt), 'STALE'))).toBe(false);
  });
  it('NO_DATA until every timeframe has its documented minimum of closed candles (reason names the timeframe)', () => {
    const d = hleDecision(at(c, D0 + 3600), 'LIVE');
    expect(d.signal).toBe('NO_DATA');
    expect(d.why).toMatch(/need \d+ closed M15 candles, have \d+/);
  });
  it('both directions are always published (the losing side keeps its own blocker)', () => {
    expect(snap.candidates.BUY.side).toBe('BUY');
    expect(snap.candidates.SELL.side).toBe('SELL');
    expect(snap.candidates.SELL.code).not.toBe('NONE');
  });
  it('G11 gate mutation: removing any one mandatory piece of evidence from a confirmed setup un-confirms it', () => {
    const base = pdl(snap)!;
    const mutants: [string, (s: Setup) => Setup][] = [
      ['touch', (s) => ({ ...s, touch: null })],
      ['reclaim', (s) => ({ ...s, reclaim: null })],
      ['m5', (s) => ({ ...s, m5: null })],
      ['pullback', (s) => ({ ...s, entry: null })],
      ['target', (s) => ({ ...s, risk: null })],
      ['m5 before reclaim', (s) => ({ ...s, m5: { ...s.m5!, knownAt: s.reclaim!.knownAt - 1 } })],
      ['sweep before level', (s) => ({ ...s, sweep: { ...s.sweep, time: s.levelValidFrom - 900 } })],
    ];
    for (const [name, mut] of mutants) {
      const m: HLESnapshot = { ...snap, setups: snap.setups.map((s) => (s.id === base.id ? mut(s) : s)) };
      const d: HLEDecision = hleDecision(m, 'LIVE');
      expect(d.confirmed, `mutant "${name}" must not confirm`).toBe(false);
    }
  });
});

describe('BUY / SELL symmetry', () => {
  it('mirrored data yields the mirrored SELL setup with identical states, times, R:R and score (price-floor tolerance off)', () => {
    const o = { levelTolPrice: 0 };
    const b = pdl(run(F.buyReversal(), o))!;
    const s = pdh(run(F.sellReversal(), o))!;
    expect(s.side).toBe('SELL');
    expect(s.history.map((h) => [h.to, h.time])).toEqual(b.history.map((h) => [h.to, h.time]));
    expect(s.risk!.rr1).toBeCloseTo(b.risk!.rr1, 8);
    expect(s.risk!.entry).toBeCloseTo(300 - b.risk!.entry, 8);
    expect(s.score.total).toBe(b.score.total);
    expect(s.m5!.kind).toBe(b.m5!.kind);
  });
});

describe('score — descriptive, never a gate', () => {
  it('maxima total 100; points = round(fraction × max); total = Σ points', () => {
    expect(Object.values(HLE_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const s = pdl(run(F.buyReversal()))!;
    for (const [k, max] of Object.entries(HLE_SCORE_WEIGHTS)) expect(s.score.contributions[k as keyof typeof HLE_SCORE_WEIGHTS]).toBe(Math.round((s.score.components[k as keyof typeof HLE_SCORE_WEIGHTS] / 100) * max));
    expect(s.score.total).toBe(Object.values(s.score.contributions).reduce((a, b) => a + b, 0));
    expect(s.score.components.m5Structure).toBe(Math.round(((s.m5!.kind === 'CHOCH' ? 0.6 : 0.45) + (s.m5!.displacement.displaced ? 0.4 : 0)) * 100));
  });
});

describe('data integrity, determinism and anti-repaint', () => {
  it('G5: every setup that stopped being open has a logged INVALIDATED / EXPIRED event — nothing vanishes silently', () => {
    for (const f of [F.buyReversal, F.breakNoReclaim, F.reclaimNoM5, F.confirmNoPullback, F.invalidatedBeforeEntry, F.stopAfterEntry]) {
      const snap = run(f());
      for (const s of snap.setups.filter((x) => x.state === 'INVALIDATED' || x.state === 'EXPIRED'))
        expect(snap.events.some((e) => e.setupId === s.id && (e.type === 'SETUP_INVALIDATED' || e.type === 'SETUP_EXPIRED'))).toBe(true);
    }
  });
  it('deterministic, unique event ids; every event carries time / instrument / timeframe / type', () => {
    const a = run(F.buyReversal()).events;
    expect(run(F.buyReversal()).events).toEqual(a);
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
    for (const e of a) expect(e.instrumentId).toBe('XAUUSD');
  });
  it('incremental updates in any chunking equal one full run', () => {
    const c = F.buyReversal();
    const full = run(c);
    const e = new HighLowEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S() });
    const d = ds(c);
    const end = full.knowledgeTime!;
    for (let K = D0 - 3 * DAY; K < end; K += 7 * 3600 + 17 * 60) e.update(hleKnownInput(d, K));
    e.update(c);
    expect(normHLE(e.snapshot())).toBe(normHLE(full));
  });
  it('D3: truncating the feed at K changes nothing (no look-ahead) — incremental state at K ≡ clean recomputation at K', () => {
    const c = F.buyReversal();
    const d = ds(c);
    const e = new HighLowEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S() });
    const s = pdl(run(c))!;
    for (const K of [s.sweep.knownAt, s.reclaim!.knownAt, s.m5!.knownAt, s.entry!.knownAt, s.entry!.knownAt + 3600]) {
      e.update(hleKnownInput(d, K));
      expect(normHLE(e.snapshot())).toBe(normHLE(analyzeHLEAt(d, K, null)));
    }
  });
  it('G4 / R6: a broker revision of a processed CLOSED candle is detected, reported and rebuilt deterministically (never silent)', () => {
    const c = F.buyReversal();
    const e = new HighLowEngine({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: S() });
    expect(e.update(c).rebuilt).toBe(false);
    const idx = c.M15!.length - 5;
    const revised = { ...c, M15: c.M15!.map((b, i) => (i === idx ? { ...b, high: b.high + 0.5 } : b)) };
    const r = e.update(revised);
    expect(r.rebuilt).toBe(true);
    expect(r.revised).toEqual([{ tf: 'M15', time: c.M15![idx]!.time }]);
    expect(normHLE(e.snapshot())).toBe(normHLE(run(revised)));
  });
  it('duplicate and out-of-order candles are rejected and counted; results unchanged', () => {
    const c = F.buyReversal();
    const m1 = c.M1!;
    const dirty = { ...c, M1: [...m1.slice(0, 500), m1[499]!, m1[10]!, ...m1.slice(500)] };
    const snap = run(dirty);
    expect(snap.timeframes.M1.rejected).toBe(2);
    expect(pdl(snap)!.risk).toEqual(pdl(run(c))!.risk);
  });
  it('the full anti-repaint audit passes on the confirmed template (all 12 checks, incremental ≡ clean at checkpoints)', () => {
    const r = auditHighLowEngine({ ...ds(F.buyReversal()), checkpoints: 10 });
    expect(r.violations).toEqual([]);
    expect(r.entryReady).toBeGreaterThan(0);
  });
});

describe('G8 fuzz: random OHLC never breaks the invariants', () => {
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randomInput = (seed: number): HLEInput => {
    const r = rng(seed);
    const walk = (n: number, start: number, vol: number) => {
      const out = [start];
      for (let i = 1; i < n; i++) out.push(Math.max(10, out[i - 1]! + (r() - 0.5) * vol));
      return out;
    };
    const coarse = fromCloses(walk(24 * 14, 100, 1.2), T0, 3600, 0.3);
    const m1Start = coarse[coarse.length - 1]!.time + 3600;
    const m1 = walk(60 * 44, coarse[coarse.length - 1]!.close, 0.12).map((c, i, a) => {
      const o = i ? a[i - 1]! : c;
      return { time: m1Start + i * 60, open: o, high: Math.max(o, c) + r() * 0.08, low: Math.min(o, c) - r() * 0.08, close: c, volume: null } as Candle;
    });
    return dataset(coarse, m1);
  };
  it.each([1, 2, 3, 4, 5, 6])('seed %i: never throws; D1–D6 and stage ⇒ evidence hold for every feed state', (seed) => {
    const c = randomInput(seed);
    const snap = run(c);
    for (const s of snap.setups) {
      if (s.stage >= 2 || s.state === 'SWEPT') expect(s.sweep).toBeTruthy();
      if (['WAITING_M5', 'WAITING_M1', 'NO_TARGET', 'ENTRY_READY'].includes(s.state)) expect(s.reclaim).toBeTruthy();
      if (['WAITING_M1', 'NO_TARGET', 'ENTRY_READY'].includes(s.state)) expect(s.m5 && s.zone).toBeTruthy();
      if (s.state === 'ENTRY_READY') expect(Object.values(mandatoryGates(s)).every(Boolean)).toBe(true);
      const lvl = snap.levels.find((l) => l.id === s.levelId);
      if (lvl) expect(lvl.kind).toBe(s.side === 'BUY' ? 'low' : 'high');
    }
    for (const feed of ['LIVE', 'STALE', 'DISCONNECTED', 'REPLAY'] as const) {
      const d = hleDecision(snap, feed);
      expect(d.confirmed).toBe(d.mandatory.every((m) => m.pass) && d.stage >= 5 && (feed === 'LIVE' || feed === 'REPLAY') && !d.candidate?.invalidated);
      expect(d.tradeLevels !== null).toBe(d.confirmed);
    }
    for (const tf of HLE_TIMEFRAMES) expect(snap.timeframes[tf].bars).toBeGreaterThan(0);
  });
  it.each([7, 8])('seed %i: the anti-repaint audit passes on random data', (seed) => {
    expect(auditHighLowEngine({ ...ds(randomInput(seed)), checkpoints: 6 }).violations).toEqual([]);
  });
});
