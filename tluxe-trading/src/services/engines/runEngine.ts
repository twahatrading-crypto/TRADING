import type { AnalysisEngine, EngineInput, EngineOutput } from '../../types/engine';
import type { InstrumentDefinition } from '../../types/instruments';

export class EngineInstrumentError extends Error {}

/**
 * The only way engines are invoked. Guarantees the engine gets a known,
 * supported instrument and that its output is labelled with that same
 * instrument — so results can never be attributed to the wrong symbol.
 */
export function runEngine(
  engine: AnalysisEngine,
  input: EngineInput,
  lookup: (id: string) => InstrumentDefinition | undefined,
): EngineOutput {
  if (!input.instrumentId) throw new EngineInstrumentError(`${engine.id}: instrumentId is required`);
  const instrument = lookup(input.instrumentId);
  if (!instrument) throw new EngineInstrumentError(`${engine.id}: unknown instrument "${input.instrumentId}"`);
  if (!engine.supports(instrument)) throw new EngineInstrumentError(`${engine.id}: does not support ${instrument.id}`);
  const out = engine.analyze(input, instrument);
  if (out.instrumentId !== input.instrumentId || out.timeframe !== input.timeframe) {
    throw new EngineInstrumentError(`${engine.id}: output labelled ${out.instrumentId}/${out.timeframe}, expected ${input.instrumentId}/${input.timeframe}`);
  }
  return out;
}
