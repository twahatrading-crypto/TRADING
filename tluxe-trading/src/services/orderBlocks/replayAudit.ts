import { auditOrderBlocks, type OBAuditResult } from '../../engines/orderBlocks/antiRepaint';
import { OB_TIMEFRAMES } from '../../engines/orderBlocks/config';
import type { OBDataset } from '../../engines/orderBlocks/knowledge';
import type { Timeframe } from '../../types/market';
import { OrderBlockReplaySession } from './OrderBlockReplay';

export interface OBAuditReport {
  instrumentId: string;
  perTimeframe: OBAuditResult[];
  replay: { timeframe: Timeframe; steps: number; mismatches: string[] };
  passed: boolean;
  ms: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Order Block anti-repaint audit + replay parity on the loaded candles (read-only). */
export async function runOrderBlockAudit(ds: OBDataset, chartTf: Timeframe, onProgress?: (label: string, done: number, total: number) => void): Promise<OBAuditReport> {
  const t0 = performance.now();
  const tfs = OB_TIMEFRAMES.filter((tf) => (ds.candles[tf]?.length ?? 0) > 0);
  const total = tfs.length + 1;
  const perTimeframe: OBAuditResult[] = [];
  for (const [k, tf] of tfs.entries()) {
    onProgress?.(tf, k, total);
    await tick();
    perTimeframe.push(auditOrderBlocks({ instrumentId: ds.instrumentId, timeframe: tf, candles: ds.candles[tf]!, tickSize: ds.tickSize, settings: ds.settings, checkpoints: 24 }));
  }
  onProgress?.('replay parity', tfs.length, total);
  await tick();
  const replay = { timeframe: chartTf, steps: 0, mismatches: [] as string[] };
  const n = ds.candles[chartTf]?.length ?? 0;
  if (n > 0) {
    const s = new OrderBlockReplaySession(ds, chartTf, { startIndex: 0, verify: true });
    for (const f of [0.9, 0.3, 0.31, 0.7, 0.5, 0.1, 0.99, 0.6, 0.2, 0.8]) {
      s.seek(Math.min(n - 1, Math.floor(f * n)));
      const p = s.store.getState().parity;
      if (!p) continue;
      replay.steps += 1;
      replay.mismatches.push(...p.mismatches.map((m) => `bar ${s.store.getState().cursor}: ${m}`));
    }
    s.dispose();
  }
  onProgress?.('done', total, total);
  return { instrumentId: ds.instrumentId, perTimeframe, replay, passed: perTimeframe.every((r) => r.violations.length === 0) && replay.mismatches.length === 0, ms: Math.round(performance.now() - t0) };
}
