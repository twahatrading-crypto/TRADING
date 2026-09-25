import type { Candle } from '../../types/market';
import { HLE_TF_SECONDS, HLE_TIMEFRAMES, type HLESettings } from './config';
import { HighLowEngine, mandatoryGates, type HLEEngineOptions, type HLEInput } from './engine';
import { analyzeHLEAt, hleKnowledgeTimes, type HLEDataset } from './knowledge';
import type { HLEEvent, HLESnapshot, Level, Setup, SetupState } from './types';
import { TERMINAL } from './types';

/* ============================================================================
 * High / Low Engine anti-repaint audit (tests + in-app "Verify No-Repaint").
 * Replays every knowledge time (each distinct bar close across H4…M1) and compares
 * the incremental engine with the full-history run:
 *  A1 parity       at checkpoints: incremental snapshot === clean recomputation at K
 *  A2 levels       never visible before created or before validFrom; price / validFrom /
 *                  tolerance frozen (R2); a level state never goes backwards
 *  A3 sweep        sweep bar never moves; sweep record frozen once reclaimed
 *  A4 reclaim      frozen once set
 *  A5 M5           frozen once set; never appears earlier later on
 *  A6 entry        zone / SL / entry / TP / R frozen once set (R1); never earlier later on
 *  A7 lifecycle    state history at K is a prefix of the final history (forward-only)
 *  A8 knowability  every recorded time ≤ K
 *  A9 causality    level validFrom ≤ sweep ≤ reclaim ≤ M5 = zone ≤ entry
 *  A10 gates       ENTRY_READY only with every mandatory boolean true
 *  A11 event log   the log at K is an exact prefix of the final log (history never rewritten)
 *  A12 score       frozen at ENTRY_READY
 * The first mismatch is reported first.
 * ========================================================================== */

export interface AuditableHLE {
  update(input: HLEInput): unknown;
  snapshot(): HLESnapshot;
  inspect(): { knowledgeTime: number | null; setups: readonly Setup[]; levels: readonly Level[]; events: readonly HLEEvent[] };
}
export interface HLEAuditInput extends HLEDataset {
  checkpoints?: number;
  createEngine?: (o: HLEEngineOptions) => AuditableHLE;
}
export interface HLEAuditResult {
  steps: number;
  checkpoints: number;
  levels: number;
  setups: number;
  sweeps: number;
  reclaims: number;
  confirmations: number;
  entryReady: number;
  events: number;
  violations: string[];
}

const ORDER: Record<SetupState, number> = { SWEPT: 0, WAITING_M5: 1, WAITING_M1: 2, NO_TARGET: 3, ENTRY_READY: 4, INVALIDATED: 9, EXPIRED: 9 };
const LEVEL_ORDER = { ACTIVE: 0, SWEPT: 1, CONSUMED: 2 } as const;
const j = (v: unknown) => JSON.stringify(v);
const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

/** Snapshot without display-only fields (display price / distances), for parity. */
export const normHLE = (x: HLESnapshot) =>
  j({ ...x, displayPrice: null, levels: x.levels.map((l) => ({ ...l, distance: null })), setups: x.setups.map((s) => ({ ...s, distance: null })) });

export function auditHighLowEngine(input: HLEAuditInput): HLEAuditResult {
  const settings: HLESettings = { ...input.settings, maxFinishedSetups: Number.MAX_SAFE_INTEGER, maxEvents: Number.MAX_SAFE_INTEGER };
  const ds: HLEDataset = { ...input, settings };
  const opts: HLEEngineOptions = { instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings };
  const make = input.createEngine ?? ((o: HLEEngineOptions) => new HighLowEngine(o));
  const times = hleKnowledgeTimes(ds);
  const v: string[] = [];
  const add = (m: string) => {
    if (v.length < 200) v.push(m);
  };

  const full = new HighLowEngine(opts);
  full.update(ds.candles);
  const fv = full.inspect();
  const fin = new Map(fv.setups.map((s) => [s.id, JSON.parse(j(s)) as Setup]));
  const finLevels = new Map(fv.levels.map((l) => [l.id, JSON.parse(j(l)) as Level]));
  const finEvents = fv.events.map((e) => j(e));

  const nCp = Math.max(2, input.checkpoints ?? 24);
  const cps = new Set<number>();
  for (let k = 1; k <= nCp; k++) cps.add(times[Math.min(times.length - 1, Math.floor((k * times.length) / nCp) - 1)]!);

  const src = Object.fromEntries(HLE_TIMEFRAMES.map((tf) => [tf, ds.candles[tf] ?? []])) as Record<string, readonly Candle[]>;
  const ptr = Object.fromEntries(HLE_TIMEFRAMES.map((tf) => [tf, 0])) as Record<string, number>;
  const grow = Object.fromEntries(HLE_TIMEFRAMES.map((tf) => [tf, [] as Candle[]])) as Record<string, Candle[]>;
  const eng = make(opts);
  const seen = new Map<string, Record<string, string | number | undefined>>();
  const levelSeen = new Map<string, { frozen: string; state: number }>();
  let checkpoints = 0;

  for (const K of times) {
    for (const tf of HLE_TIMEFRAMES) {
      const arr = src[tf]!;
      let p = ptr[tf]!;
      while (p < arr.length && arr[p]!.time + HLE_TF_SECONDS[tf] <= K) grow[tf]!.push(arr[p++]!);
      ptr[tf] = p;
    }
    eng.update(grow as HLEInput);
    const view = eng.inspect();
    const at = iso(K);

    view.events.forEach((e, k) => {
      if (e.time > K) add(`A8 ${at}: event ${e.id} is timed after K`);
      if (k < finEvents.length && j(e) !== finEvents[k]) add(`A11 ${at}: event #${k} (${e.type}) differs from the final log — history rewritten`);
    });
    if (view.events.length > finEvents.length) add(`A11 ${at}: more events than the full run`);

    for (const l of view.levels) {
      if (l.createdAt > K) add(`A2 ${at}: level ${l.id} visible before it was created`);
      if (l.validFrom > K) add(`A2 ${at}: level ${l.id} published before its validFrom`);
      const frozen = j([l.type, l.price, l.validFrom, l.createdAt, l.tol, l.atr, l.members]);
      const prev = levelSeen.get(l.id);
      if (prev && prev.frozen !== frozen) add(`A2 ${at}: level ${l.id} frozen fields changed (price / validFrom / tolerance)`);
      if (prev && LEVEL_ORDER[l.state] < prev.state) add(`A2 ${at}: level ${l.id} state went backwards to ${l.state}`);
      levelSeen.set(l.id, { frozen, state: LEVEL_ORDER[l.state] });
      const f = finLevels.get(l.id);
      if (f && j([f.type, f.price, f.validFrom, f.createdAt, f.tol, f.atr, f.members]) !== frozen) add(`A2 ${at}: level ${l.id} differs from the full run`);
    }

    for (const s of view.setups) {
      const f = fin.get(s.id);
      if (!f) {
        add(`A7 ${at}: setup ${s.id} missing from the full run`);
        continue;
      }
      if (j(s.history) !== j(f.history.slice(0, s.history.length))) add(`A7 ${at}: ${s.id} history is not a prefix of the final history`);
      for (let k = 1; k < s.history.length; k++) {
        const h = s.history[k]!;
        if (ORDER[h.to] <= ORDER[h.from!]) add(`A7 ${at}: ${s.id} moved backwards ${h.from} → ${h.to}`);
      }
      if (TERMINAL.includes(s.state) && j(s.history) !== j(f.history)) add(`A7 ${at}: finished setup ${s.id} rewritten later`);
      for (const t of [s.sweep.knownAt, ...s.history.map((h) => h.time), s.touch?.knownAt, s.reclaim?.knownAt, s.m5?.knownAt, s.zone?.definedAt, s.entry?.knownAt])
        if (t !== null && t !== undefined && t > K) add(`A8 ${at}: ${s.id} holds a time after K (${iso(t)})`);
      const m = seen.get(s.id) ?? {};
      const once = (key: string, val: unknown, label: string) => {
        if (val === null || val === undefined) {
          if (m[key] !== undefined) add(`${label} ${at}: ${s.id} ${key} disappeared`);
          return;
        }
        const x = j(val);
        if (m[key] === undefined) m[key] = x;
        else if (m[key] !== x) add(`${label} ${at}: ${s.id} ${key} changed after it was set`);
      };
      if (m.sweepTime === undefined) m.sweepTime = s.sweep.time;
      else if (m.sweepTime !== s.sweep.time) add(`A3 ${at}: ${s.id} sweep bar moved`);
      if (s.reclaim) once('sweep', s.sweep, 'A3');
      once('reclaim', s.reclaim, 'A4');
      once('m5', s.m5, 'A5');
      once('zone', s.zone, 'A6');
      once('risk', s.risk, 'A6');
      once('entry', s.entry, 'A6');
      if (s.state === 'ENTRY_READY' || s.score.frozen) {
        if (!s.score.frozen) add(`A12 ${at}: ${s.id} ENTRY_READY score is not frozen`);
        once('score', s.score, 'A12');
      }
      seen.set(s.id, m);
      if (!s.m5 && f.m5 && f.m5.knownAt <= K) add(`A5 ${at}: ${s.id} final run has an M5 confirmation at ${iso(f.m5.knownAt)} not known then`);
      if (!s.entry && f.entry && f.entry.knownAt <= K) add(`A6 ${at}: ${s.id} final run has an entry at ${iso(f.entry.knownAt)} not known then`);
      if (s.sweep.time < s.levelValidFrom) add(`A9 ${at}: ${s.id} sweep bar opened before the level existed`);
      if (s.reclaim && s.reclaim.knownAt < s.sweep.knownAt) add(`A9 ${at}: ${s.id} reclaim before sweep`);
      if (s.m5 && s.m5.knownAt < s.reclaim!.knownAt) add(`A9 ${at}: ${s.id} M5 before reclaim`);
      if (s.zone && s.zone.definedAt !== s.m5?.knownAt) add(`A9 ${at}: ${s.id} zone not defined at the M5 confirmation`);
      if (s.entry && (s.entry.knownAt < s.m5!.knownAt || s.entry.time < s.m5!.time + 300)) add(`A9 ${at}: ${s.id} M1 pullback before the M5 break closed`);
      if (s.state === 'ENTRY_READY') for (const [k, ok] of Object.entries(mandatoryGates(s))) if (!ok) add(`A10 ${at}: ${s.id} ENTRY_READY without "${k}"`);
    }

    if (cps.has(K)) {
      checkpoints += 1;
      if (normHLE(eng.snapshot()) !== normHLE(analyzeHLEAt(ds, K, null))) add(`A1 ${at}: incremental state ≠ clean recomputation on the bars known then`);
    }
  }
  const fs = [...fin.values()];
  return {
    steps: times.length,
    checkpoints,
    levels: finLevels.size,
    setups: fs.length,
    sweeps: fs.length,
    reclaims: fs.filter((s) => s.reclaim).length,
    confirmations: fs.filter((s) => s.m5).length,
    entryReady: fs.filter((s) => s.entry && s.risk).length,
    events: finEvents.length,
    violations: v,
  };
}
