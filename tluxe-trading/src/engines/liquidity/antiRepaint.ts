import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import type { LiquiditySettings } from './config';
import { LiquidityTimeframeEngine } from './engine';
import type { LiquidityPool, LiquiditySnapshot, LiquiditySwing, SweepEvent } from './types';

/* ============================================================================
 * Liquidity anti-repaint audit (one timeframe). Used by tests and by the in-app
 * "Verify no-repaint" button on loaded candles. The history is replayed one
 * CLOSED bar at a time; the state after N bars is compared with a brand-new
 * engine on bars 1…N and with the final full-history result:
 *
 *  L1  prefix equivalence   incremental at N === fresh engine on slice(0, N) (everything, incl. scores)
 *  L2  swing confirmation   confirmed exactly swingRight bars after the swing bar, never earlier
 *  L3  pool birth           never visible before its confirming bar; once READY, exactly at that bar
 *  L4  frozen identity      id / side / createdAt / confirmedAt / tolerance never change
 *  L5  contributions        at N === full-run contributions confirmed ≤ T(N); level/range derived from them
 *  L6  tests                at N === full-run tests that started ≤ T(N)
 *  L7  sweeps               at N === full-run sweeps that happened ≤ T(N) (same id/time/kind/level/close);
 *                           a decided outcome, its time and a reclaim never change later
 *  L8  state history        at N === full-run history up to T(N) (states may progress, never be rewritten)
 *  L9  knowability          every timestamp at N ≤ T(N)
 *  L10 causality            sweeps after the pool existed; reclaim only within the window after a sweep;
 *                           CONSUMED only from an accepted sweep; INVALIDATED only from FORMING
 * ========================================================================== */

export interface LiquidityAuditInput {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  candles: readonly Candle[];
  tickSize: number;
  settings: LiquiditySettings;
  checkpoints?: number;
  /** Test hook: engine under audit. */
  createEngine?: (o: EngineOpts) => AuditableLiquidityEngine;
}

type EngineOpts = { instrumentId: InstrumentId; timeframe: Timeframe; tickSize: number; settings: LiquiditySettings };
export interface AuditableLiquidityEngine {
  update(c: readonly Candle[], o: { lastBarClosed: boolean }): void;
  snapshot(): LiquiditySnapshot;
}

export interface LiquidityAuditResult {
  timeframe: Timeframe;
  bars: number;
  checkpoints: number;
  pools: number;
  equalPools: number;
  tests: number;
  sweeps: number;
  reclaims: number;
  consumed: number;
  violations: string[];
}

const MAX = 50;
const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);
const j = (v: unknown) => JSON.stringify(v);

export function auditLiquidity(input: LiquidityAuditInput): LiquidityAuditResult {
  const { candles, settings, timeframe } = input;
  const opts: EngineOpts = { instrumentId: input.instrumentId, timeframe, tickSize: input.tickSize, settings };
  const make = input.createEngine ?? ((o: EngineOpts) => new LiquidityTimeframeEngine(o));
  const fresh = (c: readonly Candle[]) => {
    const e = make(opts);
    e.update(c, { lastBarClosed: true });
    return e.snapshot();
  };
  const v: string[] = [];
  const fail = (m: string) => v.length < MAX && v.push(m);

  const full = fresh(candles);
  const fullPools = new Map(full.pools.map((p) => [p.id, p]));
  for (const s of full.swings) checkSwing(s, candles, settings, fail);
  for (const p of full.pools) checkCausality(p, candles, settings, fail);

  const n = candles.length;
  const want = Math.max(1, input.checkpoints ?? 24);
  const at = new Set<number>();
  for (let k = 1; k <= want; k++) at.add(Math.max(1, Math.round((n * k) / want)));

  const engine = make(opts);
  const seen = new Set<string>();
  let wasReady = false;
  let checkpoints = 0;
  for (let step = 1; step <= n; step++) {
    const prefix = candles.slice(0, step);
    engine.update(prefix, { lastBarClosed: true });
    const snap = engine.snapshot();
    const t = candles[step - 1]!.time;
    for (const p of snap.pools) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.confirmedAt > t) fail(`L3 ${p.id} visible at ${iso(t)} before confirmation ${iso(p.confirmedAt)}`);
      else if (p.confirmedAt < t && wasReady) fail(`L3 ${p.id} confirmed ${iso(p.confirmedAt)} but only visible at ${iso(t)}`);
    }
    wasReady = snap.state === 'READY';
    if (at.has(step) && snap.state === 'READY') {
      checkpoints += 1;
      if (j(snap) !== j(fresh(prefix))) fail(`L1 step ${step} (${iso(t)}): incremental state differs from a fresh run on the prefix`);
      compare(snap, full, fullPools, t, fail);
    }
  }

  const sweeps = full.pools.flatMap((p) => p.sweeps);
  return {
    timeframe,
    bars: n,
    checkpoints,
    pools: full.pools.filter((p) => p.state !== 'FORMING' && p.state !== 'INVALIDATED').length,
    equalPools: full.pools.filter((p) => p.source === 'equal').length,
    tests: full.pools.reduce((a, p) => a + p.tests.length, 0),
    sweeps: sweeps.length,
    reclaims: sweeps.filter((e) => e.reclaimed).length,
    consumed: full.pools.filter((p) => p.state === 'CONSUMED').length,
    violations: v,
  };
}

function checkSwing(s: LiquiditySwing, candles: readonly Candle[], st: LiquiditySettings, fail: (m: string) => void) {
  if (s.confirmedIndex - s.index !== st.swingRight) fail(`L2 ${s.id} confirmed ${s.confirmedIndex - s.index} bars after the swing (needs ${st.swingRight})`);
  if (candles[s.confirmedIndex]?.time !== s.confirmedAt) fail(`L2 ${s.id} confirmedAt is not the confirming bar`);
  if (candles[s.index]?.time !== s.time) fail(`L2 ${s.id} time is not the swing bar`);
}

function checkCausality(p: LiquidityPool, candles: readonly Candle[], st: LiquiditySettings, fail: (m: string) => void) {
  const idx = new Map(candles.map((c, i) => [c.time, i]));
  for (const e of p.sweeps) {
    if (e.time <= p.confirmedAt) fail(`L10 ${e.id} sweep on/before the pool was confirmed`);
    const bar = candles[idx.get(e.time)!]!;
    const beyond = p.side === 'BSL' ? bar.high > e.level + p.tolerance : bar.low < e.level - p.tolerance;
    if (!beyond) fail(`L10 ${e.id} sweep bar did not trade beyond the pool`);
    if (e.reclaimed) {
      const k = idx.get(e.reclaimTime!)! - idx.get(e.time)!;
      const close = candles[idx.get(e.reclaimTime!)!]!.close;
      if (k < 0 || k > st.reclaimWindowBars || e.barsToReclaim !== k) fail(`L10 ${e.id} reclaim outside the window`);
      if (p.side === 'BSL' ? close > e.level : close < e.level) fail(`L10 ${e.id} reclaim close is not back on the resting side`);
    }
  }
  const consumed = p.stateHistory.find((h) => h.to === 'CONSUMED');
  if (consumed && !p.sweeps.some((e) => e.outcome === 'accepted' && e.acceptedTime === consumed.time)) fail(`L10 ${p.id} CONSUMED without an accepted sweep`);
  const inv = p.stateHistory.find((h) => h.to === 'INVALIDATED');
  if (inv && p.stateHistory.some((h) => h.to === 'ACTIVE' || h.to === 'SWEPT')) fail(`L10 ${p.id} INVALIDATED after it had qualified`);
}

function compare(snap: LiquiditySnapshot, full: LiquiditySnapshot, fullPools: Map<string, LiquidityPool>, t: number, fail: (m: string) => void) {
  if (j(full.swings.filter((s) => s.confirmedAt <= t)) !== j(snap.swings)) fail(`L2 swings at ${iso(t)} differ from full-run swings confirmed by then`);
  for (const p of snap.pools) {
    const f = fullPools.get(p.id);
    if (!f) {
      fail(`L4 ${p.id} known at ${iso(t)} disappears later`);
      continue;
    }
    for (const k of ['side', 'createdAt', 'confirmedAt', 'confirmedIndex', 'tolerance', 'atrAtConfirmation'] as const) if (p[k] !== f[k]) fail(`L4 ${p.id} ${k} changed after ${iso(t)}`);
    const fc = f.contributions.filter((c) => c.confirmedAt <= t);
    if (j(fc) !== j(p.contributions)) fail(`L5 ${p.id} contributions at ${iso(t)} ≠ full-run contributions confirmed by then`);
    const lvl = p.side === 'BSL' ? Math.max(...fc.map((c) => c.price)) : Math.min(...fc.map((c) => c.price));
    if (fc.length && p.level !== lvl) fail(`L5 ${p.id} level at ${iso(t)} not derived from known contributions`);
    const ft = f.tests.filter((x) => x.time <= t);
    if (j(ft.map((x) => x.time)) !== j(p.tests.map((x) => x.time))) fail(`L6 ${p.id} tests at ${iso(t)} (${p.tests.length}) ≠ full-run tests started by then (${ft.length})`);
    const fs = f.sweeps.filter((e) => e.time <= t);
    if (fs.length !== p.sweeps.length) fail(`L7 ${p.id} sweeps at ${iso(t)} (${p.sweeps.length}) ≠ full-run sweeps by then (${fs.length})`);
    p.sweeps.forEach((e, k) => compareSweep(e, fs[k], t, fail));
    if (j(f.stateHistory.filter((h) => h.time <= t)) !== j(p.stateHistory)) fail(`L8 ${p.id} state history at ${iso(t)} differs from the full-run history up to then`);
    const times = [p.confirmedAt, p.lastInteractionAt, p.consumedAt, p.invalidatedAt, ...p.stateHistory.map((h) => h.time), ...p.tests.map((x) => x.time)];
    for (const x of times) if (x !== null && x > t) fail(`L9 ${p.id} carries ${iso(x)} after the newest closed bar ${iso(t)}`);
  }
}

function compareSweep(e: SweepEvent, f: SweepEvent | undefined, t: number, fail: (m: string) => void) {
  if (!f) return;
  for (const k of ['id', 'time', 'sequence', 'kind', 'level', 'sweepClose'] as const) if (e[k] !== f[k]) fail(`L7 ${e.id} ${k} changed after ${iso(t)}`);
  if (e.outcome !== 'pending' && (e.outcome !== f.outcome || e.resolvedTime !== f.resolvedTime)) fail(`L7 ${e.id} decided outcome rewritten (${e.outcome} → ${f.outcome})`);
  if (e.reclaimed && (!f.reclaimed || f.reclaimTime !== e.reclaimTime)) fail(`L7 ${e.id} reclaim rewritten`);
  for (const x of [e.time, e.extremeTime, e.reclaimTime, e.acceptedTime, e.resolvedTime]) if (x !== null && x > t) fail(`L9 ${e.id} carries ${iso(x)} after ${iso(t)}`);
}
