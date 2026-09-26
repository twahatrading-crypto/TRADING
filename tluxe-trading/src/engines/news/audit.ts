import type { Candle } from '../../types/market';
import { measureReaction } from './reaction';
import type { NewsSnapshot, NewsUpdate } from './types';

/*
 * ANTI-LOOK-AHEAD AUDIT. For every audit time T:
 *   parity   an engine holding the FULL history evaluated at T equals a CLEAN engine built only
 *            from the updates known by T (JSON-identical snapshot)
 *   leakage  at T no event is visible before its first knownAt, no Actual before its knownAt, no
 *            revision before its revisedAt, no headline before its publication
 *   reaction measured with every candle = measured with only candles closed by T, and no horizon
 *            price comes from a candle closing after T
 * A cheating engine (e.g. one that ignores knownAt) fails parity and leakage (proved in tests).
 */
export interface PointInTimeEngine {
  snapshot(T: number): NewsSnapshot;
}
export interface NewsAuditResult {
  checks: number;
  mismatches: { T: number; detail: string }[];
  leaks: { T: number; key: string; detail: string }[];
}

export function auditNews(o: { updates: readonly NewsUpdate[]; times: readonly number[]; build: (updates: readonly NewsUpdate[]) => PointInTimeEngine; reaction?: { instrumentId: string; m1: readonly Candle[] } }): NewsAuditResult {
  const res: NewsAuditResult = { checks: 0, mismatches: [], leaks: [] };
  const full = o.build(o.updates);
  for (const T of o.times) {
    const a = full.snapshot(T);
    const b = o.build(o.updates.filter((u) => u.knownAt <= T)).snapshot(T);
    res.checks += 1;
    if (JSON.stringify(a) !== JSON.stringify(b)) res.mismatches.push({ T, detail: 'full-history state at T differs from the clean state built from data known by T' });
    for (const e of a.events) {
      if (e.firstKnownAt > T) res.leaks.push({ T, key: e.key, detail: 'event visible before it was known' });
      if (e.actual && (e.actualKnownAt === null || e.actualKnownAt > T)) res.leaks.push({ T, key: e.key, detail: 'Actual visible before it was released / known' });
      for (const r of e.revisions) if (r.revisedAt > T) res.leaks.push({ T, key: e.key, detail: `${r.field} revision visible before it was published` });
      if (e.kind === 'HEADLINE' && (e.publishedAt ?? Infinity) > T) res.leaks.push({ T, key: e.key, detail: 'headline visible before publication' });
      if (o.reaction && e.kind === 'SCHEDULED' && e.scheduledAt !== null) {
        const r1 = measureReaction(o.reaction.instrumentId, e.scheduledAt, o.reaction.m1, T);
        const r2 = measureReaction(o.reaction.instrumentId, e.scheduledAt, o.reaction.m1.filter((c) => (c.time + 60) * 1000 <= T), T);
        if (JSON.stringify(r1) !== JSON.stringify(r2)) res.mismatches.push({ T, detail: `reaction for ${e.key} uses candles not closed by T` });
        for (const h of r1.horizons) if (h.state === 'OK' && h.time > T) res.leaks.push({ T, key: e.key, detail: `+${h.minutes}m reaction from a candle closing after T` });
      }
    }
  }
  return res;
}
