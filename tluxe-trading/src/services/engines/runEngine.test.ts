import { describe, expect, it, vi } from 'vitest';
import { getInstrument } from '../../config/instruments';
import type { AnalysisEngine } from '../../types/engine';
import { EngineInstrumentError, runEngine } from './runEngine';

const engine = (over: Partial<AnalysisEngine> = {}): AnalysisEngine => ({
  id: 'probe',
  label: 'Probe',
  supports: (i) => i.tradable,
  analyze: vi.fn((input) => ({ instrumentId: input.instrumentId, timeframe: input.timeframe, overlays: [] })),
  ...over,
});

describe('engine contract: explicit instrument', () => {
  it('passes the exact requested instrument to the engine', () => {
    const e = engine();
    runEngine(e, { instrumentId: 'XAGUSD', timeframe: 'M15', candles: [] }, getInstrument);
    expect(e.analyze).toHaveBeenCalledWith(expect.objectContaining({ instrumentId: 'XAGUSD' }), getInstrument('XAGUSD'));
  });

  it('refuses a missing or unknown instrument', () => {
    expect(() => runEngine(engine(), { instrumentId: '', timeframe: 'H1', candles: [] }, getInstrument)).toThrow(EngineInstrumentError);
    expect(() => runEngine(engine(), { instrumentId: 'CADUSD', timeframe: 'H1', candles: [] }, getInstrument)).toThrow(/unknown/);
  });

  it('refuses instruments the engine does not support', () => {
    expect(() => runEngine(engine(), { instrumentId: 'NASDAQ', timeframe: 'H1', candles: [] }, getInstrument)).toThrow(/does not support/);
  });

  it('rejects output labelled with a different instrument (e.g. a silent GC assumption)', () => {
    const lazy = engine({ analyze: () => ({ instrumentId: 'GC', timeframe: 'H1', overlays: [] }) });
    expect(() => runEngine(lazy, { instrumentId: 'XAUUSD', timeframe: 'H1', candles: [] }, getInstrument)).toThrow(/expected XAUUSD/);
  });
});
