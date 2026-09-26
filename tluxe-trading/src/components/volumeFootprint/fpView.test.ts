import { describe, expect, it } from 'vitest';
import { FootprintEngine } from '../../engines/volumeFootprint/engine';
import { generatedStream } from '../../engines/volumeFootprint/testing/stream';
import { detailLevel } from '../chart/FootprintPrimitive';
import { DEFAULT_FP_TOGGLES, chartCandle, cvdSeries, fpMarkers } from './fpView';

/* TEST DATA ONLY. */
const e = new FootprintEngine({ instrumentId: 'GC', tickSize: 0.1 });
e.processAll(generatedStream({ minutes: 60, seed: 21 }));

describe('fpView', () => {
  it('text density follows the zoom only: cells → single number → full Bid × Ask', () => {
    expect(detailLevel(8, 12, 'AUTO')).toBe('none');
    expect(detailLevel(30, 12, 'AUTO')).toBe('cells');
    expect(detailLevel(50, 12, 'AUTO')).toBe('single');
    expect(detailLevel(96, 12, 'AUTO')).toBe('full');
    expect(detailLevel(96, 5, 'AUTO')).toBe('cells');
    expect(detailLevel(96, 7.5, 'AUTO')).toBe('full');
    expect(detailLevel(60, 12, 'HIGH')).toBe('full');
  });

  it('chart candles are the engine OHLC + real traded volume; closed candles map to stable objects', () => {
    const c = e.candles('M5')[0]!;
    const a = chartCandle(c);
    expect(a).toMatchObject({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    expect(chartCandle(c)).toBe(a);
  });

  it('CVD series = running sum of candle deltas', () => {
    const cs = e.candles('M5');
    const s = cvdSeries(cs);
    expect(s.at(-1)!.value).toBe(cs.reduce((n, c) => n + c.delta, 0));
  });

  it('markers only for toggled engine candidates, placed on the candle that produced them', () => {
    const cs = e.candles('M5');
    const ev = e.events('M5');
    const all = fpMarkers(ev, 'M5', DEFAULT_FP_TOGGLES, cs);
    const times = new Set(cs.map((c) => c.time));
    for (const m of all) expect(times.has(m.time)).toBe(true);
    const none = fpMarkers(ev, 'M5', { ...DEFAULT_FP_TOGGLES, stacked: false, absorption: false, exhaustion: false, divergence: false }, cs);
    expect(none).toHaveLength(0);
  });
});
