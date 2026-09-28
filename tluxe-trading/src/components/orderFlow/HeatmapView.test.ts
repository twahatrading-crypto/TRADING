import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HEATMAP_VIEW } from '../../engines/orderFlow/config';
import { OrderFlowEngine } from '../../engines/orderFlow/engine';
import { FULL_CAPS, TEST_TICK, demoSession } from '../../engines/orderFlow/testing/scenarios';
import type { Aggressor, OrderFlowMsg } from '../../engines/orderFlow/types';
import { DEFAULT_SPAN_COLUMNS, HeatmapView, MIN_SPAN_COLUMNS, type TradeHover } from './HeatmapView';
import type { DotAggregation } from './tradeDots';

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

/** TEST DATA: a trades-only tape with same-ms sweeps and an older backlog delivered after newer trades. */
function wallTape(): OrderFlowMsg[] {
  let n = 0;
  const tr = (t: number, price: number, size: number, aggressor: Aggressor): OrderFlowMsg => ({ type: 'trade', instrumentId: 'GC', seq: null, exchTime: t, recvTime: t + 5, price, size, aggressor, tradeId: `w${n++}` });
  const live: OrderFlowMsg[] = [];
  const backlog: OrderFlowMsg[] = [];
  for (let i = 0; i < 600; i++) {
    const t = 1_000_000 + i * 200;
    if (i % 40 === 0) for (let k = 0; k < 15; k++) live.push(tr(t, 2400 + k * 0.1, 2 + (k % 5), 'SELL'));
    else live.push(tr(t, 2400 + ((i * 7) % 11) * 0.1, 1 + (i % 13), (['BUY', 'SELL', 'BUY', 'UNKNOWN', 'SELL'] as const)[i % 5]!));
  }
  for (let i = 0; i < 900; i++) backlog.push(tr(1_000_000 - 900_000 + i * 900, 2398 + (i % 20) * 0.1, 1 + (i % 6), i % 2 ? 'BUY' : 'SELL'));
  return [...live, ...backlog];
}

describe('HeatmapView rendering (liquidity layer honesty, hover)', () => {
  function render(depthAvailable: boolean, o: { msgs?: OrderFlowMsg[]; dots?: boolean; agg?: DotAggregation } = {}) {
    const { ctx, calls } = recordingCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const e = new OrderFlowEngine({ instrumentId: 'GC', tickSize: TEST_TICK, capabilities: o.msgs ? { ...FULL_CAPS, depth: 'NONE' } : FULL_CAPS });
    const msgs = o.msgs ?? demoSession();
    e.processAll(msgs);
    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    document.body.appendChild(host);
    const frames: (() => void)[] = [];
    const hovers: (TradeHover | null)[] = [];
    const settings = { ...DEFAULT_HEATMAP_VIEW, showTrades: o.dots ?? true };
    const v = new HeatmapView(host, () => e, {
      settings: () => settings,
      decimals: 1,
      tickSize: TEST_TICK,
      depthAvailable: () => depthAvailable,
      onHover: (h) => hovers.push(h),
      tape: () => ({ msgs, count: msgs.length }),
      dotAggregation: () => o.agg ?? 'auto',
      raf: { request: (cb) => frames.push(cb), cancel: () => {} },
    });
    frames.splice(0).forEach((f) => f());
    return { v, e, calls, hovers, msgs };
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

  it('hover reports the exact sums of the real trades in the display bucket (+ trade count, dominant side)', () => {
    const { v, hovers, msgs } = render(false, { msgs: wallTape() });
    const bubbles = (v as unknown as { bubbles: { x: number; y: number; h: TradeHover }[] }).bubbles;
    const b = bubbles.at(-1)!;
    const canvas = document.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: b.x, clientY: b.y }));
    const h = hovers.at(-1)!;
    expect(h).not.toBeNull();
    // Recompute from the RAW messages: same bucket, same band -> identical sums.
    const inBucket = msgs.filter((m): m is Extract<OrderFlowMsg, { type: 'trade' }> => m.type === 'trade' && Math.floor(m.exchTime / h.bucketMs) * h.bucketMs === Math.floor(h.first / h.bucketMs) * h.bucketMs && m.price >= h.bandLo - 1e-9 && m.price <= h.bandHi + 1e-9);
    const s = (side: Aggressor) => inBucket.filter((m) => m.aggressor === side).reduce((a, m) => a + m.size, 0);
    expect([h.buy, h.sell, h.unknown]).toEqual([s('BUY'), s('SELL'), s('UNKNOWN')]);
    expect(h.count).toBe(inBucket.length);
    expect(h.total).toBe(h.buy + h.sell + h.unknown);
    canvas.dispatchEvent(new MouseEvent('pointerleave'));
    expect(hovers.at(-1)).toBeNull();
    v.destroy();
  });

  it('dense same-ms sweeps + a late backlog collapse into readable bubbles: no vertical walls', () => {
    const { v, msgs } = render(false, { msgs: wallTape() });
    const bubbles = (v as unknown as { bubbles: { x: number; y: number; r: number }[] }).bubbles;
    const prints = msgs.filter((m) => m.type === 'trade').length;
    expect(bubbles.length).toBeGreaterThan(0);
    expect(bubbles.length).toBeLessThan(prints / 3); // many prints -> far fewer display bubbles
    // Bubbles sharing a time bucket are separated by at least a band: they cannot stack into a solid column.
    const byX = new Map<number, number[]>();
    for (const b of bubbles) byX.set(Math.round(b.x), [...(byX.get(Math.round(b.x)) ?? []), b.y]);
    const maxStack = Math.max(...[...byX.values()].map((ys) => ys.length));
    expect(maxStack).toBeLessThanOrEqual(3);
    // The late backlog is drawn at its own (older) time: nothing is piled at the live edge.
    expect(v.lastBucketMs).not.toBeNull();
    v.destroy();
  });

  it('Volume Dots OFF -> price chart only (no bubbles); manual display bucket is honoured', () => {
    const off = render(false, { msgs: wallTape(), dots: false });
    expect(off.calls.filter((c) => c === 'arc')).toHaveLength(0);
    expect(off.calls.filter((c) => c === 'lineTo').length).toBeGreaterThan(0); // price trace still drawn
    off.v.destroy();
    const fixed = render(false, { msgs: wallTape(), agg: 250 });
    expect(fixed.v.lastBucketMs).toBe(250);
    fixed.v.destroy();
  });

  it('no depth = zero liquidity bands even with a dense tape (nothing inferred from trades)', () => {
    const { v, calls } = render(false, { msgs: wallTape() });
    expect(calls.filter((c) => c === 'drawImage')).toHaveLength(0);
    expect(calls.filter((c) => c === 'putImageData')).toHaveLength(0);
    v.destroy();
  });

  it('PRICE layer is identical for Volume Dots ON / OFF and every Trade Agg (AUTO / 100 / 250 / 500 / 1000 ms)', () => {
    const tape = wallTape();
    const variants: { dots: boolean; agg: DotAggregation }[] = [
      { dots: true, agg: 'auto' },
      { dots: false, agg: 'auto' },
      { dots: true, agg: 100 },
      { dots: true, agg: 250 },
      { dots: true, agg: 500 },
      { dots: true, agg: 1000 },
      { dots: false, agg: 1000 },
    ];
    const geoms = variants.map((o) => {
      const r = render(false, { msgs: tape, ...o });
      const g = r.v.priceGeometry();
      const bubbles = (r.v as unknown as { bubbles: unknown[] }).bubbles.length;
      const dotMs = r.v.lastBucketMs;
      r.v.destroy();
      return { g, bubbles, dotMs, dots: o.dots };
    });
    expect(geoms[0]!.g.length).toBeGreaterThan(100); // a real, dense price layer was drawn
    for (const x of geoms) expect(x.g).toBe(geoms[0]!.g); // byte-identical price geometry in every case
    expect(geoms.filter((x) => !x.dots).every((x) => x.bubbles === 0)).toBe(true); // OFF removes bubbles only
    expect(new Set(geoms.filter((x) => x.dots).map((x) => x.bubbles)).size).toBeGreaterThan(1); // Trade Agg changes bubbles
    expect(geoms.map((x) => x.dotMs)).toEqual([expect.any(Number), expect.any(Number), 100, 250, 500, 1000, 1000]);
  });
});
