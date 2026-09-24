import { auditHighLowEngine, type HLEAuditResult } from '../../engines/highLowEngine/antiRepaint';
import type { HLEDataset } from '../../engines/highLowEngine/knowledge';
import type { HLETimeframe } from '../../engines/highLowEngine/types';
import { HighLowReplaySession } from './HighLowReplay';

export interface HLEAuditReport {
  instrumentId: string;
  bars: Record<HLETimeframe, number>;
  audit: HLEAuditResult;
  replay: { timeframe: HLETimeframe; steps: number; mismatches: string[] };
  passed: boolean;
  /** First mismatch (audit first, then replay parity) — null on PASS. */
  firstMismatch: string | null;
  ms: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** "Verify No-Repaint": full audit + replay parity on the loaded candles (read-only). */
export async function runHighLowAudit(ds: HLEDataset, chartTf: HLETimeframe, onProgress?: (label: string) => void): Promise<HLEAuditReport> {
  const t0 = performance.now();
  onProgress?.('stepping every closed bar');
  await tick();
  const audit = auditHighLowEngine({ ...ds, checkpoints: 16 });
  onProgress?.('replay parity');
  await tick();
  const replay = { timeframe: chartTf, steps: 0, mismatches: [] as string[] };
  const n = ds.candles[chartTf]?.length ?? 0;
  if (n > 0) {
    const s = new HighLowReplaySession(ds, chartTf, { startIndex: 0, verify: true });
    for (const f of [0.9, 0.3, 0.31, 0.7, 0.5, 0.1, 0.99, 0.6, 0.2, 0.8]) {
      s.seek(Math.min(n - 1, Math.floor(f * n)));
      const p = s.store.getState().parity;
      if (!p) continue;
      replay.steps += 1;
      replay.mismatches.push(...p.mismatches.map((m) => `bar ${s.store.getState().cursor}: ${m}`));
    }
    s.dispose();
  }
  const bars = { H4: 0, H1: 0, M15: 0, M5: 0, M1: 0 } as Record<HLETimeframe, number>;
  for (const tf of Object.keys(bars) as HLETimeframe[]) bars[tf] = ds.candles[tf]?.length ?? 0;
  const passed = audit.violations.length === 0 && replay.mismatches.length === 0;
  return { instrumentId: ds.instrumentId, bars, audit, replay, passed, firstMismatch: audit.violations[0] ?? replay.mismatches[0] ?? null, ms: Math.round(performance.now() - t0) };
}
