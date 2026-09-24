import { auditHighLowReversal, type HLRAuditResult } from '../../engines/hlReversal/antiRepaint';
import type { HLRDataset } from '../../engines/hlReversal/knowledge';
import type { HLRTimeframe } from '../../engines/hlReversal/types';
import { HLRReplaySession } from './HLRReplay';

export interface HLRAuditReport {
  instrumentId: string;
  bars: Record<HLRTimeframe, number>;
  audit: HLRAuditResult;
  replay: { timeframe: HLRTimeframe; steps: number; mismatches: string[] };
  passed: boolean;
  ms: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** High / Low Reversal anti-repaint audit + replay parity on the loaded candles (read-only). */
export async function runHLRAudit(ds: HLRDataset, chartTf: HLRTimeframe, onProgress?: (label: string) => void): Promise<HLRAuditReport> {
  const t0 = performance.now();
  onProgress?.('stepping every closed bar');
  await tick();
  const audit = auditHighLowReversal({ ...ds, checkpoints: 16 });
  onProgress?.('replay parity');
  await tick();
  const replay = { timeframe: chartTf, steps: 0, mismatches: [] as string[] };
  const n = ds.candles[chartTf]?.length ?? 0;
  if (n > 0) {
    const s = new HLRReplaySession(ds, chartTf, { startIndex: 0, verify: true });
    for (const f of [0.9, 0.3, 0.31, 0.7, 0.5, 0.1, 0.99, 0.6, 0.2, 0.8]) {
      s.seek(Math.min(n - 1, Math.floor(f * n)));
      const p = s.store.getState().parity;
      if (!p) continue;
      replay.steps += 1;
      replay.mismatches.push(...p.mismatches.map((m) => `bar ${s.store.getState().cursor}: ${m}`));
    }
    s.dispose();
  }
  const bars = { H4: 0, H1: 0, M15: 0, M5: 0, M1: 0 } as Record<HLRTimeframe, number>;
  for (const tf of Object.keys(bars) as HLRTimeframe[]) bars[tf] = ds.candles[tf]?.length ?? 0;
  return { instrumentId: ds.instrumentId, bars, audit, replay, passed: audit.violations.length === 0 && replay.mismatches.length === 0, ms: Math.round(performance.now() - t0) };
}
