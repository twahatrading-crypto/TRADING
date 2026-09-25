import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HEATMAP_VIEW } from '../../engines/orderFlow/config';
import { OrderFlowEngine } from '../../engines/orderFlow/engine';
import { FULL_CAPS, TEST_TICK, demoSession } from '../../engines/orderFlow/testing/scenarios';
import { DEFAULT_SPAN_COLUMNS, HeatmapView } from './HeatmapView';

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
    expect(v.vp!.t1 - v.vp!.t0).toBe((DEFAULT_SPAN_COLUMNS) * 1000);
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
});
