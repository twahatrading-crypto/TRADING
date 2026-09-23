import { describe, expect, it, vi } from 'vitest';
import { ChartController } from './ChartController';

function fakeLib() {
  const series = () => ({
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
    priceScale: () => ({ applyOptions: vi.fn() }),
  });
  const candle = series();
  const volume = series();
  const chart = {
    addSeries: vi.fn((kind: string) => (kind === 'candles' ? candle : volume)),
    priceScale: () => ({ applyOptions: vi.fn() }),
    remove: vi.fn(),
  };
  const lib = {
    createChart: vi.fn(() => chart),
    CandlestickSeries: 'candles',
    HistogramSeries: 'volume',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
  };
  return { lib: lib as never, chart, candle, volume };
}

describe('ChartController', () => {
  it('maps candles to series data and omits unknown volume instead of drawing 0', () => {
    const { lib, candle, volume } = fakeLib();
    const ctl = new ChartController(lib, document.createElement('div'), 1);
    ctl.setData([
      { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 },
      { time: 200, open: 1.5, high: 2, low: 1, close: 1.2, volume: null },
    ]);
    expect(candle.setData).toHaveBeenCalledWith([
      { time: 100, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 200, open: 1.5, high: 2, low: 1, close: 1.2 },
    ]);
    const vols = volume.setData.mock.calls[0]![0] as { time: number; value?: number }[];
    expect(vols[0]!.value).toBe(7);
    expect(vols[1]).toEqual({ time: 200 });
  });

  it('updates only the last bar on upsert and cleans up on destroy', () => {
    const { lib, chart, candle } = fakeLib();
    const ctl = new ChartController(lib, document.createElement('div'), 1);
    ctl.upsert({ time: 300, open: 1, high: 1, low: 1, close: 1, volume: null });
    expect(candle.update).toHaveBeenCalledTimes(1);
    expect(candle.setData).not.toHaveBeenCalled();
    ctl.destroy();
    expect(chart.remove).toHaveBeenCalled();
  });

  it('draws level overlays as price lines and replaces them on update', () => {
    const { lib, candle } = fakeLib();
    const ctl = new ChartController(lib, document.createElement('div'), 1);
    ctl.setOverlays([{ id: 'a', kind: 'session-level', shape: 'level', price: 10 }]);
    ctl.setOverlays([]);
    expect(candle.createPriceLine).toHaveBeenCalledTimes(1);
    expect(candle.removePriceLine).toHaveBeenCalledTimes(1);
  });
});
