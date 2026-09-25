import { describe, expect, it } from 'vitest';
import type { OBDrawable } from '../orderBlocks/obView';
import { OrderBlockPrimitive } from './OrderBlockPrimitive';

/**
 * Overlays are drawn from the chart's CURRENT time/price → pixel mapping on every
 * frame, so zooming / panning / price-scaling moves them with the candles.
 */
function fakeChart() {
  const view = { barSpacing: 6, rightOffset: 0, pxPerPrice: 10, priceTop: 110 };
  const times = [1000, 1060, 1120, 1180, 1240, 1300];
  const xOfIndex = (i: number) => 400 - (times.length - 1 - i) * view.barSpacing - view.rightOffset;
  const chart = {
    timeScale: () => ({
      timeToIndex: (t: number) => { const i = times.indexOf(t); return i < 0 ? null : i; },
      logicalToCoordinate: (i: number) => xOfIndex(i),
    }),
  };
  const series = { priceToCoordinate: (p: number) => (view.priceTop - p) * view.pxPerPrice };
  return { view, chart, series, xOfIndex };
}
function drawZones(prim: OrderBlockPrimitive) {
  const rects: number[][] = [];
  const ctx = new Proxy({ measureText: () => ({ width: 40 }) } as Record<string, unknown>, {
    get: (o, k) => (k in o ? o[k as string] : k === 'fillRect' ? (...a: number[]) => rects.push(a) : () => {}),
    set: () => true,
  });
  const target = { useMediaCoordinateSpace: (fn: (s: unknown) => void) => fn({ context: ctx, mediaSize: { width: 500, height: 400 } }) };
  (prim.paneViews()[0]!.renderer() as { draw: (t: unknown) => void }).draw(target);
  return rects;
}

const zone: OBDrawable = { id: 'ob1', type: 'bullish', low: 100, high: 102, from: 1060, to: 1240, emphasis: 1, label: 'OB', sublabel: '', spent: false, selected: false, highlighted: false };

describe('overlay alignment under chart navigation', () => {
  it('an Order Block zone stays on its candles and prices after zoom, pan and price rescale', () => {
    const { view, chart, series, xOfIndex } = fakeChart();
    const prim = new OrderBlockPrimitive();
    prim.attached({ chart, series, requestUpdate: () => {} } as never);
    prim.setItems([zone]);
    const check = () => {
      const [x, y, w, h] = drawZones(prim)[0]!;
      expect(x).toBe(xOfIndex(1)); // candle 1060
      expect(x! + w!).toBe(xOfIndex(4)); // candle 1240
      expect(y).toBe(series.priceToCoordinate(102));
      expect(y! + h!).toBe(series.priceToCoordinate(100));
    };
    check();
    view.barSpacing = 6 * 1.25; // zoom in
    check();
    view.rightOffset = 30; // drag-pan
    check();
    view.pxPerPrice = 4; // price-axis drag / autoscale
    view.priceTop = 105;
    check();
    expect(prim.items).toEqual([zone]); // the drawable itself is never changed by navigation
  });
});
