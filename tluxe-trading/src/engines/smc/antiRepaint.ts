import type { Timeframe } from '../../types/market';
import { SMC_TF_SECONDS, SMC_TIMEFRAMES } from './config';
import { SmcEngine } from './engine';
import { analyzeSmcAt, smcKnowledgeTimes, smcKnownInput, type SmcDataset } from './knowledge';
import type { SmcSnapshot } from './types';

/*
 * SMC ANTI-REPAINT AUDIT. For every knowledge time K (every candle close of every timeframe, or a
 * stride of them):
 *   parity    the INCREMENTAL engine fed candle-by-candle equals a CLEAN recomputation from only the
 *             candles closed by K (full snapshot, JSON-identical)
 *   leakage   no object has validFrom > K, and no object's confirming bar closes after K
 *   frozen    once seen, the frozen fields of swings, breaks, FVGs, displacements and dealing-range
 *             anchors never change later (only lifecycle fields may)
 */

export interface SmcAuditResult {
  checks: number;
  mismatches: { K: number; tf: Timeframe | null; detail: string }[];
  leaks: { K: number; tf: Timeframe; id: string; validFrom: number }[];
  mutations: { K: number; id: string; before: string; after: string }[];
}

const frozenOf = (s: SmcSnapshot): Map<string, string> => {
  const m = new Map<string, string>();
  for (const tf of SMC_TIMEFRAMES) {
    const x = s.byTimeframe[tf];
    if (!x) continue;
    for (const w of x.swings) m.set(w.id, JSON.stringify([w.price, w.originTime, w.confirmedAt, w.validFrom, w.label, w.prevPrice]));
    for (const b of x.breaks) m.set(b.id, JSON.stringify([b.kind, b.direction, b.swingId, b.level, b.close, b.breakDistance, b.confirmedAt, b.validFrom, b.initial, b.displacementId, b.prevState]));
    for (const f of x.fvgs) m.set(f.id, JSON.stringify([f.direction, f.upper, f.lower, f.mid, f.size, f.confirmedAt, f.validFrom]));
    for (const d of x.displacements) m.set(d.id, JSON.stringify([d.direction, d.rule, d.startTime, d.confirmedAt, d.bars, d.netMove, d.maxBody]));
    for (const e of x.events) m.set(e.id, JSON.stringify([e.time, e.type, e.price]));
  }
  return m;
};

export function auditSmc(ds: SmcDataset, o: { stride?: number; times?: number[] } = {}): SmcAuditResult {
  const res: SmcAuditResult = { checks: 0, mismatches: [], leaks: [], mutations: [] };
  const all = o.times ?? smcKnowledgeTimes(ds);
  const stride = Math.max(1, o.stride ?? 1);
  const times = all.filter((_, k) => k % stride === 0 || k === all.length - 1);
  const inc = new SmcEngine({ instrumentId: ds.instrumentId, tickSize: ds.tickSize, settings: ds.settings });
  const seen = new Map<string, string>();
  for (const K of times) {
    inc.update(smcKnownInput(ds, K), { currentPrice: null });
    const a = inc.snapshot('REPLAY');
    const b = analyzeSmcAt(ds, K, null, 'REPLAY');
    res.checks += 1;
    const ja = JSON.stringify(a);
    if (ja !== JSON.stringify(b)) {
      const tf = SMC_TIMEFRAMES.find((t) => JSON.stringify(a.byTimeframe[t]) !== JSON.stringify(b.byTimeframe[t])) ?? null;
      res.mismatches.push({ K, tf, detail: tf ? 'timeframe snapshot differs' : 'aggregate differs' });
    }
    for (const tf of SMC_TIMEFRAMES) {
      const x = a.byTimeframe[tf];
      if (!x) continue;
      const objs = [...x.swings, ...x.breaks, ...x.fvgs, ...x.displacements, ...x.inducements, ...(x.range ? [x.range] : [])];
      for (const ob of objs) if (ob.validFrom > K || ob.confirmedAt + SMC_TF_SECONDS[tf] > K) res.leaks.push({ K, tf, id: ob.id, validFrom: ob.validFrom });
      for (const e of x.events) if (e.time > K) res.leaks.push({ K, tf, id: e.id, validFrom: e.time });
    }
    for (const [id, v] of frozenOf(a)) {
      const prev = seen.get(id);
      if (prev !== undefined && prev !== v) res.mutations.push({ K, id, before: prev, after: v });
      seen.set(id, v);
    }
  }
  return res;
}
