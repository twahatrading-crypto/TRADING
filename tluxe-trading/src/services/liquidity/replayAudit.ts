import { auditLiquidity, type LiquidityAuditResult } from '../../engines/liquidity/antiRepaint';
import { LIQUIDITY_TIMEFRAMES } from '../../engines/liquidity/config';
import { analyzeLiquidityAt, type LiquidityDataset } from '../../engines/liquidity/knowledge';
import type { Timeframe } from '../../types/market';
import { LiquidityReplaySession } from './LiquidityReplay';

export interface LiquidityAuditReport {
  instrumentId: string;
  perTimeframe: LiquidityAuditResult[];
  mtf: { timeframe: Timeframe; points: number; violations: string[] };
  passed: boolean;
  ms: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Runs the Liquidity anti-repaint audit on the loaded candles (read-only; never touches live state). */
export async function runLiquidityAudit(ds: LiquidityDataset, chartTf: Timeframe, onProgress?: (label: string, done: number, total: number) => void): Promise<LiquidityAuditReport> {
  const t0 = performance.now();
  const tfs = LIQUIDITY_TIMEFRAMES.filter((tf) => (ds.candles[tf]?.length ?? 0) > 0);
  const total = tfs.length + 1;
  const perTimeframe: LiquidityAuditResult[] = [];
  for (const [k, tf] of tfs.entries()) {
    onProgress?.(tf, k, total);
    await tick();
    perTimeframe.push(auditLiquidity({ instrumentId: ds.instrumentId, timeframe: tf, candles: ds.candles[tf]!, tickSize: ds.tickSize, settings: ds.settings, checkpoints: 24 }));
  }
  onProgress?.('MTF', tfs.length, total);
  await tick();
  const mtf = { timeframe: chartTf, points: 0, violations: [] as string[] };
  const n = ds.candles[chartTf]?.length ?? 0;
  if (n > 0) {
    const s = new LiquidityReplaySession(ds, chartTf, { startIndex: 0 });
    for (const f of [0.9, 0.3, 0.31, 0.7, 0.5, 0.1, 0.99, 0.6, 0.2, 0.8]) {
      const i = Math.min(n - 1, Math.floor(f * n));
      s.seek(i);
      const st = s.store.getState();
      if (st.knowledgeTime === null) continue;
      mtf.points += 1;
      if (JSON.stringify(analyzeLiquidityAt(ds, st.knowledgeTime, st.price)) !== JSON.stringify(st.multi)) mtf.violations.push(`MTF replay at bar ${i} differs from a fresh no-future analysis`);
    }
    s.dispose();
  }
  onProgress?.('done', total, total);
  return { instrumentId: ds.instrumentId, perTimeframe, mtf, passed: perTimeframe.every((r) => r.violations.length === 0) && mtf.violations.length === 0, ms: Math.round(performance.now() - t0) };
}
