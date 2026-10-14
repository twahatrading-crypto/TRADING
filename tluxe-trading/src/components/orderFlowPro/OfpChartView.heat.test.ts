import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfpEngine, offlineStatus } from '../../engines/orderFlowPro/engine';
import type { LiquidityOverlay } from '../../engines/orderFlowPro/liquidityClass';
import type { SourceStatus } from '../../engines/orderFlowPro/types';
import { DEFAULT_LAYERS, DEFAULT_LIQ_FLAGS, OfpChartView, type ChartFrame, type HoverInfo } from './OfpChartView';
import { DEFAULT_HEAT_FILTERS, HEAT_RGB, type HeatColumn, type HeatFilters } from './heatLayer';

/*
 * The real chart renderer against a RECORDING 2D context (jsdom has no canvas). Books, trades and recorded columns
 * are constructed in the test only.
 */
type Call = { op: string; args: unknown[]; fill: string; stroke: string };
function recordingContext(calls: Call[]) {
  const st: Record<string, unknown> = { fillStyle: '', strokeStyle: '', font: '', globalAlpha: 1, lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', shadowBlur: 0, shadowColor: '' };
  const grad = { addColorStop: () => {} };
  return new Proxy(st, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      return (...args: unknown[]) => void calls.push({ op: k, args, fill: String(t.fillStyle), stroke: String(t.strokeStyle) });
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  });
}

const T = Date.UTC(2026, 9, 14, 14, 0, 0);
const W = 1400;
const H = 700;
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingContext(calls) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: W, bottom: H, width: W, height: H, toJSON: () => ({}) }) as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

/** Nearest tier anchor of a heat fill colour (the palette interpolates inside a tier). */
const ANCHORS = { VERY_STRONG: HEAT_RGB.VERY_STRONG, STRONG: HEAT_RGB.STRONG, MEDIUM: HEAT_RGB.MEDIUM, WEAK: HEAT_RGB.WEAK, CORE: HEAT_RGB.CORE } as const;
type Anchor = keyof typeof ANCHORS;
function tierOf(fill: string): Anchor | null {
  const m = /^rgba\((\d+),(\d+),(\d+),0?\.\d+\)$/.exec(fill);
  if (!m) return null;
  const c = [Number(m[1]), Number(m[2]), Number(m[3])];
  let best: Anchor | null = null;
  let bd = Infinity;
  for (const [k, a] of Object.entries(ANCHORS) as Array<[Anchor, readonly number[]]>) {
    const d = (c[0]! - a[0]!) ** 2 + (c[1]! - a[1]!) ** 2 + (c[2]! - a[2]!) ** 2;
    if (d < bd) [bd, best] = [d, k];
  }
  return bd < 3 * 40 * 40 ? best : null;
}
const TIERS = { medium: 4, strong: 8, veryStrong: 20 };

/** Live recorder from T (book: bid 4195.3 x 30 = very strong, ask 4195.4 x 1 = weak) + a few prints for candles. */
function engine() {
  const e = new OfpEngine('GC', { ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME' } as SourceStatus);
  e.apply({ root: 'GC', seq: 1, events: [{ kind: 'book', t: T, bids: [[4195.3, 30], [4195.2, 2], [4195.1, 1]], asks: [[4195.4, 1], [4195.5, 1]] }] });
  for (let k = 0; k < 6; k++) e.apply({ root: 'GC', seq: 2 + k, events: [{ kind: 'trade', t: T + k * 20_000, price: 4195.3 + (k % 2) * 0.1, size: 1, aggressor: 'BUY', method: 'EXCHANGE', bid: 4195.3, ask: 4195.4 }] });
  e.advance(T + 150_000);
  return e;
}

/** Recorded columns before the live recorder: 4195.6 ASK x 9 (strong) and 4195.0 BID x 5 (medium), with a gap. */
function recorded(gapFrom = T - 600_000, gapTo = T - 480_000): HeatColumn[] {
  const out: HeatColumn[] = [];
  for (let t = T - 1800_000; t < T; t += 15_000) {
    if (t >= gapFrom && t < gapTo) continue;
    out.push({ t, dt: 15_000, validMs: 15_000, cells: [{ tick: 41956, side: 'ASK', avg: 9 }, { tick: 41950, side: 'BID', avg: 5 }], source: 'RECORDED' });
  }
  return out;
}

function frame(e: OfpEngine, over: Partial<ChartFrame> = {}, filters: Partial<HeatFilters> = {}, history = recorded(), contractKey: string | null = 'GCZ6'): ChartFrame {
  return {
    view: e.view('1m', 'ETH'),
    precision: 1,
    layers: { ...DEFAULT_LAYERS, footprint: false, bubbles: false, profile: false, levels: false, reversals: false, orderBook: false },
    scale: 'linear',
    gain: 1,
    drawings: [],
    tool: 'cursor',
    demo: false,
    replay: false,
    now: T + 150_000,
    heatOpacity: 1,
    bubbleOpacity: 0.75,
    bubbleDensity: 'medium',
    liq: null,
    liqFlags: DEFAULT_LIQ_FLAGS,
    depthCurrent: true,
    heat: { tiers: TIERS, filters: { ...DEFAULT_HEAT_FILTERS, ...filters }, history: (from, to) => history.filter((c) => c.t + c.dt > from && c.t < to), version: 1, contractKey },
    ...over,
  };
}

function mount(f: () => ChartFrame) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let hover: HoverInfo | null = null;
  const chart = new OfpChartView(host, f, { onHover: (h) => (hover = h) });
  const priv = chart as unknown as { lastScale: { lo: number; hi: number }; x: (t: number) => number; y: (p: number) => number };
  return {
    chart,
    hoverAt: (t: number, price: number) => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: priv.x(t), clientY: priv.y(price) })); // jsdom has no PointerEvent
      chart.draw();
      return hover as HoverInfo | null;
    },
    x: (t: number) => priv.x(t),
    done: () => (chart.destroy(), host.remove()),
  };
}
const heatFills = (tier: Anchor) => calls.filter((c) => c.op === 'fillRect' && tierOf(c.fill) === tier);

describe('liquidity heatmap rendering', () => {
  it('heat is composited BEFORE the candles (candles stay on top); tier colours match the legend', () => {
    const e = engine();
    const m = mount(() => frame(e));
    calls.length = 0;
    m.chart.draw();
    const blit = calls.findIndex((c) => c.op === 'drawImage');
    const firstCandle = calls.findIndex((c) => c.op === 'fillRect' && (c.fill === '#26d07c' || c.fill === '#ef4b5f'));
    expect(blit).toBeGreaterThanOrEqual(0);
    expect(firstCandle).toBeGreaterThan(blit);
    // layer content (painted into the off-screen canvas on the first build)
    calls.length = 0;
    m.chart.draw(); // cache hit: no re-paint of completed columns
    expect(heatFills('STRONG').length).toBe(0);
    m.done();
    calls.length = 0;
    const m2 = mount(() => frame(e));
    m2.chart.draw();
    expect(heatFills('STRONG').length).toBeGreaterThan(0); // recorded ASK x 9 -> gold (strong)
    expect(heatFills('MEDIUM').length).toBeGreaterThan(0); // recorded BID x 5 -> cyan (medium)
    expect(heatFills('VERY_STRONG').length + heatFills('CORE').length).toBeGreaterThan(0); // live BID x 30 -> bright yellow / white core
    m2.done();
  });

  it('mouse moves never rebuild the layer (cached); a data / view change does', () => {
    const e = engine();
    let f = frame(e);
    const m = mount(() => f);
    m.chart.draw();
    const builds = m.chart.stats.heatBuilds;
    for (let i = 0; i < 20; i++) window.dispatchEvent(new MouseEvent('pointermove', { clientX: 200 + i, clientY: 300 }));
    for (let i = 0; i < 5; i++) m.chart.draw();
    expect(m.chart.stats.heatBuilds).toBe(builds);
    f = frame(e, { gain: 2 });
    m.chart.draw();
    expect(m.chart.stats.heatBuilds).toBe(builds + 1);
    m.done();
  });

  it('BID-only / ASK-only / strong-only filters use the recorded side', () => {
    const e = engine();
    for (const [filters, gold, cyan] of [
      [{ ask: false }, 0, 1],
      [{ bid: false }, 1, 0],
      [{ strongOnly: true }, 1, 0],
    ] as const) {
      calls.length = 0;
      const m = mount(() => frame(e, {}, filters));
      m.chart.draw();
      expect(heatFills('STRONG').length > 0 ? 1 : 0).toBe(gold);
      expect(heatFills('MEDIUM').length > 0 ? 1 : 0).toBe(cyan);
      m.done();
    }
  });

  it('a recording gap is never bridged', () => {
    const e = engine();
    const m = mount(() => frame(e));
    for (let i = 0; i < 8; i++) m.chart.zoomOut(); // 15 s columns < 1.5 px: contiguous columns are merged
    calls.length = 0;
    (m.chart as unknown as { heatKey: string }).heatKey = '';
    m.chart.draw();
    const gx0 = m.x(T - 600_000);
    const gx1 = m.x(T - 480_000);
    const spans = heatFills('STRONG').map((c): [number, number] => [c.args[0] as number, (c.args[0] as number) + (c.args[2] as number)]);
    expect(spans.length).toBeGreaterThan(0);
    for (const [a, b] of spans) expect(b <= gx0 + 0.5 || a >= gx1 - 0.5).toBe(true);
    m.done();
  });

  it('no verified contract -> no recorded history is drawn (live only)', () => {
    const e = engine();
    const history = vi.fn(() => recorded());
    const m = mount(() => ({ ...frame(e, {}, {}, recorded(), null), heat: { ...frame(e).heat!, history, contractKey: null } }));
    m.chart.draw();
    expect(history).not.toHaveBeenCalled();
    expect(heatFills('STRONG').length).toBe(0);
    m.done();
  });

  it('no tiers yet (collecting history) -> no heat at all', () => {
    const e = engine();
    const m = mount(() => ({ ...frame(e), heat: { ...frame(e).heat!, tiers: null } }));
    m.chart.draw();
    expect(calls.filter((c) => c.op === 'drawImage')).toEqual([]);
    m.done();
  });

  it('hover: price / side / contracts / tier / time / observed run / status; stale depth is never CURRENT', () => {
    const e = engine();
    let f = frame(e);
    const m = mount(() => f);
    m.chart.draw();
    const rec = m.hoverAt(T - 1200_000 + 5000, 4195.6)!.heat!;
    expect(rec.cells).toEqual([{ side: 'ASK', avg: 9, tier: 'STRONG' }]);
    expect(rec.status).toBe('HISTORICAL · recorded (gateway)');
    expect(rec.dt).toBe(15_000);
    expect(rec.observedMs).toBe(1_200_000); // T-30 min up to the recorded gap at T-10 min (20 min), not bridged
    const live = m.hoverAt(T + 140_000, 4195.3)!.heat!;
    expect(live.cells[0]).toMatchObject({ side: 'BID', tier: 'VERY_STRONG' });
    expect(live.status).toBe('CURRENT · live IBKR depth');
    f = frame(e, { depthCurrent: false });
    expect(m.hoverAt(T + 140_000, 4195.3)!.heat!.status).toBe('HISTORICAL · observed live this session');
    expect(JSON.stringify(live)).not.toMatch(/order/i);
    m.done();
  });

  it('class bands become thin outlines when the heatmap is on, filled when it is off', () => {
    const e = engine();
    const liq = { status: 'READY', historyMs: 1, recordedMs: 0, liveMs: 1, strongMin: 8, mediumMin: 4, veryStrongMin: 20, samples: 100, levels: [], bands: [{ tick: 41953, side: 'BID', cls: 'STRONG', from: T, to: T + 120_000, meanAvg: 30, maxAvg: 30, source: 'LIVE' }], params: {} } as unknown as LiquidityOverlay;
    const green = /^rgba\(38,208,124,/;
    const m = mount(() => frame(e, { liq }));
    calls.length = 0;
    m.chart.draw();
    expect(calls.some((c) => c.op === 'strokeRect' && green.test(c.stroke))).toBe(true);
    expect(calls.some((c) => c.op === 'fillRect' && green.test(c.fill) && (c.args[2] as number) > 10)).toBe(false);
    m.done();
    const off = mount(() => frame(e, { liq, layers: { ...frame(e).layers, heatmap: false } }));
    calls.length = 0;
    off.chart.draw();
    expect(calls.some((c) => c.op === 'fillRect' && /^rgba\(38,208,124,0\.82\)$/.test(c.fill))).toBe(true);
    off.done();
  });

  it('a marker separates recorded history from this session (and says when depth is not current)', () => {
    const e = engine();
    let f = frame(e);
    const m = mount(() => f);
    calls.length = 0;
    m.chart.draw();
    const texts = () => calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
    expect(texts()).toContain('recorded ◂');
    expect(texts()).toContain('▸ this session');
    f = frame(e, { depthCurrent: false });
    calls.length = 0;
    m.chart.draw();
    expect(texts()).toContain('▸ this session · no current depth');
    f = frame(e, {}, {}, recorded(), null); // no verified contract: no recorded history -> no marker
    calls.length = 0;
    m.chart.draw();
    expect(texts()).not.toContain('recorded ◂');
    m.done();
  });
});
