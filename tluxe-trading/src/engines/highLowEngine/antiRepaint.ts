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
 *  A2 levels       never visible before created; type / price / time / strength frozen
 *  A3 sweep        sweep bar never moves; sweep record frozen once reclaimed
 *  A4 reclaim      frozen once set
 *  A5 M5           frozen once set; never appears earlier later on
 *  A6 entry        zone / SL / TP / ENTRY READY time frozen once set; never earlier later on
 *  A7 lifecycle    state history at K is a prefix of the final history (forward-only)
 *  A8 knowability  every recorded time ≤ K
 *  A9 causality    level ≤ sweep ≤ reclaim ≤ M5 = zone ≤ entry
 *  A10 gates       ENTRY_READY only with every mandatory stage present
 *  A11 event log   the log at K is an exact prefix of the final log (history never rewritten)
 * The first mismatch is reported first.
 * ========================================================================== */

export interface AuditableHLE {
  update(input: HLEInput): void;
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

const ORDER: Record<SetupState, number> = { LEVEL_ACTIVE: 0, LIQUIDITY_APPROACH: 1, SWEPT: 2, RECLAIMED: 3, WAITING_M5: 4, M5_CONFIRMED: 5, WAITING_M1: 6, ENTRY_READY: 7, INVALIDATED: 9, EXPIRED: 9 };
const j = (v: unknown) => JSON.stringify(v);
const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

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
      const f = finLevels.get(l.id);
      if (l.createdAt > K) add(`A2 ${at}: level ${l.id} visible before it was created`);
      if (!f) add(`A2 ${at}: level ${l.id} missing from the full run`);
      else if (l.price !== f.price || l.sourceTime !== f.sourceTime || l.createdAt !== f.createdAt || l.strengthScore !== f.strengthScore || l.type !== f.type) add(`A2 ${at}: level ${l.id} frozen fields changed`);
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
      for (const t of [s.levelCreatedAt, ...s.history.map((h) => h.time), s.sweep?.knownAt, s.reclaim?.knownAt, s.m5?.knownAt, s.zone?.definedAt, s.entry?.knownAt, s.pullback?.knownAt, s.approachAt])
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
      if (s.sweep) {
        if (m.sweepTime === undefined) m.sweepTime = s.sweep.time;
        else if (m.sweepTime !== s.sweep.time) add(`A3 ${at}: ${s.id} sweep bar moved`);
      }
      if (s.reclaim) once('sweep', s.sweep, 'A3');
      once('reclaim', s.reclaim, 'A4');
      once('m5', s.m5, 'A5');
      once('zone', s.zone, 'A6');
      once('risk', s.risk, 'A6');
      once('entry', s.entry, 'A6');
      seen.set(s.id, m);
      if (!s.m5 && f.m5 && f.m5.knownAt <= K) add(`A5 ${at}: ${s.id} final run has an M5 confirmation at ${iso(f.m5.knownAt)} not known then`);
      if (!s.entry && f.entry && f.entry.knownAt <= K) add(`A6 ${at}: ${s.id} final run has ENTRY READY at ${iso(f.entry.knownAt)} not known then`);
      if (s.sweep && s.sweep.time < s.levelCreatedAt) add(`A9 ${at}: ${s.id} sweep bar opened before the level existed`);
      if (s.reclaim && s.reclaim.knownAt < s.sweep!.knownAt) add(`A9 ${at}: ${s.id} reclaim before sweep`);
      if (s.m5 && s.m5.knownAt < s.reclaim!.knownAt) add(`A9 ${at}: ${s.id} M5 before reclaim`);
      if (s.zone && s.zone.definedAt !== s.m5?.knownAt) add(`A9 ${at}: ${s.id} zone not defined at the M5 confirmation close`);
      if (s.entry && s.entry.time < s.m5!.knownAt) add(`A9 ${at}: ${s.id} M1 entry bar opened before M5 confirmed`);
      if (s.state === 'ENTRY_READY') for (const [k, ok] of Object.entries(mandatoryGates(s))) if (!ok) add(`A10 ${at}: ${s.id} ENTRY_READY without "${k}"`);
    }

    if (cps.has(K)) {
      checkpoints += 1;
      const norm = (x: HLESnapshot) => j({ ...x, price: null, levels: x.levels.map((l) => ({ ...l, distance: null })), setups: x.setups.map((s) => ({ ...s, distance: null })) });
      if (norm(eng.snapshot()) !== norm(analyzeHLEAt(ds, K, null))) add(`A1 ${at}: incremental state ≠ clean recomputation on the bars known then`);
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
    events: finEvents.length,
    violations: v,
  };
}
