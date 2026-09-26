import { VolumeProfileEngine } from './engine';
import { analyzeVPAt, vpKnowledgeTimes, vpKnownInput, type VPDataset } from './knowledge';
import type { VPSnapshot } from './types';

/*
 * VOLUME PROFILE ANTI-REPAINT AUDIT, at every knowledge time K (or a stride of them):
 *   parity    incremental engine (fed candle by candle) == clean recomputation from candles closed by K
 *   leakage   no profile uses a bar closing after K; no event, node confirmation or acceptance is
 *             timed after K
 *   frozen    a COMPLETED profile (POC / VAH / VAL / rows / nodes) and every logged event never
 *             change once seen
 */
export interface VPAuditResult {
  checks: number;
  mismatches: { K: number; detail: string }[];
  leaks: { K: number; detail: string }[];
  mutations: { K: number; id: string }[];
}

const frozen = (s: VPSnapshot) => {
  const m = new Map<string, string>();
  for (const p of Object.values(s.profiles)) if (p && p.complete) m.set(p.id, JSON.stringify([p.poc, p.vah, p.val, p.total, p.rows, p.hvn.map((n) => [n.id, n.low, n.high, n.strength]), p.lvn.map((n) => [n.id, n.low, n.high, n.strength])]));
  for (const e of s.events) m.set(e.id, JSON.stringify([e.time, e.type, e.price, e.message]));
  return m;
};

export function auditVolumeProfile(ds: VPDataset, o: { stride?: number; times?: number[] } = {}): VPAuditResult {
  const res: VPAuditResult = { checks: 0, mismatches: [], leaks: [], mutations: [] };
  const all = o.times ?? vpKnowledgeTimes(ds);
  const stride = Math.max(1, o.stride ?? 1);
  const times = all.filter((_, k) => k % stride === 0 || k === all.length - 1);
  const inc = new VolumeProfileEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, instrument: ds.instrument, settings: ds.settings });
  const seen = new Map<string, string>();
  for (const K of times) {
    inc.update(vpKnownInput(ds, K), { currentPrice: null });
    const a = inc.snapshot();
    const b = analyzeVPAt(ds, K, null);
    res.checks += 1;
    if (JSON.stringify(a) !== JSON.stringify(b)) res.mismatches.push({ K, detail: 'incremental state differs from the clean recomputation' });
    if (a.knowledgeTime !== null && a.knowledgeTime > K) res.leaks.push({ K, detail: 'knowledge time after K' });
    for (const p of Object.values(a.profiles)) if (p && p.lastBarClose !== null && p.lastBarClose > K) res.leaks.push({ K, detail: `${p.id} uses a bar closing after K` });
    for (const e of a.events) if (e.time > K) res.leaks.push({ K, detail: `event ${e.id} after K` });
    for (const n of a.nodes) if (n.confirmedAt !== null && n.confirmedAt > K) res.leaks.push({ K, detail: `node ${n.id} confirmed after K` });
    if (a.acceptance?.at && a.acceptance.at > K) res.leaks.push({ K, detail: 'acceptance timed after K' });
    for (const [id, v] of frozen(a)) {
      const prev = seen.get(id);
      if (prev !== undefined && prev !== v) res.mutations.push({ K, id });
      seen.set(id, v);
    }
  }
  return res;
}
