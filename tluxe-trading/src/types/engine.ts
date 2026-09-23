import type { InstrumentDefinition, InstrumentId } from './instruments';
import type { Candle, Timeframe } from './market';
import type { ChartOverlay } from './overlays';

/**
 * Contract for every future strategy/analysis engine.
 *
 * The instrument is ALWAYS explicit: engines receive `instrumentId` and must
 * never assume GC (or any symbol) internally. Engines are pure computation,
 * run outside React, and return data — never UI.
 */
export interface EngineInput {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  candles: readonly Candle[];
}

export interface EngineOutput {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  overlays: ChartOverlay[];
}

export interface AnalysisEngine {
  id: string;
  label: string;
  /** Which instruments this engine is valid for (e.g. futures only, or all). */
  supports(instrument: InstrumentDefinition): boolean;
  analyze(input: EngineInput, instrument: InstrumentDefinition): EngineOutput;
}
