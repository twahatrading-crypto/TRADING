import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import type { OBSettings } from './config';
import { OrderBlockTimeframeEngine } from './engine';
import type { OBSnapshot, OrderBlock } from './types';

/* ============================================================================
 * Order Block anti-repaint audit (one timeframe) — used by tests and by the
 * in-app "Verify no-repaint". History is replayed one CLOSED bar at a time and
 * the state after N bars is compared with a clean recomputation on bars 1…N and
 * with the final full-history result:
 *
 *  O1  parity         incremental at N === clean recomputation on slice(0, N) (everything, incl. scores)
 *  O2  swings         confirmed exactly swingRight bars after the swing bar
 *  O3  birth          a block is never visible before its confirmation bar; once READY, exactly at it
 *  O4  immutability   id / type / bounds / origin / created / confirmed / break / displacement never change
 *  O5  structure      breaks at N === full-run breaks ≤ T(N), unchanged (incl. block / no-block decision)
 *  O6  tests          at N === full-run tests that started ≤ T(N)
 *  O7  lifecycle      mitigation% never decreases; mitigated/invalidated/expired times, once set, never change
 *  O8  history        state history at N === full-run history up to T(N)
 *  O9  knowability    every timestamp at N ≤ T(N)
 *  O10 causality      origin < confirmation; the broken swing was confirmed BEFORE the break bar and the
 *                     break bar CLOSED beyond it; displacement meets the thresholds; the origin extreme held
 *                     until the break; invalidation bar closed beyond the far edge; mitigation reached the threshold
 * ========================================================================== */

type EngineOpts = { instrumentId: InstrumentId; timeframe: Timeframe; tickSize: number; settings: OBSettings };
export interface AuditableOBEngine {
  update(c: readonly Candle[], o: { lastBarClosed: boolean }): void;
  snapshot(): OBSnapshot;
}

export interface OBAuditInput extends EngineOpts {
  candles: readonly Candle[];
  checkpoints?: number;
  createEngine?: (o: EngineOpts) => AuditableOBEngine;
}

export interface OBAuditResult {
  timeframe: Timeframe;
  bars: number;
  checkpoints: number;
  breaks: number;
  chochs: number;
  blocks: number;
  tested: number;
  mitigated: number;
  invalidated: number;
  violations: string[];
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);
const j = (v: unknown) => JSON.stringify(v);
const IMMUTABLE = ['type', 'low', 'high', 'mid', 'boundaryMode', 'originTime', 'originIndex', 'originOpen', 'originHigh', 'originLow', 'originClose', 'originCandles', 'createdAt', 'confirmedAt', 'confirmedIndex', 'breakId', 'breakKind', 'brokenLevel', 'breakDistance', 'hasImbalance', 'atrAtConfirmation'] as const;

export function auditOrderBlocks(input: OBAuditInput): OBAuditResult {
  const { candles, settings, timeframe } = input;
  const opts: EngineOpts = { instrumentId: input.instrumentId, timeframe, tickSize: input.tickSize, settings };
  const make = input.createEngine ?? ((o: EngineOpts) => new OrderBlockTimeframeEngine(o));
  const fresh = (c: readonly Candle[]) => {
    const e = make(opts);
    e.update(c, { lastBarClosed: true });
    return e.snapshot();
  };
  const v: string[] = [];
  const fail = (m: string) => v.length < 50 && v.push(m);
  const full = fresh(candles);
  const fullBlocks = new Map(full.blocks.map((b) => [b.id, b]));
  const byTime = new Map(candles.map((c, i) => [c.time, i]));

  for (const s of full.swings) {
    if (s.confirmedIndex - s.index !== settings.swingRight) fail(`O2 ${s.id} confirmed ${s.confirmedIndex - s.index} bars after the swing`);
    if (candles[s.confirmedIndex]?.time !== s.confirmedAt) fail(`O2 ${s.id} confirmedAt is not the confirming bar`);
  }
  for (const brk of full.breaks) {
    const sw = full.swings.find((s) => s.id === brk.swingId);
    if (!sw || sw.confirmedIndex >= brk.index) fail(`O10 ${brk.id} broke a swing not confirmed before the break bar`);
    const c = candles[brk.index]!;
    if (brk.direction === 'up' ? !(c.close > brk.level) : !(c.close < brk.level)) fail(`O10 ${brk.id} break bar did not CLOSE beyond the level`);
  }
  for (const b of full.blocks) causality(b, candles, byTime, settings, fail);

  const n = candles.length;
  const want = Math.max(1, input.checkpoints ?? 24);
  const at = new Set<number>();
  for (let k = 1; k <= want; k++) at.add(Math.max(1, Math.round((n * k) / want)));
  const engine = make(opts);
  const seen = new Set<string>();
  const lastMit = new Map<string, number>();
  let wasReady = false;
  let checkpoints = 0;
  for (let step = 1; step <= n; step++) {
    const prefix = candles.slice(0, step);
    engine.update(prefix, { lastBarClosed: true });
    const snap = engine.snapshot();
    const t = candles[step - 1]!.time;
    for (const b of snap.blocks) {
      if ((lastMit.get(b.id) ?? 0) > b.mitigationPct) fail(`O7 ${b.id} mitigation decreased at ${iso(t)}`);
      lastMit.set(b.id, b.mitigationPct);
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      if (b.confirmedAt > t) fail(`O3 ${b.id} visible at ${iso(t)} before confirmation ${iso(b.confirmedAt)}`);
      else if (b.confirmedAt < t && wasReady) fail(`O3 ${b.id} confirmed ${iso(b.confirmedAt)} but only visible at ${iso(t)}`);
    }
    wasReady = snap.state === 'READY';
    if (at.has(step) && snap.state === 'READY') {
      checkpoints += 1;
      if (j(snap) !== j(fresh(prefix))) fail(`O1 step ${step} (${iso(t)}): incremental state differs from a clean recomputation`);
      compare(snap, full, fullBlocks, t, fail);
    }
  }
  return {
    timeframe,
    bars: n,
    checkpoints,
    breaks: full.breaks.length,
    chochs: full.breaks.filter((b) => b.kind === 'CHOCH').length,
    blocks: full.blocks.length,
    tested: full.blocks.filter((b) => b.tests.length > 0).length,
    mitigated: full.blocks.filter((b) => b.mitigatedAt !== null).length,
    invalidated: full.blocks.filter((b) => b.invalidatedAt !== null).length,
    violations: v,
  };
}

function causality(b: OrderBlock, candles: readonly Candle[], byTime: Map<number, number>, s: OBSettings, fail: (m: string) => void) {
  if (!(b.originIndex < b.confirmedIndex)) fail(`O10 ${b.id} origin not before confirmation`);
  if (b.displacement.legAtr < s.minLegAtr || b.displacement.maxBodyAtr < s.minBodyAtr) fail(`O10 ${b.id} displacement below thresholds`);
  for (let k = b.originIndex + 1; k <= b.confirmedIndex; k++) {
    const c = candles[k]!;
    if (b.type === 'bullish' ? c.low < b.originLow : c.high > b.originHigh) fail(`O10 ${b.id} origin extreme did not hold until the break`);
  }
  if (b.invalidatedAt !== null) {
    const c = candles[byTime.get(b.invalidatedAt)!]!;
    if (b.type === 'bullish' ? !(c.close < b.low) : !(c.close > b.high)) fail(`O10 ${b.id} invalidation bar did not close beyond the far edge`);
  }
  if (b.mitigatedAt !== null && b.mitigationPct < s.mitigationPct) fail(`O10 ${b.id} MITIGATED below the threshold`);
  for (const t of b.tests) if (t.time <= b.confirmedAt) fail(`O10 ${b.id} test on/before confirmation`);
}

function compare(snap: OBSnapshot, full: OBSnapshot, fullBlocks: Map<string, OrderBlock>, t: number, fail: (m: string) => void) {
  if (j(full.swings.filter((s) => s.confirmedAt <= t)) !== j(snap.swings)) fail(`O2 swings at ${iso(t)} differ from full-run swings confirmed by then`);
  if (j(full.breaks.filter((b) => b.time <= t)) !== j(snap.breaks)) fail(`O5 structure breaks at ${iso(t)} differ from the full run up to then`);
  for (const b of snap.blocks) {
    const f = fullBlocks.get(b.id);
    if (!f) {
      fail(`O4 ${b.id} known at ${iso(t)} disappears later`);
      continue;
    }
    for (const k of IMMUTABLE) if (b[k] !== f[k]) fail(`O4 ${b.id} ${k} changed after ${iso(t)}`);
    if (j(b.displacement) !== j(f.displacement)) fail(`O4 ${b.id} displacement evidence changed after ${iso(t)}`);
    if (j(f.tests.filter((x) => x.time <= t).map((x) => x.time)) !== j(b.tests.map((x) => x.time))) fail(`O6 ${b.id} tests at ${iso(t)} differ from full-run tests started by then`);
    for (const k of ['mitigatedAt', 'invalidatedAt', 'expiredAt', 'firstTestAt'] as const) if (b[k] !== null && b[k] !== f[k]) fail(`O7 ${b.id} ${k} rewritten after ${iso(t)}`);
    if (j(f.stateHistory.filter((h) => h.time <= t)) !== j(b.stateHistory)) fail(`O8 ${b.id} state history at ${iso(t)} differs from the full run up to then`);
    for (const x of [b.confirmedAt, b.firstTestAt, b.lastTestAt, b.mitigatedAt, b.invalidatedAt, b.expiredAt, b.lastInteractionAt]) if (x !== null && x > t) fail(`O9 ${b.id} carries ${iso(x)} after ${iso(t)}`);
  }
}
