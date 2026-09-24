import type { Candle } from '../../types/market';
import { HLR_TF_SECONDS, HLR_TIMEFRAMES, type HLRSettings } from './config';
import { entryGates, HighLowReversalEngine, type HLREngineOptions, type HLRInput } from './engine';
import { analyzeHLRAt, hlrKnowledgeTimes, type HLRDataset } from './knowledge';
import type { HLRSnapshot, KeyLevel, Setup, SetupState } from './types';
import { TERMINAL_STATES } from './types';

/* ============================================================================
 * High / Low Reversal anti-repaint audit — used by tests and by the in-app
 * "Verify no-repaint". The history is replayed one knowledge time at a time
 * (every distinct bar close across H4 / H1 / M15 / M5 / M1). At each time K the
 * incremental engine's records are compared with the full-history run:
 *
 *  R1 parity        at checkpoints: incremental snapshot === clean recomputation on bars known at K
 *  R2 levels        an H1 level never appears before its confirmation; price / time / ATR /
 *                   significance never change; equal-level lists only grow
 *  R3 sweep         once reclaimed, the sweep (bar, extreme, penetration) never changes;
 *                   the sweep bar never moves once set
 *  R4 reclaim       never changes once set
 *  R5 M5            the confirmation never changes once set and never appears earlier later on
 *  R6 entry         zone / risk / ENTRY READY time / trigger never change once set
 *  R7 lifecycle     the state history at K is a prefix of the final history (forward-only;
 *                   a finished setup is never rewritten)
 *  R8 knowability   every recorded time ≤ K
 *  R9 causality     level ≤ sweep ≤ reclaim ≤ M5 ≤ zone ≤ entry (by knowledge time)
 *  R10 gates        ENTRY_READY / TRIGGERED only with every mandatory gate present
 * ========================================================================== */

export interface AuditableHLREngine {
  update(input: HLRInput): void;
  snapshot(): HLRSnapshot;
  inspect(): { knowledgeTime: number | null; setups: readonly Setup[]; levels: readonly KeyLevel[] };
}

export interface HLRAuditInput extends HLRDataset {
  checkpoints?: number;
  createEngine?: (o: HLREngineOptions) => AuditableHLREngine;
}

export interface HLRAuditResult {
  steps: number;
  checkpoints: number;
  levels: number;
  setups: number;
  sweeps: number;
  reclaims: number;
  confirmations: number;
  entryReady: number;
  violations: string[];
}

const ORDER: Record<SetupState, number> = {
  WATCHING_LEVEL: 0,
  LIQUIDITY_TAKEN: 1,
  RECLAIMED: 2,
  M5_CONFIRMATION_PENDING: 3,
  M5_CONFIRMED: 4,
  M1_PULLBACK_PENDING: 5,
  ENTRY_READY: 6,
  TRIGGERED: 7,
  FAILED_RECLAIM: 9,
  INVALIDATED: 9,
  MISSED: 9,
  EXPIRED: 9,
};
const j = (v: unknown) => JSON.stringify(v);
const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

export function auditHighLowReversal(input: HLRAuditInput): HLRAuditResult {
  // Keep every finished setup in the output so nothing is compared against a truncated list.
  const settings: HLRSettings = { ...input.settings, maxFinishedSetups: Number.MAX_SAFE_INTEGER };
  const ds: HLRDataset = { ...input, settings };
  const opts: HLREngineOptions = { instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings };
  const make = input.createEngine ?? ((o: HLREngineOptions) => new HighLowReversalEngine(o));
  const times = hlrKnowledgeTimes(ds);
  const v: string[] = [];
  const add = (m: string) => {
    if (v.length < 200) v.push(m);
  };

  const full = new HighLowReversalEngine(opts);
  full.update(ds.candles);
  const finalSetups = new Map(full.inspect().setups.map((s) => [s.id, j(s)]));
  const fin = new Map(full.inspect().setups.map((s) => [s.id, JSON.parse(finalSetups.get(s.id)!) as Setup]));
  const finLevels = new Map(full.inspect().levels.map((l) => [l.id, JSON.parse(j(l)) as KeyLevel]));

  const nCp = Math.max(2, input.checkpoints ?? 24);
  const cps = new Set<number>();
  for (let k = 1; k <= nCp; k++) cps.add(times[Math.min(times.length - 1, Math.floor((k * times.length) / nCp) - 1)]!);

  // Growing per-timeframe inputs (only bars closed by K) — O(new bars) per step.
  const src = Object.fromEntries(HLR_TIMEFRAMES.map((tf) => [tf, ds.candles[tf] ?? []])) as Record<string, readonly Candle[]>;
  const ptr = Object.fromEntries(HLR_TIMEFRAMES.map((tf) => [tf, 0])) as Record<string, number>;
  const grow = Object.fromEntries(HLR_TIMEFRAMES.map((tf) => [tf, [] as Candle[]])) as Record<string, Candle[]>;

  const eng = make(opts);
  const firstSeen = new Map<string, { sweepTime?: number; sweep?: string; reclaim?: string; m5?: string; zone?: string; risk?: string; entry?: string; trig?: number | null }>();
  let checkpoints = 0;
  for (const K of times) {
    for (const tf of HLR_TIMEFRAMES) {
      const arr = src[tf]!;
      let p = ptr[tf]!;
      while (p < arr.length && arr[p]!.time + HLR_TF_SECONDS[tf] <= K) grow[tf]!.push(arr[p++]!);
      ptr[tf] = p;
    }
    eng.update(grow as HLRInput);
    const view = eng.inspect();
    const at = iso(K);

    for (const l of view.levels) {
      const f = finLevels.get(l.id);
      if (l.confirmedAt > K) add(`R2 ${at}: level ${l.id} visible before its confirmation`);
      if (!f) {
        add(`R2 ${at}: level ${l.id} missing from the full run`);
        continue;
      }
      if (l.price !== f.price || l.time !== f.time || l.atr !== f.atr || l.significance !== f.significance) add(`R2 ${at}: level ${l.id} frozen fields differ from the full run`);
      if (j(l.equals) !== j(f.equals.slice(0, l.equals.length))) add(`R2 ${at}: level ${l.id} equal-level list is not a prefix of the final list`);
    }

    for (const s of view.setups) {
      const f = fin.get(s.id);
      if (!f) {
        add(`R7 ${at}: setup ${s.id} missing from the full run`);
        continue;
      }
      if (s.level !== f.level || s.levelTime !== f.levelTime || s.direction !== f.direction || s.detectedAt !== f.detectedAt) add(`R2 ${at}: setup ${s.id} identity changed`);
      // R7: history prefix.
      if (j(s.stateHistory) !== j(f.stateHistory.slice(0, s.stateHistory.length))) add(`R7 ${at}: ${s.id} history is not a prefix of the final history`);
      for (let k = 1; k < s.stateHistory.length; k++) {
        const h = s.stateHistory[k]!;
        if (ORDER[h.to] <= ORDER[h.from!] && !(ORDER[h.to] === 9 && ORDER[h.from!] !== 9)) add(`R7 ${at}: ${s.id} moved backwards ${h.from} → ${h.to}`);
      }
      if (TERMINAL_STATES.includes(s.state) && j(s.stateHistory) !== j(f.stateHistory)) add(`R7 ${at}: finished setup ${s.id} was rewritten later`);
      // R8: knowability.
      const ts = [s.detectedAt, ...s.stateHistory.map((h) => h.time), s.sweep?.knownAt, s.reclaim?.knownAt, s.m5?.knownAt, s.zone?.definedAt, s.entry?.knownAt, s.triggeredAt, s.touchedAt];
      for (const t of ts) if (t !== null && t !== undefined && t > K) add(`R8 ${at}: ${s.id} holds a time after K (${iso(t)})`);
      // R3–R6: immutability once set.
      const seen = firstSeen.get(s.id) ?? {};
      const once = (key: 'sweep' | 'reclaim' | 'm5' | 'zone' | 'risk' | 'entry', val: unknown, label: string) => {
        if (val === null || val === undefined) {
          if (seen[key] !== undefined) add(`${label} ${at}: ${s.id} ${key} disappeared`);
          return;
        }
        const x = j(val);
        if (seen[key] === undefined) seen[key] = x;
        else if (seen[key] !== x) add(`${label} ${at}: ${s.id} ${key} changed after it was set`);
      };
      if (s.sweep) {
        if (seen.sweepTime === undefined) seen.sweepTime = s.sweep.time;
        else if (seen.sweepTime !== s.sweep.time) add(`R3 ${at}: ${s.id} sweep bar moved`);
      }
      if (s.reclaim) once('sweep', s.sweep, 'R3');
      once('reclaim', s.reclaim, 'R4');
      once('m5', s.m5, 'R5');
      once('zone', s.zone, 'R6');
      once('risk', s.risk, 'R6');
      once('entry', s.entry, 'R6');
      if (s.triggeredAt !== null) {
        if (seen.trig === undefined) seen.trig = s.triggeredAt;
        else if (seen.trig !== s.triggeredAt) add(`R6 ${at}: ${s.id} trigger time changed`);
      }
      firstSeen.set(s.id, seen);
      // R5: a confirmation absent at K must not appear in the final run at or before K.
      if (!s.m5 && f.m5 && f.m5.knownAt <= K) add(`R5 ${at}: ${s.id} final run has an M5 confirmation at ${iso(f.m5.knownAt)} that was not known then`);
      if (!s.entry && f.entry && f.entry.knownAt <= K) add(`R6 ${at}: ${s.id} final run has an entry at ${iso(f.entry.knownAt)} that was not known then`);
      // R9: causality.
      if (s.sweep && s.sweep.time < s.levelConfirmedAt) add(`R9 ${at}: ${s.id} sweep bar opened before the level was confirmed`);
      if (s.reclaim && s.sweep && s.reclaim.knownAt < s.sweep.knownAt) add(`R9 ${at}: ${s.id} reclaim before sweep`);
      if (s.m5 && s.reclaim && s.m5.knownAt < s.reclaim.knownAt) add(`R9 ${at}: ${s.id} M5 confirmation before reclaim`);
      if (s.zone && s.m5 && s.zone.definedAt !== s.m5.knownAt) add(`R9 ${at}: ${s.id} zone not defined at the confirmation close`);
      if (s.entry && s.m5 && s.entry.time < s.m5.knownAt) add(`R9 ${at}: ${s.id} M1 entry bar opened before the M5 confirmation closed`);
      // R10: gates.
      if (s.state === 'ENTRY_READY' || s.state === 'TRIGGERED') {
        const g = entryGates(s);
        for (const [k, ok] of Object.entries(g)) if (!ok) add(`R10 ${at}: ${s.id} is ${s.state} without gate "${k}"`);
      }
    }

    if (cps.has(K)) {
      checkpoints += 1;
      const clean = analyzeHLRAt(ds, K, null);
      const inc = eng.snapshot();
      const norm = (x: HLRSnapshot) => j({ ...x, price: null, setups: x.setups.map((s) => ({ ...s, distance: null })) });
      if (norm(inc) !== norm(clean)) add(`R1 ${at}: incremental state ≠ clean recomputation on the bars known then`);
    }
  }

  const fs = [...fin.values()];
  return {
    steps: times.length,
    checkpoints,
    levels: finLevels.size,
    setups: fs.length,
    sweeps: fs.filter((s) => s.sweep).length,
    reclaims: fs.filter((s) => s.reclaim).length,
    confirmations: fs.filter((s) => s.m5).length,
    entryReady: fs.filter((s) => s.entry).length,
    violations: v,
  };
}
