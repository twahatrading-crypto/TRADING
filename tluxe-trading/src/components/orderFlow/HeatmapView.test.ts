import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HEATMAP_VIEW } from '../../engines/orderFlow/config';
import { OrderFlowEngine } from '../../engines/orderFlow/engine';
import { FULL_CAPS, TEST_TICK, demoSession } from '../../engines/orderFlow/testing/scenarios';
import { DEFAULT_SPAN_COLUMNS, HeatmapView, MIN_SPAN_COLUMNS, bubbleRadius, type TradeHover } from './HeatmapView';

/* TEST DATA ONLY. Navigation is view state: the engine is read, never written. */

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

function setup() {
  const e = new OrderFlowEngine({ instrumentId: 'GC', tickSize: TEST_TICK, capabilities: FULL_CAPS });
  e.processAll(demoSession());
  const host = document.createElement('div');
  document.body.appendChild(host);
  const frames: (() => void)[] = [];
  const v = new HeatmapView(host, () => e, { settings: () => DEFAULT_HEATMAP_VIEW, decimals: 1, tickSize: TEST_TICK, raf: { request: (cb) => frames.push(cb), cancel: () => {} } });
  return { e, v, host, frames };
}

describe('HeatmapView navigation (view only)', () => {
  it('zoom / pan / fit / reset / focus change only the viewport, never the engine', () => {
    const { e, v, host } = setup();
    const digest = e.digest();
    const events = JSON.stringify(e.events());
    v.resetView();
    const reset = { ...v.vp! };
    // Default window = the available real history (never empty space on the left), capped at DEFAULT_SPAN_COLUMNS.
    const cols0 = e.allColumns();
    const have = v.vp!.t1 - cols0[0]!.t + 1000;
    expect(v.vp!.t1 - v.vp!.t0).toBe(Math.max(MIN_SPAN_COLUMNS * 1000, Math.min(DEFAULT_SPAN_COLUMNS * 1000, have)));
    expect(v.vp!.t0).toBeGreaterThanOrEqual(cols0[0]!.t - 1000);
    v.zoomIn();
    expect(v.vp!.t1 - v.vp!.t0).toBeLessThan(reset.t1 - reset.t0);
    v.zoomOut();
    v.zoomOut();
    expect(v.vp!.t1 - v.vp!.t0).toBeGreaterThan(reset.t1 - reset.t0);
    v.fitView();
    const cols = e.allColumns();
    expect(v.vp!.t0).toBe(cols[0]!.t);
    const ev = e.events()[0]!;
    v.focus(ev.time, ev.price);
    expect(v.follow).toBe(false);
    expect(v.highlight).toEqual({ t: ev.time, tick: Math.round(ev.price / TEST_TICK) });
    expect((v.vp!.t0 + v.vp!.t1) / 2).toBeCloseTo(ev.time);
    const canvas = host.querySelector('canvas')!;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 10, clientY: 10, cancelable: true }));
    canvas.dispatchEvent(new MouseEvent('dblclick'));
    expect(v.vp).toEqual(reset); // double-click = reset
    expect(e.digest()).toBe(digest);
    expect(JSON.stringify(e.events())).toBe(events);
    v.destroy();
  });

  it('destroy removes the canvas and stops the frame loop', () => {
    const { v, host, frames } = setup();
    expect(host.querySelector('canvas')).not.toBeNull();
    v.destroy();
    expect(host.querySelector('canvas')).toBeNull();
    frames.splice(0).forEach((f) => f()); // a pending frame after destroy must not schedule another
    expect(frames).toHaveLength(0);
  });

  it('trade bubbles: robust normalisation, clamped radius (no walls), quantities untouched', () => {
    expect(bubbleRadius(0, 50, 10, 6)).toBeCloseTo(2);
    expect(bubbleRadius(50, 50, 10, 6)).toBeCloseTo(9);
    expect(bubbleRadius(5000, 50, 10, 6)).toBeCloseTo(9); // an outlier is capped, not allowed to swamp the chart
    expect(bubbleRadius(5000, 50, 200, 200)).toBe(14); // absolute cap
    expect(bubbleRadius(10, 50, 1, 1)).toBeLessThanOrEqual(4); // dense zoom -> small bubbles
  });
});

/* Rendering with a recording 2D context (TEST ONLY): what is drawn, never what the engine holds. */
function recordingCtx() {
  const calls: string[] = [];
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (t, k: string) => (k in t ? t[k] : (t[k] = vi.fn((..._a: unknown[]) => calls.push(k)))),
    set: (t, k: string, v) => ((t[k] = v), true),
  };
  const img = () => ({ data: new Uint8ClampedArray(4096 * 64) });
  const ctx = new Proxy<Record<string, unknown>>({ createImageData: vi.fn(img), measureText: vi.fn(() => ({ width: 10 })) }, handler);
  return { ctx, calls };
}

describe('HeatmapView rendering (liquidity layer honesty, hover)', () => {
  function render(depthAvailable: boolean) {
    const { ctx, calls } = recordingCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const e = new OrderFlowEngine({ instrumentId: 'GC', tickSize: TEST_TICK, capabilities: FULL_CAPS });
    e.processAll(demoSession());
    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    document.body.appendChild(host);
    const frames: (() => void)[] = [];
    const hovers: (TradeHover | null)[] = [];
    const v = new HeatmapView(host, () => e, { settings: () => DEFAULT_HEATMAP_VIEW, decimals: 1, tickSize: TEST_TICK, depthAvailable: () => depthAvailable, onHover: (h) => hovers.push(h), raf: { request: (cb) => frames.push(cb), cancel: () => {} } });
    frames.splice(0).forEach((f) => f());
    return { v, e, calls, hovers };
  }

  it('no Level-2 provider -> no liquidity cells, no hatch, no depth bars (nothing inferred); with depth -> drawn', () => {
    const off = render(false);
    expect(off.calls.filter((c) => c === 'drawImage')).toHaveLength(0); // cells are blitted with drawImage
    expect(off.calls.filter((c) => c === 'arc').length).toBeGreaterThan(0); // executed-trade bubbles still drawn
    off.v.destroy();
    const on = render(true);
    expect(on.calls.filter((c) => c === 'drawImage').length).toBeGreaterThan(0);
    on.v.destroy();
  });

  it('hover reports the exact engine quantities of the bubble under the pointer', () => {
    const { v, e, hovers } = render(false);
    const b = (v as unknown as { bubbles: { x: number; y: number; h: TradeHover }[] }).bubbles.at(-1)!;
    const canvas = document.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: b.x, clientY: b.y }));
    const h = hovers.at(-1)!;
    expect(h).not.toBeNull();
    const col = e.allColumns().find((c) => c.t === h.time)!;
    const cell = col.trades.find((t) => Math.abs(t.tick * TEST_TICK - h.price) < 1e-9)!;
    expect([h.buy, h.sell, h.unknown]).toEqual([cell.buy, cell.sell, cell.unknown]);
    canvas.dispatchEvent(new MouseEvent('pointerleave'));
    expect(hovers.at(-1)).toBeNull();
    v.destroy();
  });
});
