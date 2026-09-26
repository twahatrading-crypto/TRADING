import { auditSmc, type SmcAuditResult } from '../../engines/smc/antiRepaint';
import { SMC_TIMEFRAMES } from '../../engines/smc/config';
import { smcKnowledgeTimes, type SmcDataset } from '../../engines/smc/knowledge';
import type { Timeframe } from '../../types/market';

export interface SmcAuditReport {
  instrumentId: string;
  bars: Record<Timeframe, number>;
  knowledgeTimes: number;
  audit: SmcAuditResult;
  passed: boolean;
  firstProblem: string | null;
  ms: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * "Verify No-Repaint" on the loaded REAL candles (read-only): incremental engine vs clean recomputation,
 * future-leakage and frozen-field checks at up to `maxChecks` knowledge times spread over the history
 * (always including the last one).
 */
export async function runSmcAudit(ds: SmcDataset, maxChecks = 240, onProgress?: (label: string) => void): Promise<SmcAuditReport> {
  const t0 = performance.now();
  onProgress?.('stepping closed candles');
  await tick();
  const times = smcKnowledgeTimes(ds);
  const stride = Math.max(1, Math.ceil(times.length / maxChecks));
  const audit = auditSmc(ds, { times, stride });
  const bars = Object.fromEntries(SMC_TIMEFRAMES.map((tf) => [tf, ds.candles[tf]?.length ?? 0])) as Record<Timeframe, number>;
  const passed = audit.mismatches.length === 0 && audit.leaks.length === 0 && audit.mutations.length === 0;
  const p = audit.mismatches[0] ? `${audit.mismatches[0].tf ?? 'MTF'} differs at ${new Date(audit.mismatches[0].K * 1000).toISOString()}` : audit.leaks[0] ? `future leak: ${audit.leaks[0].id}` : audit.mutations[0] ? `frozen field changed: ${audit.mutations[0].id}` : null;
  return { instrumentId: ds.instrumentId, bars, knowledgeTimes: times.length, audit, passed, firstProblem: p, ms: Math.round(performance.now() - t0) };
}
