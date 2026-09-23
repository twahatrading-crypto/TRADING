import { auditTimeframe, type AuditResult } from '../../engines/sr/antiRepaint';
import { analyzeAt, REPLAY_TIMEFRAMES, type ReplayDataset } from '../../engines/sr/knowledge';
import type { Timeframe } from '../../types/market';
import { SRReplaySession } from './SRReplay';

export interface ReplayAuditReport {
  instrumentId: string;
  perTimeframe: AuditResult[];
  /** Replay session vs. fresh no-future oracle at jumbled cursor positions (all timeframes + confluence). */
  mtf: { timeframe: Timeframe; points: number; violations: string[] };
  passed: boolean;
  ms: number;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Runs the anti-repaint audit on the candles a replay was started from (real
 * MT5 history in the app). Read-only: it never touches live engines or stores.
 */
export async function runReplayAudit(
  ds: ReplayDataset,
  chartTf: Timeframe,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<ReplayAuditReport> {
  const t0 = performance.now();
  const tfs = REPLAY_TIMEFRAMES.filter((tf) => (ds.candles[tf]?.length ?? 0) > 0);
  const total = tfs.length + 1;
  const perTimeframe: AuditResult[] = [];

  for (const [k, tf] of tfs.entries()) {
    onProgress?.(k, total, tf);
    await yieldToUi();
    perTimeframe.push(auditTimeframe({ instrumentId: ds.instrumentId, timeframe: tf, candles: ds.candles[tf]!, tickSize: ds.tickSize, settings: ds.settings, checkpoints: 24 }));
  }

  onProgress?.(tfs.length, total, 'MTF');
  await yieldToUi();
  const mtf = { timeframe: chartTf, points: 0, violations: [] as string[] };
  const n = ds.candles[chartTf]?.length ?? 0;
  if (n > 0) {
    const session = new SRReplaySession(ds, chartTf, { startIndex: 0 });
    // Deterministic jumbled order: forward, backward and long jumps.
    const order = [0.9, 0.3, 0.31, 0.7, 0.5, 0.52, 0.1, 0.99, 0.6, 0.2, 0.8, 0.45].map((f) => Math.min(n - 1, Math.floor(f * n)));
    for (const i of order) {
      session.seek(i);
      const s = session.store.getState();
      if (s.knowledgeTime === null) continue;
      mtf.points += 1;
      const oracle = analyzeAt(ds, s.knowledgeTime, s.price);
      if (JSON.stringify(oracle) !== JSON.stringify(s.multi)) mtf.violations.push(`MTF replay at bar ${i} differs from a fresh no-future analysis`);
      for (const [tf, snap] of Object.entries(s.byTimeframe)) {
        if (snap && snap.lastClosedTime !== null && snap.lastClosedTime > s.knowledgeTime) mtf.violations.push(`MTF ${tf} used a bar after the replay time at bar ${i}`);
      }
    }
    session.dispose();
  }
  onProgress?.(total, total, 'done');

  return {
    instrumentId: ds.instrumentId,
    perTimeframe,
    mtf,
    passed: perTimeframe.every((r) => r.violations.length === 0) && mtf.violations.length === 0,
    ms: Math.round(performance.now() - t0),
  };
}
