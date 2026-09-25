import { describe, expect, it, vi } from 'vitest';
import { ChartController, DEFAULT_BAR_SPACING, MAX_BAR_SPACING, MIN_BAR_SPACING, ZOOM_STEP } from './ChartController';

function fakeLib() {
  const series = () => ({
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  });
  const candle = series();
  const volume = series();
  const tsOpts = { barSpacing: 6, rightOffset: 4 };
  const timeScale = {
    options: () => ({ ...tsOpts }),
    applyOptions: vi.fn((o: Partial<typeof tsOpts>) => Object.assign(tsOpts, o)),
    scrollToPosition: vi.fn(),
    fitContent: vi.fn(),
  };
  const candleScale = { applyOptions: vi.fn() };
  candle.priceScale = vi.fn(() => candleScale);
  const chart = {
    timeScale: () => timeScale,
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
  return { lib: lib as never, rawLib: lib, chart, candle, volume, timeScale, tsOpts, candleScale };
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

  describe('navigation (presentation only)', () => {
    it('enables native wheel / pinch zoom, drag-pan and axis drag-scaling', () => {
      const { lib, rawLib } = fakeLib();
      new ChartController(lib, document.createElement('div'), 1);
      const opts = (rawLib.createChart.mock.calls[0] as unknown[])[1] as { handleScroll: unknown; handleScale: unknown };
      expect(opts.handleScroll).toEqual({ mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false });
      expect(opts.handleScale).toEqual({ mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } });
    });

    it('zoom in / out change only the bar spacing, clamped to sane limits', () => {
      const { lib, tsOpts } = fakeLib();
      const ctl = new ChartController(lib, document.createElement('div'), 1);
      ctl.zoomIn();
      expect(tsOpts.barSpacing).toBeCloseTo(6 * ZOOM_STEP);
      ctl.zoomOut();
      ctl.zoomOut();
      expect(tsOpts.barSpacing).toBeCloseTo(6 / ZOOM_STEP);
      for (let i = 0; i < 50; i++) ctl.zoomIn();
      expect(tsOpts.barSpacing).toBe(MAX_BAR_SPACING);
      for (let i = 0; i < 80; i++) ctl.zoomOut();
      expect(tsOpts.barSpacing).toBe(MIN_BAR_SPACING);
    });

    it('reset restores the default spacing, scrolls to the latest bar and re-enables price autoscale', () => {
      const { lib, tsOpts, timeScale, candleScale } = fakeLib();
      const ctl = new ChartController(lib, document.createElement('div'), 1);
      ctl.zoomIn();
      ctl.resetView();
      expect(tsOpts.barSpacing).toBe(DEFAULT_BAR_SPACING);
      expect(timeScale.scrollToPosition).toHaveBeenCalledWith(4, false); // latest bars + overlay label margin, no animation
      expect(candleScale.applyOptions).toHaveBeenLastCalledWith({ autoScale: true });
    });

    it('fit shows every loaded bar and autoscales price', () => {
      const { lib, timeScale, candleScale } = fakeLib();
      const ctl = new ChartController(lib, document.createElement('div'), 1);
      ctl.fitView();
      expect(timeScale.fitContent).toHaveBeenCalledTimes(1);
      expect(candleScale.applyOptions).toHaveBeenLastCalledWith({ autoScale: true });
    });

    it('never touches series data, and is a no-op after destroy', () => {
      const { lib, candle, volume, timeScale } = fakeLib();
      const ctl = new ChartController(lib, document.createElement('div'), 1);
      ctl.zoomIn();
      ctl.zoomOut();
      ctl.fitView();
      ctl.resetView();
      for (const s of [candle, volume]) {
        expect(s.setData).not.toHaveBeenCalled();
        expect(s.update).not.toHaveBeenCalled();
      }
      ctl.destroy();
      const n = timeScale.applyOptions.mock.calls.length;
      ctl.zoomIn();
      ctl.resetView();
      ctl.fitView();
      expect(timeScale.applyOptions.mock.calls.length).toBe(n);
      expect(timeScale.fitContent).toHaveBeenCalledTimes(1);
    });
  });
});
