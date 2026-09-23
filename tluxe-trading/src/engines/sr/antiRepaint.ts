import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { SRTimeframeEngine } from './engine';
import { TIMEFRAME_SECONDS, type SRSettings } from './settings';
import type { Interaction, Pivot, SRSnapshot, SRZone } from './types';

/* ============================================================================
 * Anti-repaint audit for one timeframe. Used by the automated tests AND by the
 * in-app "Verify no-repaint" button on real loaded candles.
 *
 * It replays the history bar by bar (exactly like a live feed / replay) and
 * compares what the engine knew after N closed bars with (a) a brand-new engine
 * run on history.slice(0, N) and (b) the final full-history result. Rules:
 *
 *  R1 prefix equivalence   incremental state at N === fresh engine on slice(0, N) (every field, incl. scores)
 *  R2 pivot confirmation   pivot confirmed exactly pivotRight bars after the swing bar, never earlier
 *  R3 zone birth           never before its confirmation bar closes; once READY, exactly at that bar
 *  R4 frozen definition    id / bounds / type / createdAt / confirmedAt never change later
 *  R5 touches              touches at N === full-run touches that started ≤ T(N); each starts after confirmation
 *  R6 rejection            a decided rejection verdict AND its decision time never change later
 *  R7 break                every BROKEN transition is backed by a breaking interaction on that bar; brokenAt at N
 *                          === latest full-run break ≤ T(N); evidence closes ≤ brokenAt; consecutive-close
 *                          breaks need breakConfirmCloses closes
 *  R8 flip                 every flip needs, in order: a break → a bar fully outside the zone on the new side →
 *                          a retest that starts after it and is rejected on the flip bar
 *  R9 history              status/role history at N === full-run history up to T(N)
 *  R10 knowability         every timestamp in the snapshot at N is ≤ T(N) (the newest closed bar)
 * ========================================================================== */

export interface AuditInput {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  /** Closed candles only, ascending. */
  candles: readonly Candle[];
  tickSize: number;
  settings: SRSettings;
  /** Steps at which the expensive fresh-engine comparison (R1) runs. Default 24 evenly spaced. */
  checkpoints?: number;
  /** Test hook: engine under audit (defaults to the real SRTimeframeEngine). */
  createEngine?: (opts: EngineOpts) => AuditableEngine;
}

type EngineOpts = { instrumentId: InstrumentId; timeframe: Timeframe; tickSize: number; settings: SRSettings };
export interface AuditableEngine {
  update(candles: readonly Candle[], opts: { lastBarClosed: boolean }): void;
  snapshot(): SRSnapshot;
}

export interface AuditResult {
  timeframe: Timeframe;
  bars: number;
  steps: number;
  checkpoints: number;
  zones: number;
  pivots: number;
  touches: number;
  breaks: number;
  flips: number;
  violations: string[];
}

const MAX_VIOLATIONS = 50;

export function auditTimeframe(input: AuditInput): AuditResult {
  const { candles, settings, timeframe } = input;
  const opts = { instrumentId: input.instrumentId, timeframe, tickSize: input.tickSize, settings };
  const tf = TIMEFRAME_SECONDS[timeframe];
  const violations: string[] = [];
  const fail = (msg: string) => violations.length < MAX_VIOLATIONS && violations.push(msg);

  // Full-history result (what the engine eventually knows).
  const make = input.createEngine ?? ((o: EngineOpts) => new SRTimeframeEngine(o));
  const fresh = (c: readonly Candle[]) => {
    const e = make(opts);
    e.update(c, { lastBarClosed: true });
    return e.snapshot();
  };
  const full = fresh(candles);
  const fullZones = new Map(full.zones.map((z) => [z.id, z]));
  const indexOf = new Map(candles.map((c, i) => [c.time, i]));

  // R2 on the full run.
  for (const p of full.pivots) checkPivot(p, candles, settings, fail);
  // R8 + R7 structural checks on the full run.
  for (const z of full.zones) {
    checkBreak(z, settings, fail);
    checkFlip(z, candles, indexOf, fail);
  }

  const n = candles.length;
  const want = Math.max(1, input.checkpoints ?? 24);
  const checkAt = new Set<number>();
  for (let k = 1; k <= want; k++) checkAt.add(Math.max(1, Math.round((n * k) / want)));

  const engine = make(opts);
  const seen = new Set<string>();
  let checkpoints = 0;
  let wasReady = false;

  for (let step = 1; step <= n; step++) {
    const prefix = candles.slice(0, step);
    engine.update(prefix, { lastBarClosed: true });
    const snap = engine.snapshot();
    const t = candles[step - 1]!.time;

    // R3: never visible before confirmation; once the engine is READY, visible exactly at confirmation.
    // (Zones confirmed during warm-up surface together on the first READY step — later, never earlier.)
    for (const z of snap.zones) {
      if (seen.has(z.id)) continue;
      seen.add(z.id);
      if (z.confirmedAt > t) fail(`R3 ${z.id} visible at ${iso(t)} before its confirmation ${iso(z.confirmedAt)}`);
      else if (z.confirmedAt < t && wasReady) fail(`R3 ${z.id} confirmed ${iso(z.confirmedAt)} but only visible at ${iso(t)}`);
      const pivot = snap.pivots.find((p) => p.id === z.pivotId);
      if (!pivot || pivot.confirmedAt !== z.confirmedAt) fail(`R3 ${z.id} not born from its own confirmed pivot`);
    }

    wasReady = snap.state === 'READY';
    if (checkAt.has(step) && snap.state === 'READY') {
      checkpoints += 1;
      // R1: incremental === brand-new engine on slice(0, N).
      const oracle = fresh(prefix);
      if (JSON.stringify(snap) !== JSON.stringify(oracle)) fail(`R1 step ${step} (${iso(t)}): incremental state differs from a fresh run on the prefix`);
      checkAgainstFull(snap, full, fullZones, t, tf, fail);
    }
  }

  const allTouches = full.zones.reduce((a, z) => a + z.touchCount, 0);
  return {
    timeframe,
    bars: n,
    steps: n,
    checkpoints,
    zones: full.zones.length,
    pivots: full.pivots.length,
    touches: allTouches,
    breaks: full.zones.reduce((a, z) => a + breakTimes(z).length, 0),
    flips: full.zones.reduce((a, z) => a + z.roleHistory.length, 0),
    violations,
  };
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

function checkPivot(p: Pivot, candles: readonly Candle[], s: SRSettings, fail: (m: string) => void): void {
  if (p.confirmedIndex - p.index !== s.pivotRight) fail(`R2 ${p.id} confirmed ${p.confirmedIndex - p.index} bars after the swing (needs ${s.pivotRight})`);
  if (candles[p.confirmedIndex]?.time !== p.confirmedAt) fail(`R2 ${p.id} confirmedAt is not the confirming bar`);
  if (candles[p.index]?.time !== p.pivotTime) fail(`R2 ${p.id} pivotTime is not the swing bar`);
}

function checkBreak(z: SRZone, s: SRSettings, fail: (m: string) => void): void {
  if (z.brokenAt === null) return;
  const ev = z.breakEvidence;
  if (!ev) return void fail(`R7 ${z.id} broken without evidence`);
  if (ev.closeTimes.some((t) => t > z.brokenAt!)) fail(`R7 ${z.id} break evidence uses a close after brokenAt`);
  if (ev.rule === 'consecutiveCloses' && ev.closeTimes.length < s.breakConfirmCloses) fail(`R7 ${z.id} broke with ${ev.closeTimes.length} closes (needs ${s.breakConfirmCloses})`);
  if (ev.closeTimes.length && ev.closeTimes.at(-1) !== z.brokenAt) fail(`R7 ${z.id} brokenAt is not the confirming close`);
  if (z.brokenAt <= z.confirmedAt) fail(`R7 ${z.id} broken on/before its confirmation bar`);
  if (z.brokenAt !== breakTimes(z).at(-1)) fail(`R7 ${z.id} brokenAt is not its latest BROKEN transition`);
}

/** Every break (BROKEN transition) and flip (role change) in order — zones can break, flip and break again. */
export const breakTimes = (z: SRZone) => z.statusHistory.filter((h) => h.to === 'BROKEN').map((h) => h.time);
export const flipTimes = (z: SRZone) => z.roleHistory.map((h) => h.time);

function checkFlip(z: SRZone, candles: readonly Candle[], indexOf: Map<number, number>, fail: (m: string) => void): void {
  const breaks = breakTimes(z);
  let prevFlip = -Infinity;
  for (const change of z.roleHistory) {
    const f = change.time;
    // The break this flip belongs to: the latest break before it, after any previous flip.
    const b = breaks.filter((t) => t < f && t > prevFlip).at(-1);
    prevFlip = f;
    if (b === undefined) {
      fail(`R8 ${z.id} flipped at ${iso(f)} without a prior break`);
      continue;
    }
    const retest = z.interactions.find((it) => it.phase === 'retest' && it.rejected === true && it.startTime > b && it.resolvedTime === f);
    if (!retest) {
      fail(`R8 ${z.id} flipped at ${iso(f)} without a rejected retest after the break`);
      continue;
    }
    // Move-away: a bar strictly between the break and the retest lies fully outside the zone on the new side.
    const from = indexOf.get(b)!;
    const to = indexOf.get(retest.startTime)!;
    const away = candles.slice(from + 1, to).some((bar) => (change.to === 'resistance' ? bar.high < z.zoneLow : bar.low > z.zoneHigh));
    if (!away) fail(`R8 ${z.id} flipped at ${iso(f)} without price first moving away from the zone`);
  }
  // Every break is backed by an interaction that ended in a confirmed break on that bar.
  for (const t of breaks) {
    if (!z.interactions.some((it) => it.broke && it.endTime === t)) fail(`R7 ${z.id} BROKEN at ${iso(t)} without a breaking interaction`);
  }
}

function checkAgainstFull(snap: SRSnapshot, full: SRSnapshot, fullZones: Map<string, SRZone>, t: number, tf: number, fail: (m: string) => void): void {
  // Pivots known at N are exactly the full-run pivots confirmed ≤ T(N).
  const fp = full.pivots.filter((p) => p.confirmedAt <= t);
  if (JSON.stringify(fp) !== JSON.stringify(snap.pivots)) fail(`R2 pivots at ${iso(t)} differ from full-run pivots confirmed by then`);

  for (const z of snap.zones) {
    const f = fullZones.get(z.id);
    if (!f) {
      fail(`R4 ${z.id} known at ${iso(t)} disappears later`);
      continue;
    }
    // R4 frozen definition.
    for (const k of ['type', 'zoneLow', 'zoneHigh', 'midPrice', 'width', 'createdAt', 'confirmedAt', 'confirmedIndex', 'atrAtConfirmation', 'pivotId'] as const) {
      if (z[k] !== f[k]) fail(`R4 ${z.id} ${k} changed after ${iso(t)}`);
    }
    // R5 touches.
    const ft = f.interactions.filter((it) => it.startTime <= t);
    if (ft.length !== z.interactions.length || ft.some((it, k) => it.id !== z.interactions[k]!.id || it.startTime !== z.interactions[k]!.startTime)) {
      fail(`R5 ${z.id} touches at ${iso(t)} (${z.touchCount}) ≠ full-run touches started by then (${ft.length})`);
    }
    for (const it of z.interactions) {
      if (it.startTime <= z.confirmedAt) fail(`R5 ${it.id} touch starts on/before the zone's confirmation bar`);
      checkInteraction(it, ft.find((x) => x.id === it.id), t, fail);
    }
    // R7 break / R8 flip dates.
    // brokenAt / flippedAt are the latest events known at N: the newest full-run event ≤ T(N).
    const expectBroken = breakTimes(f).filter((x) => x <= t).at(-1) ?? null;
    if (z.brokenAt !== expectBroken) fail(`R7 ${z.id} brokenAt ${z.brokenAt} at ${iso(t)}, expected ${expectBroken}`);
    const expectFlip = flipTimes(f).filter((x) => x <= t).at(-1) ?? null;
    if (z.flippedAt !== expectFlip) fail(`R8 ${z.id} flippedAt ${z.flippedAt} at ${iso(t)}, expected ${expectFlip}`);
    // R9 histories.
    const sh = f.statusHistory.filter((h) => h.time <= t);
    if (JSON.stringify(sh) !== JSON.stringify(z.statusHistory)) fail(`R9 ${z.id} status history at ${iso(t)} differs from full-run history up to then`);
    const rh = f.roleHistory.filter((h) => h.time <= t);
    if (JSON.stringify(rh) !== JSON.stringify(z.roleHistory)) fail(`R9 ${z.id} role history at ${iso(t)} differs`);
    // R10 knowability.
    const times = [z.confirmedAt, z.brokenAt, z.flippedAt, z.lastInteractionAt, ...z.statusHistory.map((h) => h.time), ...(z.breakEvidence?.closeTimes ?? [])];
    for (const x of times) if (x !== null && x > t) fail(`R10 ${z.id} carries time ${iso(x)} after the newest closed bar ${iso(t)}`);
  }
  void tf;
}

function checkInteraction(it: Interaction, full: Interaction | undefined, t: number, fail: (m: string) => void): void {
  for (const x of [it.startTime, it.endTime, it.extremeTime, it.sweepTime, it.resolvedTime]) {
    if (x !== null && x > t) fail(`R10 ${it.id} carries time ${iso(x)} after ${iso(t)}`);
  }
  // R6: once decided, a rejection verdict never changes; undecided at N must still be undecidable from data ≤ T(N).
  if (!full) return;
  if (it.rejected !== null && full.rejected !== it.rejected) fail(`R6 ${it.id} rejection verdict changed later (${it.rejected} → ${full.rejected})`);
  if (it.resolvedTime !== null && full.resolvedTime !== it.resolvedTime) fail(`R6 ${it.id} resolution time rewritten later (${iso(it.resolvedTime)} → ${full.resolvedTime === null ? 'null' : iso(full.resolvedTime)})`);
  if (it.broke && !full.broke) fail(`R6 ${it.id} break flag disappeared later`);
}
