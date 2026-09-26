import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { DEFAULT_SMC_SETTINGS, SMC_TIMEFRAMES, smcSettingsKey, type SmcSettings } from './config';
import { matrixRows, summarize } from './mtf';
import { smcScore } from './score';
import { SmcTimeframeEngine } from './timeframe';
import type { SmcFeed, SmcSnapshot, SmcTimeframeSnapshot } from './types';

export type SmcInput = Partial<Record<Timeframe, readonly Candle[]>>;
export interface SmcEngineOptions {
  instrumentId: InstrumentId;
  tickSize: number;
  settings?: SmcSettings;
}
export interface SmcUpdateResult {
  /** Timeframes that had to be rebuilt (history changed). */
  rebuilt: Timeframe[];
  /** Closed candles the broker revised (ACCEPT + LOG): the timeframe was rebuilt deterministically. */
  revised: { tf: Timeframe; time: number }[];
}

/**
 * SMC ENGINE (multi-timeframe). Every timeframe is analysed INDEPENDENTLY from its own closed candles
 * (D1 H4 H1 M30 M15 M5 M1); lower timeframes are never forced to match higher ones. The MTF matrix,
 * summary (no majority vote), conflicts and confluence score are derived afterwards from the seven
 * independent results. Pure and deterministic — no wall clock, no React.
 */
export class SmcEngine {
  readonly instrumentId: InstrumentId;
  readonly settings: SmcSettings;
  private readonly tickSize: number;
  private readonly tfs = new Map<Timeframe, SmcTimeframeEngine>();
  private price: number | null = null;

  constructor(o: SmcEngineOptions) {
    this.instrumentId = o.instrumentId;
    this.tickSize = o.tickSize;
    this.settings = o.settings ?? { ...DEFAULT_SMC_SETTINGS };
    for (const tf of SMC_TIMEFRAMES) this.tfs.set(tf, new SmcTimeframeEngine({ instrumentId: o.instrumentId, timeframe: tf, tickSize: o.tickSize, settings: this.settings }));
  }

  /** Closed candles per timeframe (ascending). `currentPrice` is display context only (location / distances). */
  update(input: SmcInput, o: { currentPrice?: number | null } = {}): SmcUpdateResult {
    const lastClose = (['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const).map((tf) => input[tf]?.[input[tf]!.length - 1]?.close).find((x) => x !== undefined) ?? null;
    this.price = o.currentPrice !== undefined && o.currentPrice !== null ? o.currentPrice : lastClose;
    const out: SmcUpdateResult = { rebuilt: [], revised: [] };
    for (const tf of SMC_TIMEFRAMES) {
      const r = this.tfs.get(tf)!.update(input[tf] ?? [], this.price);
      if (r.rebuilt) out.rebuilt.push(tf);
      for (const t of r.revised) out.revised.push({ tf, time: t });
    }
    return out;
  }

  timeframe(tf: Timeframe): SmcTimeframeSnapshot {
    return this.tfs.get(tf)!.snapshot();
  }

  snapshot(feed: SmcFeed = 'LIVE'): SmcSnapshot {
    const byTimeframe: SmcSnapshot['byTimeframe'] = {};
    for (const tf of SMC_TIMEFRAMES) byTimeframe[tf] = this.tfs.get(tf)!.snapshot();
    const dec = this.tickSize > 0 ? Math.max(0, Math.ceil(-Math.log10(this.tickSize) - 1e-9)) : 5;
    const fmt = (p: number) => p.toFixed(dec);
    const summary = summarize(byTimeframe, feed);
    const kts = SMC_TIMEFRAMES.map((tf) => byTimeframe[tf]!.knowledgeTime).filter((x): x is number => x !== null);
    const events = SMC_TIMEFRAMES.flatMap((tf) => byTimeframe[tf]!.events).sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      instrumentId: this.instrumentId,
      knowledgeTime: kts.length ? Math.max(...kts) : null,
      price: this.price,
      feed,
      byTimeframe,
      matrix: matrixRows(byTimeframe, fmt),
      summary,
      score: smcScore(byTimeframe, summary),
      events,
      settingsKey: smcSettingsKey(this.settings),
    };
  }
}

export function analyzeSmc(o: SmcEngineOptions & { candles: SmcInput; currentPrice?: number | null; feed?: SmcFeed }): SmcSnapshot {
  const e = new SmcEngine(o);
  e.update(o.candles, { currentPrice: o.currentPrice });
  return e.snapshot(o.feed);
}
