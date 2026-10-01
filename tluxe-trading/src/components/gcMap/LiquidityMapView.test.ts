import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeMap, DEFAULT_STRONG, type MapColumn } from './liquidityMap';
import { AXIS_RIGHT, LiquidityMapView, PROFILE_SHARE, type MapCandle, type MapFrame } from './LiquidityMapView';

/* TEST DATA ONLY: hand-built recorded-depth columns and candles. */
function recorder() {
  const texts: string[] = [];
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  const ctx: Record<string, unknown> = { fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic' };
  for (const k of ['save', 'restore', 'beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'stroke', 'arc', 'closePath', 'fill', 'strokeRect', 'setTransform', 'setLineDash'] as const) ctx[k] = () => {};
  ctx.fillRect = (x: number, y: number, w: number, h: number) => fills.push({ style: String(ctx.fillStyle), x, y, w, h });
  ctx.fillText = (t: string) => texts.push(t);
  ctx.measureText = (t: string) => ({ width: t.length * 6 });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fills };
}
const W = 1000;
const T0 = 1_800_000_000_000;
const col = (t: number, wall: number): MapColumn => ({
  t,
  w: W,
  valid: Float64Array.from([t, t + W]),
  bidTicks: Int32Array.from(Array.from({ length: 10 }, (_, i) => 999 - i)),
  bidSizes: Float64Array.from(Array.from({ length: 10 }, () => 4)),
  askTicks: Int32Array.from(Array.from({ length: 10 }, (_, i) => 1000 + i)),
  askSizes: Float64Array.from(Array.from({ length: 10 }, (_, i) => (i === 4 ? wall : 4))),
});
// 20 s recorded, a 30 s gap, 20 s recorded.
const COLS = [...Array.from({ length: 20 }, (_, i) => col(T0 + i * W, 40)), ...Array.from({ length: 20 }, (_, i) => col(T0 + 50_000 + i * W, 40))];
const VP = { t0: T0 - 10_000, t1: T0 + 80_000, p0: 980, p1: 1020 };
const SIZE = { w: 1100, h: 600 };
const plotW = Math.round((SIZE.w - AXIS_RIGHT) * (1 - PROFILE_SHARE));
const xOf = (t: number) => ((t - VP.t0) / (VP.t1 - VP.t0)) * plotW;

function frame(over: Partial<MapFrame> = {}): MapFrame {
  return { cols: COLS, result: analyzeMap(COLS), candles: [], book: null, lastPriceTick: 1000, showCandles: true, showHeat: true, showDepth: true, strongOnly: false, showLabels: true, gain: 1, strong: { ...DEFAULT_STRONG, minPersistMs: 1000 }, depthLive: false, version: 1, ...over };
}
afterEach(() => vi.restoreAllMocks());
function draw(f: MapFrame, now = T0 + 70_000) {
  const rec = recorder();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(rec.ctx as never);
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ width: SIZE.w, height: SIZE.h, left: 0, top: 0, right: SIZE.w, bottom: SIZE.h, x: 0, y: 0, toJSON() {} });
  const v = new LiquidityMapView(host, () => f, { tickSize: 0.1, decimals: 1, now: () => now, raf: { request: () => 0, cancel: () => {} } });
  v.pin({ ...VP });
  rec.texts.length = 0;
  rec.fills.length = 0;
  v.draw(f);
  return { rec, v };
}
// Heat fills = translucent rgba fills inside the time chart that are not the gap / background / candle / label fills.
const heatFills = (fills: { style: string; x: number; y: number; w: number; h: number }[]) =>
  fills.filter((q) => /^rgba\(\d+,\d+,\d+,(0|1)\.\d{3}\)$/.test(q.style) && q.x + q.w <= plotW + 1);

describe('GC Liquidity Map view', () => {
  it('paints recorded depth only inside recorded-valid time: nothing inside the feed gap, DEPTH GAP / NO DEPTH DATA shown', () => {
    const { rec } = draw(frame());
    const heat = heatFills(rec.fills);
    expect(heat.length).toBeGreaterThan(0);
    const gap0 = xOf(T0 + 20_000);
    const gap1 = xOf(T0 + 50_000);
    for (const f of heat) expect(f.x + f.w <= gap0 + 1e-6 || f.x >= gap1 - 1e-6).toBe(true);
    for (const f of heat) expect(f.x + f.w).toBeLessThanOrEqual(xOf(T0 + 70_000) + 1e-6); // never into the future
    expect(rec.texts).toContain('DEPTH GAP');
    expect(rec.texts).toContain('NO DEPTH DATA');
  });
  it('the candle timeframe does not change the liquidity drawn (same rectangles with 1m or 1H candles)', () => {
    const m1: MapCandle[] = Array.from({ length: 2 }, (_, i) => ({ t: T0 + i * 60_000, ms: 60_000, o: 100, h: 100.4, l: 99.6, c: 100.2 }));
    const h1: MapCandle[] = [{ t: T0 - 3_600_000 + 3_600_000, ms: 3_600_000, o: 100, h: 100.8, l: 99.3, c: 100.1 }];
    const a = heatFills(draw(frame({ candles: m1 })).rec.fills);
    const b = heatFills(draw(frame({ candles: h1 })).rec.fills);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
  it('CURRENT DEPTH profile: the live book only; NO DEPTH DATA when there is none', () => {
    const none = draw(frame({ book: null })).rec;
    expect(none.texts).toEqual(expect.arrayContaining(['CURRENT DEPTH', 'NO DEPTH DATA']));
    const live = draw(frame({ book: { bids: [{ tick: 999, size: 7 }], asks: [{ tick: 1000, size: 14 }] }, depthLive: true })).rec;
    const bars = live.fills.filter((q) => /^rgba\((244,63,94|16,185,129),0\.85\)$/.test(q.style));
    expect(bars).toHaveLength(2);
    const ask = bars.find((q) => q.style.startsWith('rgba(244'))!;
    const bid = bars.find((q) => q.style.startsWith('rgba(16'))!;
    expect(ask.w).toBeCloseTo(2 * bid.w, 5); // bar length proportional to the displayed size (14 vs 7)
  });
  it('strong labels only while depth is live, with the real size / relative / age', () => {
    const { v } = draw(frame({ depthLive: true, book: { bids: [], asks: [] } }));
    expect(v.lastLabels).toHaveLength(1);
    expect(v.lastLabels[0]).toMatch(/^100\.4 {2}SIZE 40 {2}10\.0× {2}AGE 00:20$/);
    expect(draw(frame({ depthLive: false })).v.lastLabels).toEqual([]);
  });
  it('Strong Only hides the ordinary depth and keeps the strong level', () => {
    const all = heatFills(draw(frame()).rec.fills).length;
    const strong = heatFills(draw(frame({ strongOnly: true })).rec.fills);
    expect(strong.length).toBeGreaterThan(0);
    expect(strong.length).toBeLessThan(all);
  });
  it('nothing in the heat legend / labels is a signal', () => {
    const { rec } = draw(frame({ depthLive: true, book: { bids: [], asks: [] } }));
    expect(rec.texts.some((t) => /BUY|SELL|SUPPORT|RESISTANCE|%/i.test(t))).toBe(false);
  });
  it('diagnostics on the canvas: drawn depth rows + gaps (read-only, what is drawn)', () => {
    const { v } = draw(frame({ book: { bids: [{ tick: 999, size: 7 }], asks: [{ tick: 1000, size: 14 }] }, bookUpdateMs: 123, depthLive: true }));
    const ds = (v as unknown as { canvas: HTMLCanvasElement }).canvas.dataset;
    expect(JSON.parse(ds.depth!)).toEqual({ updateMs: 123, bids: [[99.9, 7]], asks: [[100, 14]] });
    expect(JSON.parse(ds.gaps!)).toEqual([[T0 + 20_000, T0 + 50_000]]);
    expect(ds.heatCols).toBe('40');
  });
});
