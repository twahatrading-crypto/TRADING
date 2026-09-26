import type { InstrumentId } from '../../types/instruments';
import type { FootprintSettings } from './config';
import { FootprintEngine } from './engine';
import type { FPCandle, FPEvent, FootprintMsg } from './types';

/*
 * REPLAY / ANTI-REPAINT. Knowledge time = local RECEIVE time: at T the engine knows exactly the messages
 * received by T (in receive order) — no later trade, candle, imbalance or delta.
 *   parity  an engine fed message by message == a fresh engine fed only the messages received by T
 *   leakage no trade received after T is counted; knowledge time ≤ T
 *   frozen  a CLOSED candle (rows, totals, POC, imbalance counts) and every emitted event never change later
 */

export interface FPDataset {
  instrumentId: InstrumentId;
  tickSize: number;
  settings: FootprintSettings;
  messages: readonly FootprintMsg[];
}

export function fpKnownBy(msgs: readonly FootprintMsg[], K: number): FootprintMsg[] {
  return msgs.filter((m) => m.recvTime <= K);
}

export function analyzeFootprintAt(ds: FPDataset, K: number): FootprintEngine {
  const e = new FootprintEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings: ds.settings });
  e.processAll(fpKnownBy(ds.messages, K));
  return e;
}

/** Knowledge times at which every message received at that time has been delivered. */
export function fpKnowledgeTimes(msgs: readonly FootprintMsg[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < msgs.length; i++) if (i === msgs.length - 1 || msgs[i + 1]!.recvTime > msgs[i]!.recvTime) out.push(msgs[i]!.recvTime);
  return out;
}

export interface FPAuditResult {
  checks: number;
  mismatches: { K: number; detail: string }[];
  leaks: { K: number; detail: string }[];
  mutations: { K: number; id: string }[];
}

const closedFingerprints = (e: FootprintEngine) => {
  const m = new Map<string, string>();
  for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1'] as const) {
    for (const c of e.candles(tf)) if (c.closed) m.set(c.id, JSON.stringify(c));
    for (const ev of e.events(tf)) m.set(`ev:${ev.id}`, JSON.stringify(ev));
  }
  return m;
};

export function auditFootprint(ds: FPDataset, o: { stride?: number } = {}): FPAuditResult {
  const res: FPAuditResult = { checks: 0, mismatches: [], leaks: [], mutations: [] };
  const times = fpKnowledgeTimes(ds.messages);
  const stride = Math.max(1, o.stride ?? 1);
  const checkpoints = new Set(times.filter((_, k) => k % stride === 0 || k === times.length - 1));
  const inc = new FootprintEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings: ds.settings });
  const seen = new Map<string, string>();
  let trades = 0;
  for (let i = 0; i < ds.messages.length; i++) {
    const m = ds.messages[i]!;
    inc.process(m);
    if (m.type === 'trade') trades += 1;
    const K = m.recvTime;
    const last = i === ds.messages.length - 1 || ds.messages[i + 1]!.recvTime > K;
    if (!last || !checkpoints.has(K)) continue;
    res.checks += 1;
    const clean = analyzeFootprintAt(ds, K);
    if (JSON.stringify(inc.fullState()) !== JSON.stringify(clean.fullState())) res.mismatches.push({ K, detail: 'incremental state differs from the clean recomputation' });
    const snap = inc.snapshot();
    if (snap.knowledgeTime !== null && snap.knowledgeTime > K) res.leaks.push({ K, detail: 'knowledge time after K' });
    if (snap.integrity.accepted + snap.integrity.duplicates + snap.integrity.late > trades) res.leaks.push({ K, detail: 'more trades counted than received' });
    const fp = closedFingerprints(inc);
    for (const [id, v] of fp) {
      const prev = seen.get(id);
      if (prev !== undefined && prev !== v) res.mutations.push({ K, id });
      seen.set(id, v);
    }
    for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1'] as const) {
      // Candle events are timed at the candle close, which the exchange clock must already have reached.
      const bad = inc.events(tf).find((e: FPEvent) => e.tf !== null && e.time * 1000 > (snap.integrity.lastExchTime ?? -Infinity));
      if (bad) res.leaks.push({ K, detail: `event ${bad.id} timed after K` });
      const future = inc.candles(tf).find((c: FPCandle) => c.time * 1000 > (snap.integrity.lastExchTime ?? 0));
      if (future) res.leaks.push({ K, detail: `candle ${future.id} opens after the last exchange time` });
    }
  }
  return res;
}
