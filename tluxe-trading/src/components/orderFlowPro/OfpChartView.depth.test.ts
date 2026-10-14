import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfpEngine, offlineStatus } from '../../engines/orderFlowPro/engine';
import { liquidityOverlay } from '../../engines/orderFlowPro/liquidityClass';
import type { SourceStatus } from '../../engines/orderFlowPro/types';
import { DEFAULT_LAYERS, DEFAULT_LIQ_FLAGS, OfpChartView, type ChartFrame, type HoverInfo } from './OfpChartView';

/*
 * The real chart renderer against a RECORDING 2D context (jsdom has no canvas): what is drawn and what the hover
 * reports, under the shared depth-freshness decision. Book / trades below are constructed in the test only.
 */
type Call = { op: string; args: unknown[]; fill: string };
function recordingContext(calls: Call[]) {
  const st: Record<string, unknown> = { fillStyle: '', strokeStyle: '', font: '', globalAlpha: 1, lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', shadowBlur: 0, shadowColor: '' };
  const grad = { addColorStop: () => {} };
  return new Proxy(st, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      return (...args: unknown[]) => void calls.push({ op: k, args, fill: String(t.fillStyle) });
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

function viewWithBook() {
  const e = new OfpEngine('GC', { ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME' } as SourceStatus);
  e.apply({ root: 'GC', seq: 1, events: [{ kind: 'book', t: T, bids: [[4195.3, 40], [4195.2, 2], [4195.1, 1]], asks: [[4195.4, 3], [4195.5, 1]] }] });
  for (let k = 0; k < 6; k++) e.apply({ root: 'GC', seq: 2 + k, events: [{ kind: 'trade', t: T + k * 20_000, price: 4195.3 + (k % 2) * 0.1, size: 1, aggressor: 'BUY', method: 'EXCHANGE', bid: 4195.3, ask: 4195.4 }] });
  e.advance(T + 150_000);
  return e;
}

function frame(e: OfpEngine, extra: Partial<ChartFrame>): ChartFrame {
  const view = e.view('1m', 'ETH');
  return {
    view,
    precision: 1,
    layers: { ...DEFAULT_LAYERS, heatmap: false, bubbles: false, footprint: false, profile: false, levels: false, reversals: false },
    scale: 'sqrt',
    gain: 1,
    drawings: [],
    tool: 'cursor',
    demo: false,
    replay: false,
    now: T + 150_000,
    heatOpacity: 0.8,
    bubbleOpacity: 0.75,
    bubbleDensity: 'medium',
    liq: liquidityOverlay(view.recorder, null, extra.depthCurrent !== false, T + 150_000),
    liqFlags: DEFAULT_LIQ_FLAGS,
    depth: { lastChangeMs: T, confirmedAgoMs: 500, state: 'LIVE', detail: null },
    ...extra,
  };
}

/** Draw once and hover over the 4195.3 bid row; returns the book-strip fills, lane text and the hover info. */
function render(f: ChartFrame) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let hover: HoverInfo | null = null;
  const chart = new OfpChartView(host, () => f, { onHover: (h) => (hover = h) });
  calls.length = 0;
  chart.draw();
  // find the y of 4195.3 from the axis scale the chart just used
  const lastScale = (chart as unknown as { lastScale: { lo: number; hi: number } }).lastScale;
  const y = (H - 22) - ((4195.3 - lastScale.lo) / (lastScale.hi - lastScale.lo)) * (H - 22);
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: y })); // jsdom has no PointerEvent; the handler reads clientX / clientY only
  calls.length = 0;
  chart.draw();
  const strip = calls.filter((c) => c.op === 'fillRect' && /^rgba\((38,208,124|239,75,95),0\.55\)$/.test(c.fill));
  const text = calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
  chart.destroy();
  host.remove();
  return { strip, text, hover: hover as HoverInfo | null };
}

describe('chart depth freshness (the shared depthFreshness decision is authoritative for the chart)', () => {
  it('current depth: in-plot book strip drawn and resting size in the hover', () => {
    const r = render(frame(viewWithBook(), { depthCurrent: true }));
    expect(r.strip.length).toBeGreaterThan(0);
    expect(r.hover?.resting).toEqual({ side: 'BID', size: 40 });
  });

  for (const state of ['DISCONNECTED', 'STALE', 'CONTRACT_MISMATCH']) {
    it(`${state}: no book strip, no resting size / class in the hover, lane says no current levels`, () => {
      const r = render(frame(viewWithBook(), { depthCurrent: false, depth: { lastChangeMs: T, confirmedAgoMs: 9000, state, detail: 'x' } }));
      expect(r.strip).toEqual([]);
      expect(r.hover).not.toBeNull();
      expect(r.hover!.resting).toBeNull();
      expect(r.hover!.liq ?? null).toBeNull();
      expect(r.text.join(' | ')).toMatch(new RegExp(`Depth ${state.replace('_', ' ')}`));
      expect(r.text.join(' | ')).toMatch(/no current levels/);
      expect(r.text.some((t) => /^(STRONG|MEDIUM) (BID|ASK)/.test(t))).toBe(false);
    });
  }

  it('classic tags (no liquidity overlay) are also suppressed when not current', () => {
    const r = render(frame(viewWithBook(), { depthCurrent: false, liq: null }));
    expect(r.strip).toEqual([]);
    expect(r.text.some((t) => /^(BID|ASK) \d/.test(t))).toBe(false);
  });

  it('recovery: current again -> strip and hover resting size return', () => {
    const e = viewWithBook();
    expect(render(frame(e, { depthCurrent: false })).strip).toEqual([]);
    const r = render(frame(e, { depthCurrent: true }));
    expect(r.strip.length).toBeGreaterThan(0);
    expect(r.hover?.resting?.size).toBe(40);
  });

  it('replay keeps the recorded book (it is labelled by the replay banner), never as live levels', () => {
    const r = render(frame(viewWithBook(), { replay: true, depthCurrent: undefined }));
    expect(r.strip.length).toBeGreaterThan(0);
    expect(r.text).toContain('Replay: recorded averages'); // the lane wraps the status at ' - '
    expect(r.text).toContain('no live resting levels');
  });
});
