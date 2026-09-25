/**
 * Order-flow settings — the only place their defaults live. Defaults are for GC (COMEX gold,
 * tick 0.1, sizes in contracts) and are deliberately conservative; they are configurable per
 * instrument. Every detector rule is written out in `events.ts`.
 *
 * Visualisation settings (cut-offs, contrast, smoothing, colours, price aggregation) are applied
 * at render time and never change engine state. Engine settings (time aggregation, thresholds,
 * history) change results; a change rebuilds the engine deterministically from the recording.
 */
export interface OrderFlowEngineSettings {
  /** Heatmap column width (ms). */
  timeAggregationMs: number;
  /** Rolling heatmap history (columns). Older columns are trimmed. */
  maxColumns: number;
  /** A book is only carried forward across a silence of at most this long (else the columns are NO DATA). */
  maxCarryMs: number;
  /** Updates held while waiting for a resync snapshot (bounded). */
  maxResyncBuffer: number;
  /** Retained recent events. */
  maxEvents: number;

  /** LARGE TRADE: one print of at least this size. */
  largeTradeSize: number;

  /** LIQUIDITY HIT: displayed ≥ hitMinDepth at the price and ≥ hitFraction of it executed within hitWindowMs. */
  hitMinDepth: number;
  hitFraction: number;
  hitWindowMs: number;

  /** DEPTH SWEEP: same-side aggressive prints through ≥ sweepLevels distinct prices within sweepWindowMs. */
  sweepLevels: number;
  sweepWindowMs: number;

  /** STACKING: displayed size at a price rises by ≥ stackMinSize and to ≥ stackRatio × its size at the window start, within stackWindowMs. */
  stackMinSize: number;
  stackRatio: number;
  stackWindowMs: number;

  /** PULLING: displayed size falls by ≥ pullMinSize and ≥ pullRatio of its window-start size, NOT explained by executions, within pullWindowMs. */
  pullMinSize: number;
  pullRatio: number;
  pullWindowMs: number;

  /** ABSORPTION CANDIDATE: ≥ absorbMinVolume aggressive volume into one price within absorbWindowMs, price progress ≤ absorbMaxTicks, and ≥ absorbMinRemaining still displayed there. */
  absorbMinVolume: number;
  absorbMaxTicks: number;
  absorbMinRemaining: number;
  absorbWindowMs: number;
}

export const DEFAULT_ORDER_FLOW_SETTINGS: Readonly<OrderFlowEngineSettings> = Object.freeze({
  timeAggregationMs: 1000,
  maxColumns: 3600,
  maxCarryMs: 5000,
  maxResyncBuffer: 50_000,
  maxEvents: 500,
  largeTradeSize: 50,
  hitMinDepth: 100,
  hitFraction: 0.5,
  hitWindowMs: 500,
  sweepLevels: 3,
  sweepWindowMs: 250,
  stackMinSize: 150,
  stackRatio: 2,
  stackWindowMs: 5000,
  pullMinSize: 150,
  pullRatio: 0.5,
  pullWindowMs: 3000,
  absorbMinVolume: 300,
  absorbMaxTicks: 1,
  absorbMinRemaining: 50,
  absorbWindowMs: 10_000,
});

/** Render-only settings (never change engine state). */
export interface HeatmapViewSettings {
  /** Percentile cut-offs of the visible liquidity distribution (0–100). */
  lowerCutoff: number;
  upperCutoff: number;
  /** Gamma-like contrast (> 1 = more contrast). */
  contrast: number;
  /** Vertical smoothing radius in rows (0 = off). */
  smoothing: number;
  /** Ticks per heatmap row. */
  priceAggregation: number;
  /** Hide cells below this displayed size. */
  minDepth: number;
  colorScheme: 'blue-red' | 'mono' | 'thermal';
  autoNormalize: boolean;
  showTrades: boolean;
  showPriceLine: boolean;
}

export const DEFAULT_HEATMAP_VIEW: Readonly<HeatmapViewSettings> = Object.freeze({
  lowerCutoff: 60,
  upperCutoff: 99,
  contrast: 1.4,
  smoothing: 0,
  priceAggregation: 1,
  minDepth: 1,
  colorScheme: 'blue-red',
  autoNormalize: true,
  showTrades: true,
  showPriceLine: true,
});
