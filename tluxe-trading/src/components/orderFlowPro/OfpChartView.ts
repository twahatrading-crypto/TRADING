import type { ChartNavigable } from '../chart/ChartStage';
import { HEAT_STOPS, OFP_TF_MS, type IntensityScale } from '../../engines/orderFlowPro/config';
import { fromTick, toTick } from '../../engines/orderFlowPro/classify';
import type { OfpView } from '../../engines/orderFlowPro/engine';
import { bandTier, type BandTier } from '../../engines/orderFlowPro/depthRecorder';
import { barPoc, imbalances, stackedImbalances, type FootprintBar } from '../../engines/orderFlowPro/footprint';
import type { ClassifiedLevel, LiqClass, LiquidityOverlay } from '../../engines/orderFlowPro/liquidityClass';
import type { Side } from '../../engines/orderFlowPro/types';
import { bucketFor } from './depthHistory';
import { cellVisible, heatColor, hoverAt, type HeatColumn, type HeatFilters, type HeatHover, type HeatTiers } from './heatLayer';
import { fmtQty, fmtRest, laneLabelSlots, spreadLabels, topKThreshold } from './ofpLayout';

/* ============================================================================
 * Order Flow Pro main chart (this page only). Pure presentation of the engine view it is handed:
 *   recorded RESTING liquidity heatmap (valid book time only; gaps hatched) · strong resting-liquidity bands ·
 *   session volume profile (EXECUTED prints) + POC / VAH / VAL · candles · footprint numbers / bubbles
 *   (EXECUTED prints, side = quote-rule inference) · current visible IBKR depth · reversal markers · crosshair ·
 *   drawings. Wheel / drag / buttons change the VIEW only - never data, engines or signals.
 * ========================================================================== */

export interface LayerFlags {
  heatmap: boolean;
  footprint: boolean;
  bubbles: boolean;
  profile: boolean;
  levels: boolean;
  orderBook: boolean;
  reversals: boolean;
  strong: boolean;
}

export const DEFAULT_LAYERS: LayerFlags = { heatmap: true, footprint: true, bubbles: true, profile: true, levels: true, orderBook: true, reversals: true, strong: true };

export type DrawTool = 'cursor' | 'hline' | 'trend';
export type Drawing = { kind: 'hline'; price: number } | { kind: 'trend'; t1: number; p1: number; t2: number; p2: number };

export interface ChartFrame {
  view: OfpView;
  precision: number;
  layers: LayerFlags;
  scale: IntensityScale;
  gain: number;
  drawings: readonly Drawing[];
  tool: DrawTool;
  demo: boolean;
  replay: boolean;
  /** Source clock (ms). */
  now: number;
  /** Presentation only: heatmap opacity 0.2..1, bubble opacity 0.2..1, bubble density. */
  heatOpacity: number;
  bubbleOpacity: number;
  bubbleDensity: BubbleDensity;
  /** STRONG / MEDIUM liquidity classes (visualization only; null = classic strong bands + tags). */
  liq?: LiquidityOverlay | null;
  liqFlags?: LiqFlags;
  /** Depth freshness for the label lane: last book change (VPS time) and how long ago the book was confirmed. */
  depth?: { lastChangeMs: number | null; confirmedAgoMs: number | null; state: string; detail: string | null } | null;
  /** Clean view: candles only (layers and liquidity overlays hidden, settings untouched). */
  clean?: boolean;
  /**
   * The shared depthFreshness() decision (live only). false -> nothing on the chart may look like current depth: no
   * in-plot book strip, no resting size in the hover, no current-level tags / markers. Recorded history stays.
   */
  depthCurrent?: boolean;
  /** Liquidity heatmap source (tiers, filters, recorded history for the verified contract). */
  heat?: HeatSource | null;
}

/** What the page hands the chart for the heatmap (history is read on demand by the page; the chart never requests). */
export interface HeatSource {
  /** Tiers from the STRONG / MEDIUM classifier reference (null while collecting history: no tiers, no heat). */
  tiers: HeatTiers | null;
  filters: HeatFilters;
  /** Recorded columns for [from, to) at `bucket` for the verified contract ([] when none / not allowed). */
  history: (from: number, to: number, bucket: number) => HeatColumn[];
  /** Changes whenever cached history changes. */
  version: number;
  /** Verified contract (part of the layer cache key); null = no recorded history may be drawn. */
  contractKey: string | null;
}

export type HeatStatus = 'CURRENT · live IBKR depth' | 'HISTORICAL · observed live this session' | 'HISTORICAL · recorded (gateway)' | 'RECORDED · replay';

/** In-plot book / resting hover: only for current live depth, or in replay (recorded book under the replay banner). */
const bookShown = (f: ChartFrame) => f.replay || f.depthCurrent !== false;

/** Independent liquidity-overlay toggles (presentation only). */
export interface LiqFlags {
  strong: boolean;
  medium: boolean;
  bid: boolean;
  ask: boolean;
  qty: boolean;
  /** Right-hand label lane (candles never enter it). */
  lane: boolean;
}

export const DEFAULT_LIQ_FLAGS: LiqFlags = { strong: true, medium: false, bid: true, ask: true, qty: true, lane: true };

/** STRONG / MEDIUM x BID / ASK colours: bid green, ask red; MEDIUM lighter. */
export const LIQ_RGB: Record<LiqClass, Record<Side, string>> = {
  STRONG: { BID: '38,208,124', ASK: '239,75,95' },
  MEDIUM: { BID: '150,236,186', ASK: '255,160,170' },
};

export const liqVisible = (fl: LiqFlags, cls: LiqClass, side: Side) => (cls === 'STRONG' ? fl.strong : fl.medium) && (side === 'BID' ? fl.bid : fl.ask);

const LANE_W = 184;
/** Heat columns narrower than this are merged with their contiguous neighbours (sub-pixel detail is not visible). */
const MERGE_PX = 2.5;

export type BubbleDensity = 'low' | 'medium' | 'high';
/** Max bubbles per visible bar (adaptive: the K largest executed clusters in view are drawn). */
const BUBBLES_PER_BAR: Record<BubbleDensity, number> = { low: 0.25, medium: 0.6, high: 1.5 };

/** Observed-band colours by relative-strength tier (display classes only). */
export const BAND_RGB: Record<BandTier, string> = { cyan: '0,214,255', green: '64,230,128', yellow: '255,214,64', white: '255,255,240' };
/** Observed bands: >= 2.2x the column's median displayed size for >= 4 recorded columns (1 min at 15 s columns). */
export const BAND_PARAMS = { minRelative: 2.2, minColumns: 4 };

export interface HoverInfo {
  t: number;
  price: number;
  bar: FootprintBar | null;
  level: { buy: number; sell: number; unknown: number } | null;
  resting: { side: 'BID' | 'ASK'; size: number } | null;
  /** STRONG / MEDIUM class of the resting level under the cursor (visualization only). */
  liq?: ClassifiedLevel | null;
  /** Heatmap cell(s) under the cursor: side, time-weighted displayed contracts, tier, time span, observed run. */
  heat?: (HeatHover & { status: HeatStatus }) | null;
}

const AXIS_W = 70;
const TIME_H = 22;
const C = {
  bg: '#05070c',
  grid: 'rgba(120,140,180,0.07)',
  axis: '#8b93a3',
  up: '#26d07c',
  down: '#ef4b5f',
  poc: '#f5a524',
  va: '#5b8cff',
  vp: 'rgba(123,108,255,',
  strong: '255,214,64',
};

const intensityColor = (v: number): [number, number, number] => {
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const a = HEAT_STOPS[i - 1]!;
    const b = HEAT_STOPS[i]!;
    if (v <= b[0]) {
      const f = (v - a[0]) / (b[0] - a[0] || 1);
      return [Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f), Math.round(a[3] + (b[3] - a[3]) * f)];
    }
  }
  const l = HEAT_STOPS[HEAT_STOPS.length - 1]!;
  return [l[1], l[2], l[3]];
};

/** Normalized intensity 0..1 from an average displayed size, a visible reference and the scale / gain chosen. */
export function heatIntensity(avg: number, ref: number, scale: IntensityScale, gain: number): number {
  if (avg <= 0 || ref <= 0) return 0;
  const v = Math.min(4, (avg / ref) * gain);
  const n = scale === 'linear' ? v : scale === 'sqrt' ? Math.sqrt(v) : Math.log1p(v * 9) / Math.log(10);
  return Math.max(0, Math.min(1, n));
}

const fmtUtc = (t: number, sec = false) => new Date(t).toISOString().slice(11, sec ? 19 : 16);

function niceStep(span: number, target: number) {
  const raw = span / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

export class OfpChartView implements ChartNavigable {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private ro: ResizeObserver | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private fallback: ReturnType<typeof setTimeout> | null = null;
  private barSpacing = 10;
  private rightOffset = 4;
  private manualPrice: { lo: number; hi: number } | null = null;
  private mouse: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; ro: number; bs: number; mp: { lo: number; hi: number } | null; moved: boolean; mode: 'pan' | 'price' | 'time' } | null = null;
  /** Width of the liquidity label lane in the last frame (0 = hidden). */
  private lane = 0;
  /** Off-screen heat layer (completed columns) and its cache key; the newest live column is drawn per frame. */
  private heatLayer: HTMLCanvasElement | null = null;
  private heatKey = '';
  private heatCols: HeatColumn[] = [];
  private heatNewest: HeatColumn | null = null;
  private heatTiers: HeatTiers | null = null;
  private viewKey = '';
  /** Completed live recorder columns never change: their converted heat column is cached (by identity + validMs). */
  private liveConv = new WeakMap<object, { validMs: number; col: HeatColumn }>();
  /** fillStyle per quantised size, valid for one tier / gain / scale / opacity setting (cleared on rebuild key). */
  private styleMemo = new Map<number, string>();
  private styleKey = '';
  /** Measured rendering cost (also mirrored on the canvas dataset for local performance checks). */
  readonly stats = { draws: 0, heatBuilds: 0, lastDrawMs: 0, maxDrawMs: 0, lastHeatBuildMs: 0 };
  private trendStart: { t: number; p: number } | null = null;
  private lastScale = { lo: 0, hi: 1, tEnd: 0, pxPerMs: 0 };
  private disposed = false;

  constructor(
    private host: HTMLElement,
    private frame: () => ChartFrame | null,
    private cb: { onHover?: (h: HoverInfo | null) => void; onDrawing?: (d: Drawing) => void; onView?: (v: { from: number; to: number; pxPerMs: number }) => void } = {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ofp-canvas';
    this.canvas.setAttribute('aria-label', 'Order Flow Pro chart');
    this.canvas.setAttribute('role', 'img');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext?.('2d') ?? null;
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.canvas.addEventListener('dblclick', this.onDbl);
    this.resize();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.fallback) clearTimeout(this.fallback);
    this.ro?.disconnect();
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('dblclick', this.onDbl);
    this.canvas.remove();
  }

  /* ---------------- ChartNavigable (view only) ---------------- */
  zoomIn() {
    this.barSpacing = Math.min(160, this.barSpacing * 1.25);
    this.invalidate();
  }
  zoomOut() {
    this.barSpacing = Math.max(2, this.barSpacing / 1.25);
    this.invalidate();
  }
  resetView() {
    this.barSpacing = 10;
    this.rightOffset = 4;
    this.manualPrice = null;
    this.invalidate();
  }
  fitView() {
    const f = this.frame();
    const n = f?.view.bars.length ?? 0;
    const plotW = this.plotRight();
    if (n > 0 && plotW > 0) this.barSpacing = Math.max(2, Math.min(160, plotW / (n + 6)));
    this.rightOffset = 4;
    this.manualPrice = null;
    this.invalidate();
  }
  /** Vertical (price) zoom around the centre of the visible range. */
  priceZoomIn() {
    this.scalePrice(1 / 1.25);
  }
  priceZoomOut() {
    this.scalePrice(1.25);
  }
  /** Back to the automatic price range (visible candles). Time zoom / pan are kept. */
  autoPrice() {
    this.manualPrice = null;
    this.invalidate();
  }
  get priceAuto() {
    return this.manualPrice === null;
  }
  private scalePrice(k: number, base = this.manualPrice ?? { lo: this.lastScale.lo, hi: this.lastScale.hi }) {
    const mid = (base.lo + base.hi) / 2;
    const half = Math.max(1e-9, ((base.hi - base.lo) / 2) * k);
    this.manualPrice = { lo: mid - half, hi: mid + half };
    this.invalidate();
  }
  private plotRight() {
    return this.w - AXIS_W - this.lane;
  }

  invalidate() {
    if (this.disposed || this.raf || this.fallback) return;
    if (typeof requestAnimationFrame !== 'function') return this.draw();
    const run = () => {
      cancelAnimationFrame(this.raf);
      if (this.fallback) clearTimeout(this.fallback);
      this.raf = 0;
      this.fallback = null;
      if (!this.disposed) this.draw();
    };
    this.raf = requestAnimationFrame(run);
    // rAF is paused in background / headless tabs: never leave a cleared canvas waiting for it
    this.fallback = setTimeout(run, 120);
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(0, Math.floor(r.width));
    const h = Math.max(0, Math.floor(r.height));
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    // resizing clears the bitmap: redraw synchronously so the chart is never left blank
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.draw();
  }

  /* ---------------- coordinates ---------------- */
  private x(t: number) {
    const { tEnd, pxPerMs } = this.lastScale;
    return this.plotRight() - (tEnd - t) * pxPerMs;
  }
  private tAt(x: number) {
    const { tEnd, pxPerMs } = this.lastScale;
    return tEnd - (this.plotRight() - x) / (pxPerMs || 1);
  }
  private y(p: number) {
    const { lo, hi } = this.lastScale;
    const ph = this.h - TIME_H;
    return ph - ((p - lo) / (hi - lo || 1)) * ph;
  }
  private pAt(y: number) {
    const { lo, hi } = this.lastScale;
    const ph = this.h - TIME_H;
    return lo + ((ph - y) / ph) * (hi - lo);
  }

  /* ---------------- interaction (view only) ---------------- */
  /** Which part of the canvas a point is on: the price axis, the time axis, or the plot (lane counts as plot). */
  private zone(x: number, y: number): 'price' | 'time' | 'plot' {
    if (x >= this.w - AXIS_W && y < this.h - TIME_H) return 'price';
    if (y >= this.h - TIME_H && x < this.w - AXIS_W) return 'time';
    return 'plot';
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const tUnder = this.tAt(Math.min(mx, this.plotRight()));
    const tf = this.frame()?.view.tf;
    // proportional to the wheel / trackpad delta (smooth on trackpads, ~1.12x per mouse notch), clamped per event
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const k = Math.max(0.7, Math.min(1.4, Math.exp(-dy * 0.0011)));
    if ((e.shiftKey || this.zone(mx, my) === 'price') && tf) {
      const { lo, hi } = this.lastScale;
      const pm = this.pAt(Math.min(my, this.h - TIME_H));
      this.manualPrice = { lo: pm - (pm - lo) / k, hi: pm + (hi - pm) / k };
    } else {
      this.barSpacing = Math.max(2, Math.min(160, this.barSpacing * k));
      if (tf) {
        // keep the time under the mouse fixed
        const msPerBar = OFP_TF_MS[tf];
        const pxPerMs = this.barSpacing / msPerBar;
        const tEnd = tUnder + (this.plotRight() - Math.min(mx, this.plotRight())) / pxPerMs;
        const last = this.lastBarEnd();
        this.rightOffset = Math.max(-200, Math.min(400, (tEnd - last) / msPerBar));
      }
    }
    this.invalidate();
  };

  private lastBarEnd() {
    const f = this.frame();
    const b = f?.view.bars;
    const tf = f?.view.tf;
    if (!b?.length || !tf) return f?.now ?? 0;
    return b[b.length - 1]!.t + OFP_TF_MS[tf];
  }

  private onDown = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const f = this.frame();
    const zone = this.zone(x, y);
    if (zone === 'plot' && f?.tool === 'hline') {
      this.cb.onDrawing?.({ kind: 'hline', price: this.pAt(y) });
      return;
    }
    if (zone === 'plot' && f?.tool === 'trend') {
      this.trendStart = { t: this.tAt(x), p: this.pAt(y) };
      return;
    }
    // plot: pan · price axis: drag = vertical (price) zoom · time axis: drag = horizontal (time) zoom
    this.drag = { x: e.clientX, y: e.clientY, ro: this.rightOffset, bs: this.barSpacing, mp: this.manualPrice ?? { lo: this.lastScale.lo, hi: this.lastScale.hi }, moved: false, mode: zone === 'plot' ? 'pan' : zone };
  };

  private onMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (this.drag) {
      const tf = this.frame()?.view.tf;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (this.drag.mode === 'price') {
        // drag down = compress (zoom out), drag up = stretch (zoom in), around the range centre
        this.scalePrice(Math.exp(dy * 0.006), this.drag.mp!);
      } else if (this.drag.mode === 'time') {
        this.barSpacing = Math.max(2, Math.min(160, this.drag.bs * Math.exp(dx * 0.006)));
      } else {
        if (tf) this.rightOffset = Math.max(-200, Math.min(400, this.drag.ro + dx / this.barSpacing));
        if (Math.abs(dy) > 6 || this.manualPrice) {
          const span = this.drag.mp!.hi - this.drag.mp!.lo;
          const dp = (dy / Math.max(1, this.h - TIME_H)) * span;
          this.manualPrice = { lo: this.drag.mp!.lo + dp, hi: this.drag.mp!.hi + dp };
        }
      }
    }
    this.mouse = inside ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null;
    if (!this.drag && this.mouse) {
      const z = this.zone(this.mouse.x, this.mouse.y);
      this.canvas.style.cursor = z === 'price' ? 'ns-resize' : z === 'time' ? 'ew-resize' : '';
    }
    this.invalidate();
  };

  private onUp = (e: PointerEvent) => {
    if (this.trendStart) {
      const rect = this.canvas.getBoundingClientRect();
      const t2 = this.tAt(e.clientX - rect.left);
      const p2 = this.pAt(e.clientY - rect.top);
      if (Math.abs(t2 - this.trendStart.t) > 1 || Math.abs(p2 - this.trendStart.p) > 0)
        this.cb.onDrawing?.({ kind: 'trend', t1: this.trendStart.t, p1: this.trendStart.p, t2, p2 });
      this.trendStart = null;
    }
    this.drag = null;
  };

  private onLeave = () => {
    if (!this.drag) {
      this.mouse = null;
      this.cb.onHover?.(null);
      this.invalidate();
    }
  };

  private onDbl = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    // double-click on the price axis = automatic price range only; anywhere else = full reset
    if (this.zone(e.clientX - rect.left, e.clientY - rect.top) === 'price') this.autoPrice();
    else this.resetView();
  };

  /* ---------------- drawing ---------------- */
  draw() {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.drawFrame();
    if (!t0) return;
    const ms = performance.now() - t0;
    this.stats.draws++;
    this.stats.lastDrawMs = ms;
    this.stats.maxDrawMs = Math.max(this.stats.maxDrawMs, ms);
    this.canvas.dataset.drawMs = ms.toFixed(2);
    this.canvas.dataset.draws = String(this.stats.draws);
    this.canvas.dataset.heatBuilds = String(this.stats.heatBuilds);
    this.canvas.dataset.heatBuildMs = this.stats.lastHeatBuildMs.toFixed(2);
  }

  private drawFrame() {
    const ctx = this.ctx;
    const f = this.frame();
    if (!ctx || !f || this.w < 50 || this.h < 50) return;
    const { view } = f;
    // clean view: candles, axes, drawings only - the user's layer choices are kept for when it is turned off
    const layers: LayerFlags = f.clean ? { heatmap: false, footprint: false, bubbles: false, profile: false, levels: false, orderBook: false, reversals: false, strong: false } : f.layers;
    const liqOn = !!f.liq && layers.strong;
    this.lane = liqOn && f.liqFlags?.lane !== false && this.w >= 640 ? LANE_W : 0;
    const tf = view.tf;
    const msBar = OFP_TF_MS[tf];
    const tick = view.recorder.tick;
    const plotW = this.plotRight();
    const plotH = this.h - TIME_H;
    const pxPerMs = this.barSpacing / msBar;
    const tEnd = this.lastBarEnd() + this.rightOffset * msBar;
    const tStart = tEnd - plotW / pxPerMs;
    const vis = view.bars.filter((b) => b.t + msBar > tStart && b.t < tEnd);

    // price range: visible candles (+ last), or the manual range the user dragged to
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of vis) {
      lo = Math.min(lo, b.l);
      hi = Math.max(hi, b.h);
    }
    if (!Number.isFinite(lo)) {
      const p = view.last ?? view.quote?.bid ?? 0;
      lo = p - 20 * tick;
      hi = p + 20 * tick;
    }
    const pad = Math.max((hi - lo) * 0.08, tick * 4);
    lo -= pad;
    hi += pad;
    if (this.manualPrice) ({ lo, hi } = this.manualPrice);
    this.lastScale = { lo, hi, tEnd, pxPerMs };
    const tickPx = (tick / (hi - lo)) * plotH;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    // grid
    const pStep = niceStep(hi - lo, plotH / 55);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let p = Math.ceil(lo / pStep) * pStep; p <= hi; p += pStep) {
      const y = Math.round(this.y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
    }

    const vk = `${Math.round(tStart)}|${Math.round(tEnd)}|${pxPerMs.toPrecision(6)}`;
    if (vk !== this.viewKey) {
      this.viewKey = vk;
      this.cb.onView?.({ from: tStart, to: tEnd, pxPerMs });
    }
    if (layers.heatmap && f.heat) this.drawHeatLayer(ctx, f, tStart, tEnd, plotW, plotH, tickPx);
    else if (layers.heatmap) this.drawHeat(ctx, f, tStart, tEnd, tickPx);
    else {
      this.heatCols = [];
      this.heatNewest = null;
    }
    this.drawGaps(ctx, f, tStart, tEnd, plotH);
    if (liqOn) this.drawLiqBands(ctx, f, tStart, tEnd, plotW, tickPx, layers.heatmap && !!f.heat);
    else if (layers.strong) this.drawBands(ctx, f, tStart, tEnd, plotW, tickPx);
    if (layers.profile) this.drawProfile(ctx, f, plotW, plotH, tickPx);
    if (layers.levels) this.drawLevelLines(ctx, f, plotW);
    if (layers.orderBook && bookShown(f)) this.drawBook(ctx, f, plotW, tickPx);
    this.drawCandles(ctx, vis, msBar, pxPerMs);
    if (layers.bubbles) this.drawBubbles(ctx, f, vis, msBar, tick);
    if (layers.footprint) this.drawFootprint(ctx, vis, msBar, tick, tickPx, f.precision);
    if (layers.strong && !liqOn && bookShown(f)) this.drawStrongLabels(ctx, f, plotW, plotH);
    if (layers.levels) this.drawLevelLabels(ctx, f, plotW, plotH);
    if (layers.reversals) this.drawReversals(ctx, f, msBar);
    this.drawDrawings(ctx, f, plotW);

    if (f.demo) {
      ctx.save();
      ctx.font = '800 34px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(229,163,59,0.10)';
      ctx.textAlign = 'center';
      ctx.fillText('DEMO FIXTURE · NOT LIVE · NOT MARKET DATA', plotW / 2, plotH / 2);
      ctx.restore();
    }
    ctx.restore();

    if (this.lane) this.drawLane(ctx, f, plotW, plotH);
    else if (liqOn) this.drawLiqNotice(ctx, f, plotW);
    this.drawAxes(ctx, { ...f, layers }, tStart, tEnd, plotW, plotH, pStep, msBar);
    this.drawCrosshair(ctx, f, plotW, plotH, msBar);
  }

  /**
   * Liquidity heatmap (yellow / gold / cyan / blue tiers). Completed columns are rendered once into an off-screen
   * layer keyed by view, size, tiers, settings, filters and data version; mouse moves only re-blit it. The newest live
   * column (still filling) is drawn on top each frame. Sides are kept; columns are merged only while contiguous
   * (a recording gap is never bridged); nothing is drawn where nothing was observed.
   */
  private drawHeatLayer(ctx: CanvasRenderingContext2D, f: ChartFrame, tStart: number, tEnd: number, plotW: number, plotH: number, tickPx: number) {
    const src = f.heat!;
    const tiers = src.tiers;
    this.heatTiers = tiers;
    if (!tiers) {
      this.heatCols = [];
      this.heatNewest = null;
      return;
    }
    const rec = f.view.recorder;
    const all = rec.columnsIn(-Infinity, Infinity);
    const liveStart = all.length ? all[0]!.t : Infinity;
    const newestRaw = all.length ? all[all.length - 1]! : null;
    const bucket = bucketFor(this.lastScale.pxPerMs);
    const key = [Math.round(tStart), Math.round(tEnd), this.lastScale.lo, this.lastScale.hi, this.w, this.h, this.dpr, this.lane, tiers.medium, tiers.strong, tiers.veryStrong, f.gain, f.scale, f.heatOpacity, src.filters.bid, src.filters.ask, src.filters.strongOnly, src.filters.history, src.version, src.contractKey, bucket, all.length, newestRaw?.t ?? 0, liveStart].join('|');
    if (key !== this.heatKey || !this.heatLayer) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      const hist = src.filters.history && src.contractKey ? src.history(tStart, Math.min(tEnd, liveStart), bucket).filter((c) => c.t + c.dt <= liveStart) : [];
      const live: HeatColumn[] = [];
      for (const c of all) {
        if (c === newestRaw || c.t + rec.bucketMs <= tStart || c.t > tEnd || c.validMs <= 0) continue;
        const hit = this.liveConv.get(c);
        if (hit && hit.validMs === c.validMs) live.push(hit.col);
        else {
          const col = this.toHeatColumn(c, rec.bucketMs);
          this.liveConv.set(c, { validMs: c.validMs, col });
          live.push(col);
        }
      }
      this.heatCols = [...hist, ...live];
      if (!this.heatLayer && typeof document !== 'undefined') this.heatLayer = document.createElement('canvas');
      const lc = this.heatLayer?.getContext?.('2d') ?? null;
      if (this.heatLayer && lc) {
        this.heatLayer.width = Math.max(1, Math.floor(this.w * this.dpr));
        this.heatLayer.height = Math.max(1, Math.floor(this.h * this.dpr));
        lc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        lc.clearRect(0, 0, this.w, this.h);
        lc.save();
        lc.beginPath();
        lc.rect(0, 0, plotW, plotH);
        lc.clip();
        this.paintHeat(lc, this.heatCols, tiers, f, tickPx, plotW, rec.tick);
        lc.restore();
      }
      this.heatKey = key;
      this.stats.heatBuilds++;
      if (t0) this.stats.lastHeatBuildMs = performance.now() - t0;
    }
    if (this.heatLayer && this.heatLayer.width > 1) ctx.drawImage(this.heatLayer, 0, 0, this.w, this.h);
    // where recorded history (gateway) hands over to this page's live observation - so the two are never confused
    const xs = this.x(liveStart);
    if (Number.isFinite(xs) && xs > 0 && xs < plotW && src.filters.history && src.contractKey && !f.replay) {
      ctx.save();
      ctx.strokeStyle = 'rgba(200,210,230,0.35)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(xs) + 0.5, 0);
      ctx.lineTo(Math.round(xs) + 0.5, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 9px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(200,210,230,0.75)';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'right';
      ctx.fillText('recorded ◂', xs - 4, 4);
      ctx.textAlign = 'left';
      ctx.fillText(f.depthCurrent === false ? '▸ this session · no current depth' : '▸ this session', xs + 4, 4);
      ctx.restore();
    }
    // the newest live column, still filling, drawn on top every frame
    this.heatNewest = newestRaw && newestRaw.validMs > 0 && newestRaw.t <= tEnd ? this.toHeatColumn(newestRaw, rec.bucketMs) : null;
    if (this.heatNewest) this.paintHeat(ctx, [this.heatNewest], tiers, f, tickPx, plotW, rec.tick);
  }

  private toHeatColumn(c: { t: number; validMs: number; cells: Map<number, { tick: number; side: Side; sizeMs: number }> }, bucketMs: number): HeatColumn {
    const cells: HeatColumn['cells'] = [];
    for (const x of c.cells.values()) if (x.sizeMs > 0) cells.push({ tick: x.tick, side: x.side, avg: x.sizeMs / c.validMs });
    return { t: c.t, dt: bucketMs, validMs: c.validMs, cells, source: 'LIVE' };
  }

  /** Paint columns; contiguous columns narrower than MERGE_PX are merged (validMs-weighted), never across a gap. */
  private paintHeat(ctx: CanvasRenderingContext2D, cols: readonly HeatColumn[], tiers: HeatTiers, f: ChartFrame, tickPx: number, plotW: number, tickSize: number) {
    const filt: HeatFilters = f.heat!.filters;
    const hpx = Math.max(1.5, tickPx);
    // only price levels inside the visible price range (plus one tick) are accumulated or painted
    const { lo, hi } = this.lastScale;
    const tickLo = Math.floor(lo / tickSize) - 1;
    const tickHi = Math.ceil(hi / tickSize) + 1;
    const ph = this.h - TIME_H;
    const yk = -(tickSize / (hi - lo || 1)) * ph; // y = y0 + yk * tick (same mapping as this.y)
    const y0 = ph + (lo / (hi - lo || 1)) * ph;
    // maps are reused between column groups (cleared, not re-allocated)
    const acc = new Map<number, { tick: number; side: Side; w: number; v: number }>();
    const both = new Map<number, number>();
    let gx0 = 0;
    let gx1 = 0;
    let prevEnd: number | null = null;
    let prevSrc: string | null = null;
    const flush = () => {
      if (!acc.size) return;
      both.clear();
      for (const a of acc.values()) {
        a.v = a.v / a.w; // -> average
        if (!cellVisible({ tick: a.tick, side: a.side, avg: a.v }, filt, tiers)) a.w = 0;
        else both.set(a.tick, (both.get(a.tick) ?? 0) + 1);
      }
      const x0 = Math.max(0, gx0);
      const w = Math.max(1, Math.min(plotW, gx1) - x0);
      for (const a of acc.values()) {
        if (a.w === 0) continue;
        const y = y0 + yk * a.tick;
        ctx.fillStyle = this.heatStyle(a.v, tiers, f);
        // both sides at one price inside this column (price moved through it): ASK top half, BID bottom half
        if ((both.get(a.tick) ?? 0) > 1) ctx.fillRect(x0, a.side === 'ASK' ? y - hpx / 2 : y, w, hpx / 2);
        else ctx.fillRect(x0, y - hpx / 2, w, hpx);
      }
      acc.clear();
    };
    for (const c of cols) {
      const x0 = this.x(c.t);
      const x1 = this.x(c.t + c.dt);
      if (x1 < 0 || x0 > plotW) {
        flush();
        prevEnd = null;
        continue;
      }
      const contiguous = prevEnd !== null && prevEnd === c.t && prevSrc === c.source;
      if (!contiguous || x1 - gx0 >= MERGE_PX) {
        flush();
        gx0 = x0;
      }
      gx1 = x1;
      prevEnd = c.t + c.dt;
      prevSrc = c.source;
      const wgt = Math.max(1, c.validMs);
      for (const cell of c.cells) {
        if (cell.tick < tickLo || cell.tick > tickHi) continue;
        const k = cell.tick * 2 + (cell.side === 'ASK' ? 1 : 0);
        let a = acc.get(k);
        if (!a) acc.set(k, (a = { tick: cell.tick, side: cell.side, w: 0, v: 0 }));
        a.w += wgt;
        a.v += cell.avg * wgt;
      }
    }
    flush();
  }

  /** fillStyle for a size, memoised per setting (sizes quantised to 0.05 contracts - far below a visible change). */
  private heatStyle(avg: number, tiers: HeatTiers, f: ChartFrame): string {
    const sk = `${tiers.medium}|${tiers.strong}|${tiers.veryStrong}|${f.gain}|${f.scale}|${f.heatOpacity}`;
    if (sk !== this.styleKey) {
      this.styleKey = sk;
      this.styleMemo.clear();
    }
    const q = Math.round(avg * 20);
    let st = this.styleMemo.get(q);
    if (st === undefined) {
      const { rgb, alpha } = heatColor(q / 20, tiers, f.gain, f.scale);
      st = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(alpha * f.heatOpacity).toFixed(3)})`;
      if (this.styleMemo.size < 20_000) this.styleMemo.set(q, st);
    }
    return st;
  }

  private heatHover(f: ChartFrame, t: number, tick: number): (HeatHover & { status: HeatStatus }) | null {
    const tiers = this.heatTiers;
    if (!tiers || !f.heat || !f.layers.heatmap || f.clean) return null;
    const cols = this.heatNewest ? [...this.heatCols, this.heatNewest] : this.heatCols;
    const h = hoverAt(cols, t, tick, tiers, f.heat.filters);
    if (!h) return null;
    const newest = this.heatNewest !== null && h.t === this.heatNewest.t && h.source === 'LIVE';
    const status: HeatStatus = f.replay ? 'RECORDED · replay' : h.source === 'RECORDED' ? 'HISTORICAL · recorded (gateway)' : newest && f.depthCurrent !== false ? 'CURRENT · live IBKR depth' : 'HISTORICAL · observed live this session';
    return { ...h, status };
  }

  private drawHeat(ctx: CanvasRenderingContext2D, f: ChartFrame, tStart: number, tEnd: number, tickPx: number) {
    const rec = f.view.recorder;
    const cols = rec.columnsIn(tStart, tEnd);
    if (!cols.length) return;
    // reference = 99th percentile of visible time-weighted sizes (one huge level never washes out the rest, and
    // ordinary sizes stay in the dark-blue / cyan range)
    const avgs: number[] = [];
    for (const c of cols) if (c.validMs > 0) for (const cell of c.cells.values()) if (cell.sizeMs > 0) avgs.push(cell.sizeMs / c.validMs);
    if (!avgs.length) return;
    avgs.sort((a, b) => a - b);
    const ref = avgs[Math.min(avgs.length - 1, Math.floor(avgs.length * 0.99))]!;
    const hpx = Math.max(2, tickPx);
    // merge columns narrower than 2 px
    let groupX = -Infinity;
    let acc = new Map<number, { sizeMs: number; validMs: number; tick: number }>();
    let accValid = 0;
    let gx0 = 0;
    let gx1 = 0;
    const flush = () => {
      if (!acc.size || accValid <= 0) return;
      for (const a of acc.values()) {
        const v = heatIntensity(a.sizeMs / accValid, ref, f.scale, f.gain);
        if (v < 0.04) continue;
        const [r, g, b] = intensityColor(v);
        ctx.fillStyle = `rgba(${r},${g},${b},${(0.22 + 0.6 * v) * f.heatOpacity})`;
        const p = fromTick(a.tick, rec.tick);
        ctx.fillRect(gx0, this.y(p) - hpx / 2, Math.max(1, gx1 - gx0), hpx);
      }
    };
    for (const c of cols) {
      if (c.validMs <= 0) continue;
      const x0 = this.x(c.t);
      const x1 = this.x(c.t + rec.bucketMs);
      if (x1 - groupX >= 2 || !acc.size) {
        flush();
        acc = new Map();
        accValid = 0;
        groupX = x0;
        gx0 = x0;
      }
      gx1 = x1;
      accValid += c.validMs;
      for (const cell of c.cells.values()) {
        // bid and ask at the same price share the row (resting size is shown, never the side as a signal)
        let a = acc.get(cell.tick);
        if (!a) acc.set(cell.tick, (a = { sizeMs: 0, validMs: 0, tick: cell.tick }));
        a.sizeMs += cell.sizeMs;
      }
    }
    flush();
  }

  private drawGaps(ctx: CanvasRenderingContext2D, f: ChartFrame, tStart: number, tEnd: number, plotH: number) {
    for (const g of f.view.gaps) {
      if (g.to < tStart || g.from > tEnd) continue;
      const x0 = Math.max(0, this.x(g.from));
      const x1 = Math.min(this.plotRight(), this.x(g.to));
      if (x1 - x0 < 1) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(239,93,93,0.06)';
      ctx.fillRect(x0, 0, x1 - x0, plotH);
      ctx.strokeStyle = 'rgba(239,93,93,0.18)';
      ctx.beginPath();
      for (let x = x0 - plotH; x < x1; x += 10) {
        ctx.moveTo(Math.max(x0, x), Math.max(0, x0 - x));
        ctx.lineTo(Math.min(x1, x + plotH), Math.min(plotH, x1 - x));
      }
      ctx.stroke();
      if (x1 - x0 > 60) {
        ctx.fillStyle = 'rgba(239,93,93,0.75)';
        ctx.font = '700 10px Inter, system-ui, sans-serif';
        ctx.fillText('NO DATA (gap)', x0 + 6, 14);
      }
      ctx.restore();
    }
  }

  /** Observed strong-liquidity bands: only where the recorder actually saw the level (never extended). */
  private drawBands(ctx: CanvasRenderingContext2D, f: ChartFrame, tStart: number, tEnd: number, plotW: number, tickPx: number) {
    const bands = f.view.recorder.strongBands(tStart, tEnd, BAND_PARAMS);
    const hh = Math.max(4, Math.min(12, tickPx * 1.3));
    ctx.save();
    for (const b of bands) {
      const x0 = Math.max(0, this.x(b.from));
      const x1 = Math.min(plotW, this.x(b.to));
      if (x1 - x0 < 1) continue;
      const rgb = BAND_RGB[bandTier(b.meanRelative)];
      const y = this.y(fromTick(b.tick, f.view.recorder.tick));
      ctx.shadowColor = `rgba(${rgb},0.8)`;
      ctx.shadowBlur = 10;
      ctx.fillStyle = `rgba(${rgb},0.9)`;
      ctx.fillRect(x0, y - hh / 2, x1 - x0, hh);
    }
    ctx.restore();
  }

  /** Current strong resting levels (still displayed now): a right-edge tag, de-overlapped. */
  private drawStrongLabels(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number, plotH: number) {
    const levels = f.view.strong.slice(0, 6);
    if (!levels.length) return;
    const ys = spreadLabels(levels.map((s) => this.y(s.price)), 17, 9, plotH - 9);
    ctx.save();
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    levels.forEach((s, i) => {
      const rgb = BAND_RGB[bandTier(s.relative)];
      const text = `${s.side} ${s.price.toFixed(f.precision)} · ${s.size} · ${s.relative.toFixed(1)}×`;
      const tw = ctx.measureText(text).width + 12;
      const x = plotW - 92 - tw;
      const y = ys[i]!;
      ctx.strokeStyle = `rgba(${rgb},0.7)`;
      ctx.beginPath();
      ctx.moveTo(x + tw, y);
      ctx.lineTo(plotW - 88, this.y(s.price));
      ctx.stroke();
      ctx.fillStyle = 'rgba(6,10,18,0.9)';
      ctx.fillRect(x, y - 8, tw, 16);
      ctx.strokeRect(x + 0.5, y - 7.5, tw - 1, 15);
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fillText(text, x + 6, y);
    });
    ctx.restore();
  }

  /**
   * STRONG / MEDIUM bands (visualization only): where the classified level was actually observed in recorded or live
   * 15 s cells (never extended), plus a short marker at the plot edge for each level classified in the book NOW.
   */
  private drawLiqBands(ctx: CanvasRenderingContext2D, f: ChartFrame, tStart: number, tEnd: number, plotW: number, tickPx: number, outline = false) {
    const liq = f.liq!;
    const fl = f.liqFlags ?? DEFAULT_LIQ_FLAGS;
    const tick = f.view.recorder.tick;
    const hh = Math.max(3, Math.min(10, tickPx * 1.1));
    ctx.save();
    for (const b of liq.bands) {
      if (b.to < tStart || b.from > tEnd || !liqVisible(fl, b.cls, b.side)) continue;
      const x0 = Math.max(0, this.x(b.from));
      const x1 = Math.min(plotW, this.x(b.to));
      if (x1 - x0 < 1) continue;
      const y = this.y(fromTick(b.tick, tick));
      const rgb = LIQ_RGB[b.cls][b.side];
      if (outline) {
        // heatmap ON: the class bands become outlines so the yellow / gold heat stays readable
        ctx.strokeStyle = b.cls === 'STRONG' ? `rgba(${rgb},0.95)` : `rgba(${rgb},0.5)`;
        ctx.lineWidth = b.cls === 'STRONG' ? 1.5 : 1;
        ctx.setLineDash(b.cls === 'STRONG' ? [] : [4, 3]);
        ctx.strokeRect(x0 + 0.5, y - hh / 2 - 1.5, x1 - x0 - 1, hh + 3);
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      } else if (b.cls === 'STRONG') {
        ctx.fillStyle = `rgba(${rgb},0.82)`;
        ctx.fillRect(x0, y - hh / 2, x1 - x0, hh);
      } else {
        ctx.fillStyle = `rgba(${rgb},0.30)`;
        ctx.fillRect(x0, y - hh * 0.35, x1 - x0, hh * 0.7);
        ctx.strokeStyle = `rgba(${rgb},0.75)`;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0 + 0.5, y - hh * 0.35 + 0.5, x1 - x0 - 1, Math.max(1, hh * 0.7 - 1));
        ctx.setLineDash([]);
      }
    }
    for (const l of f.depthCurrent === false ? [] : liq.levels) {
      if (!liqVisible(fl, l.cls, l.side)) continue;
      const y = this.y(l.price);
      ctx.fillStyle = `rgba(${LIQ_RGB[l.cls][l.side]},0.95)`;
      ctx.fillRect(plotW - 10, y - hh / 2, 10, hh);
    }
    ctx.restore();
  }

  /** One-line status when the lane is hidden (narrow chart / lane toggled off). */
  private drawLiqNotice(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number) {
    const text = this.liqStatusText(f);
    if (!text) return;
    ctx.save();
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(6,10,18,0.88)';
    ctx.fillRect(plotW - tw - 6, 6, tw, 16);
    ctx.fillStyle = '#e5a33b';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, plotW - tw, 14);
    ctx.restore();
  }

  private liqStatusText(f: ChartFrame): string | null {
    const liq = f.liq;
    if (!liq) return null;
    if (f.replay) return 'Replay: recorded averages - no live resting levels';
    if (f.depthCurrent === false) return `Depth ${(f.depth?.state ?? 'not current').replace('_', ' ')} - no current levels`;
    if (liq.status === 'COLLECTING') return `Collecting depth history - ${fmtRest(liq.historyMs)} of ${fmtRest(liq.params.minHistoryMs)} needed`;
    if (liq.status === 'NO_BOOK') return `Depth ${f.depth?.state && f.depth.state !== 'LIVE' ? f.depth.state.replace('_', ' ') : 'not valid'} - no current levels`;
    return null;
  }

  /** Right-hand liquidity label lane: header (status / freshness) and de-overlapped two-line labels. */
  private drawLane(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number, plotH: number) {
    const liq = f.liq!;
    const fl = f.liqFlags ?? DEFAULT_LIQ_FLAGS;
    const x0 = plotW;
    const w = this.lane;
    ctx.save();
    ctx.fillStyle = '#070b13';
    ctx.fillRect(x0, 0, w, plotH);
    ctx.strokeStyle = 'rgba(120,140,180,0.18)';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, 0);
    ctx.lineTo(x0 + 0.5, plotH);
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(x0, 0, w, plotH);
    ctx.clip();
    ctx.textBaseline = 'middle';
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#9aa4b6';
    ctx.fillText('LIQUIDITY · displayed contracts', x0 + 8, 11);
    ctx.font = '500 10px Inter, system-ui, sans-serif';
    const status = this.liqStatusText(f);
    const d = f.depth;
    const fresh =
      d && d.lastChangeMs !== null
        ? `Depth ${new Date(d.lastChangeMs).toISOString().slice(11, 19)} UTC${d.confirmedAgoMs !== null ? ` · ${Math.max(0, Math.round(d.confirmedAgoMs / 1000))} s ago` : ''}`
        : 'Depth: no update yet';
    ctx.fillStyle = status ? '#e5a33b' : d && d.state === 'LIVE' ? '#7fd8a6' : '#e5a33b';
    const head = status ?? fresh;
    if (ctx.measureText(head).width > w - 14 && head.includes(' - ')) {
      // two lines rather than clipping the status at the lane edge
      const [a, ...rest] = head.split(' - ');
      ctx.fillText(a!, x0 + 8, 25);
      ctx.fillText(rest.join(' - '), x0 + 8, 38);
    } else ctx.fillText(head, x0 + 8, 25);
    if (!status && liq.strongMin !== null && liq.mediumMin !== null) {
      ctx.fillStyle = '#6f7a8e';
      ctx.fillText(`STRONG ≥ ${fmtQty(liq.strongMin)} · MEDIUM ≥ ${fmtQty(liq.mediumMin)}`, x0 + 8, 38);
    }
    const levels = f.depthCurrent === false ? [] : liq.levels.filter((l) => liqVisible(fl, l.cls, l.side));
    const top = 56;
    const slots = laneLabelSlots(levels.map((l) => this.y(l.price)), 30, top, plotH - 16);
    levels.forEach((l, i) => {
      const y = slots[i];
      if (y === null || y === undefined) return;
      const rgb = LIQ_RGB[l.cls][l.side];
      const ly = this.y(l.price);
      // leader from the price (at the plot edge) to the label
      ctx.strokeStyle = `rgba(${rgb},0.7)`;
      ctx.beginPath();
      ctx.moveTo(x0, ly);
      ctx.lineTo(x0 + 6, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(10,15,26,0.96)';
      ctx.fillRect(x0 + 6, y - 13, w - 10, 26);
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fillRect(x0 + 6, y - 13, 3, 26);
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      ctx.fillText(`${l.cls} ${l.side} ${l.price.toFixed(f.precision)}`, x0 + 13, y - 6);
      ctx.font = '500 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#c4ccda';
      const rest = `rest ${l.persistAtLeast ? '≥ ' : ''}${fmtRest(l.persistMs)}`;
      ctx.fillText(fl.qty ? `${fmtQty(l.size)} contracts · ${rest}` : rest, x0 + 13, y + 6);
    });
    const hidden = slots.filter((s) => s === null).length;
    if (hidden) {
      ctx.fillStyle = '#6f7a8e';
      ctx.fillText(`+${hidden} more (see Liquidity Strength)`, x0 + 8, plotH - 6);
    }
    ctx.restore();
  }

  private profileWidth(plotW: number) {
    return Math.min(260, Math.max(120, plotW * 0.18));
  }

  private drawProfile(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number, plotH: number, tickPx: number) {
    const p = f.view.stats.profile;
    if (!p.rows.length || p.high === null || p.low === null) return;
    const width = this.profileWidth(plotW);
    const max = Math.max(...p.rows.map((r) => r.volume));
    const tick = f.view.recorder.tick;
    const hpx = Math.max(1, tickPx - (tickPx > 4 ? 1 : 0));
    const yTop = Math.max(0, this.y(fromTick(p.high, tick)) - hpx);
    const yBot = Math.min(plotH, this.y(fromTick(p.low, tick)) + hpx);
    ctx.save();
    // frame + title, like the reference's "Volume Profile (Session)" box
    ctx.fillStyle = 'rgba(40,36,110,0.10)';
    ctx.fillRect(0, yTop, width + 6, yBot - yTop);
    ctx.strokeStyle = 'rgba(123,108,255,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(0.5, yTop + 0.5, width + 6, yBot - yTop - 1);
    ctx.setLineDash([]);
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    const title = 'Volume Profile (session · executed prints)';
    const ty = Math.max(14, yTop - 2);
    ctx.fillStyle = 'rgba(6,8,20,0.88)';
    ctx.fillRect(0, ty - 13, ctx.measureText(title).width + 10, 14);
    ctx.fillStyle = 'rgba(190,184,255,0.9)';
    ctx.textBaseline = 'bottom';
    ctx.fillText(title, 5, ty);
    for (const r of p.rows) {
      const price = fromTick(r.tick, tick);
      const w = (r.volume / max) * width;
      const y = this.y(price) - hpx / 2;
      const inVa = p.val !== null && p.vah !== null && r.tick >= p.val && r.tick <= p.vah;
      const g = ctx.createLinearGradient(0, 0, Math.max(1, w), 0);
      if (r.tick === p.poc) {
        g.addColorStop(0, 'rgba(245,165,36,0.55)');
        g.addColorStop(1, 'rgba(255,196,80,1)');
      } else {
        g.addColorStop(0, `${C.vp}${inVa ? 0.35 : 0.15})`);
        g.addColorStop(1, `${C.vp}${inVa ? 0.85 : 0.42})`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, y, w, hpx);
    }
    ctx.restore();
  }

  private levelList(f: ChartFrame): Array<{ name: string; price: number; col: string }> {
    const p = f.view.stats.profile;
    const tick = f.view.recorder.tick;
    const out: Array<{ name: string; price: number; col: string }> = [];
    const defs: Array<[string, number | null, string]> = [['VAH', p.vah, C.va], ['POC', p.poc, C.poc], ['VAL', p.val, C.va]];
    for (const [name, tk, col] of defs) if (tk !== null) out.push({ name, price: fromTick(tk, tick), col });
    return out;
  }

  private drawLevelLines(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number) {
    ctx.save();
    for (const l of this.levelList(f)) {
      const y = Math.round(this.y(l.price)) + 0.5;
      ctx.strokeStyle = l.col;
      ctx.globalAlpha = l.name === 'POC' ? 0.85 : 0.6;
      ctx.setLineDash(l.name === 'POC' ? [4, 3] : [6, 5]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** POC / VAH / VAL tags at the profile edge, spread apart so they never overlap (leader line to the level). */
  private drawLevelLabels(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number, plotH: number) {
    const levels = this.levelList(f);
    if (!levels.length) return;
    const ys = spreadLabels(levels.map((l) => this.y(l.price)), 21, 10, plotH - 10);
    const labelX = this.profileWidth(plotW) + 14;
    ctx.save();
    ctx.font = '700 11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    levels.forEach((l, i) => {
      const y = ys[i]!;
      const ly = this.y(l.price);
      const text = `${l.name} ${l.price.toFixed(f.precision)}`;
      const tw = ctx.measureText(text).width + 14;
      if (Math.abs(y - ly) > 1) {
        ctx.strokeStyle = l.col;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(labelX - 8, ly);
        ctx.lineTo(labelX, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = l.name === 'POC' ? 'rgba(52,32,4,0.96)' : 'rgba(8,16,44,0.96)';
      ctx.fillRect(labelX, y - 10, tw, 20);
      ctx.strokeStyle = l.col;
      ctx.strokeRect(labelX + 0.5, y - 9.5, tw - 1, 19);
      ctx.fillStyle = l.name === 'POC' ? '#ffd27a' : '#b3c8ff';
      ctx.fillText(text, labelX + 7, y);
    });
    ctx.restore();
  }

  private drawCandles(ctx: CanvasRenderingContext2D, bars: readonly FootprintBar[], msBar: number, pxPerMs: number) {
    const bw = Math.max(1.5, Math.min(16, msBar * pxPerMs * 0.66));
    for (const b of bars) {
      const cx = Math.round(this.x(b.t + msBar / 2)) + 0.5;
      const up = b.c >= b.o;
      const col = up ? C.up : C.down;
      const y0 = this.y(Math.max(b.o, b.c));
      const y1 = this.y(Math.min(b.o, b.c));
      ctx.globalAlpha = b.source === 'BARS_ONLY' ? 0.55 : 1;
      // dark halo first: keeps every candle readable on top of the brightest heat / bands
      ctx.strokeStyle = 'rgba(2,4,8,0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, this.y(b.h) - 1);
      ctx.lineTo(cx, this.y(b.l) + 1);
      ctx.stroke();
      ctx.fillStyle = 'rgba(2,4,8,0.95)';
      ctx.fillRect(cx - bw / 2 - 1, y0 - 1, bw + 2, Math.max(1, y1 - y0) + 2);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, this.y(b.h));
      ctx.lineTo(cx, this.y(b.l));
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(cx - bw / 2, y0, bw, Math.max(1, y1 - y0));
      ctx.globalAlpha = 1;
    }
  }

  /** Adaptive bubbles: only the K largest executed clusters in view (K from density x visible bars). */
  private drawBubbles(ctx: CanvasRenderingContext2D, f: ChartFrame, bars: readonly FootprintBar[], msBar: number, tick: number) {
    const vols: number[] = [];
    for (const b of bars) for (const lv of b.levels.values()) vols.push(lv.buy + lv.sell + lv.unknown);
    if (!vols.length) return;
    const k = Math.max(4, Math.round(bars.length * BUBBLES_PER_BAR[f.bubbleDensity]));
    const threshold = topKThreshold(vols, k);
    const max = Math.max(...vols);
    const maxR = Math.max(4, Math.min(15, this.barSpacing * 0.8));
    const a = f.bubbleOpacity;
    let drawn = 0;
    for (const b of bars) {
      const cx = this.x(b.t + msBar / 2);
      for (const [kk, lv] of b.levels) {
        const v = lv.buy + lv.sell + lv.unknown;
        if (v < threshold || drawn >= k) continue;
        drawn++;
        const r = Math.max(2.5, Math.sqrt(v / max) * maxR);
        const y = this.y(fromTick(kk, tick));
        const rgb = lv.unknown > lv.buy + lv.sell ? '160,168,184' : lv.buy >= lv.sell ? '38,208,124' : '239,75,95';
        const g = ctx.createRadialGradient(cx, y, 0, cx, y, r);
        g.addColorStop(0, `rgba(${rgb},${0.9 * a})`);
        g.addColorStop(0.75, `rgba(${rgb},${0.45 * a})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb},${0.9 * a})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  private drawFootprint(ctx: CanvasRenderingContext2D, bars: readonly FootprintBar[], msBar: number, tick: number, tickPx: number, _precision: number) {
    if (this.barSpacing < 64 || tickPx < 10) return;
    ctx.save();
    ctx.font = `600 ${Math.min(11, Math.floor(tickPx * 0.8))}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const b of bars) {
      if (!b.levels.size) continue;
      const cx = this.x(b.t + msBar / 2);
      const imb = imbalances(b);
      const buyImb = new Set(imb.filter((i) => i.side === 'BUY').map((i) => i.tick));
      const sellImb = new Set(imb.filter((i) => i.side === 'SELL').map((i) => i.tick));
      const poc = barPoc(b);
      for (const [k, lv] of b.levels) {
        const y = this.y(fromTick(k, tick));
        if (k === poc) {
          ctx.strokeStyle = 'rgba(245,165,36,0.8)';
          ctx.strokeRect(cx - this.barSpacing * 0.45, y - tickPx / 2, this.barSpacing * 0.9, tickPx);
        }
        ctx.textAlign = 'right';
        ctx.fillStyle = sellImb.has(k) ? '#ff7b8a' : 'rgba(239,75,95,0.85)';
        ctx.fillText(String(lv.sell), cx - 8, y);
        ctx.textAlign = 'left';
        ctx.fillStyle = buyImb.has(k) ? '#6dffb0' : 'rgba(38,208,124,0.85)';
        const buyText = String(lv.buy);
        ctx.fillText(buyText, cx + 8, y);
        if (lv.unknown) {
          // UNKNOWN-side volume (quote rule could not classify): grey, never added to either side
          ctx.fillStyle = 'rgba(160,168,184,0.85)';
          ctx.fillText(`?${lv.unknown}`, cx + 12 + ctx.measureText(buyText).width, y);
        }
      }
      for (const s of stackedImbalances(imb)) {
        const y0 = this.y(fromTick(s.toTick, tick)) - tickPx / 2;
        const y1 = this.y(fromTick(s.fromTick, tick)) + tickPx / 2;
        ctx.fillStyle = s.side === 'BUY' ? C.up : C.down;
        ctx.fillRect(s.side === 'BUY' ? cx + this.barSpacing * 0.45 : cx - this.barSpacing * 0.45 - 3, y0, 3, y1 - y0);
      }
    }
    ctx.restore();
  }

  private drawBook(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number, tickPx: number) {
    const { bids, asks } = f.view.book;
    const all = [...bids, ...asks];
    if (!all.length) return;
    const max = Math.max(...all.map((x) => x[1]));
    const width = 80;
    const hpx = Math.max(2, tickPx - 1);
    for (const [list, col] of [[bids, '38,208,124'], [asks, '239,75,95']] as const)
      for (const [p, s] of list) {
        const w = (s / max) * width;
        ctx.fillStyle = `rgba(${col},0.55)`;
        ctx.fillRect(plotW - w, this.y(p) - hpx / 2, w, hpx);
      }
  }

  private drawReversals(ctx: CanvasRenderingContext2D, f: ChartFrame, msBar: number) {
    const bars = new Map(f.view.bars.map((b) => [b.t, b]));
    ctx.save();
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const s of f.view.reversals) {
      const b = bars.get(s.t);
      if (!b) continue;
      const cx = this.x(s.t + msBar / 2);
      const bull = s.direction === 'BULLISH';
      const y = bull ? this.y(b.l) + 10 : this.y(b.h) - 10;
      const col = s.status === 'INVALIDATED' ? '#6d7686' : bull ? C.up : C.down;
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.beginPath();
      if (bull) {
        ctx.moveTo(cx, y);
        ctx.lineTo(cx - 6, y + 9);
        ctx.lineTo(cx + 6, y + 9);
      } else {
        ctx.moveTo(cx, y);
        ctx.lineTo(cx - 6, y - 9);
        ctx.lineTo(cx + 6, y - 9);
      }
      ctx.closePath();
      if (s.status === 'INVALIDATED') ctx.stroke();
      else ctx.fill();
      ctx.fillText(String(s.scoreAtSignal), cx, bull ? y + 21 : y - 13);
    }
    ctx.restore();
  }

  private drawDrawings(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number) {
    ctx.save();
    ctx.strokeStyle = '#d4a94f';
    ctx.lineWidth = 1.5;
    for (const d of f.drawings) {
      ctx.beginPath();
      if (d.kind === 'hline') {
        const y = this.y(d.price);
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
      } else {
        ctx.moveTo(this.x(d.t1), this.y(d.p1));
        ctx.lineTo(this.x(d.t2), this.y(d.p2));
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawAxes(ctx: CanvasRenderingContext2D, f: ChartFrame, tStart: number, tEnd: number, _plotW: number, plotH: number, pStep: number, msBar: number) {
    const ax = this.w - AXIS_W; // price axis (right of the liquidity lane)
    const { lo, hi } = this.lastScale;
    ctx.fillStyle = '#070a10';
    ctx.fillRect(ax, 0, AXIS_W, this.h);
    ctx.fillRect(0, plotH, this.w, TIME_H);
    ctx.strokeStyle = 'rgba(120,140,180,0.18)';
    ctx.beginPath();
    ctx.moveTo(ax + 0.5, 0);
    ctx.lineTo(ax + 0.5, plotH);
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(ax, plotH + 0.5);
    ctx.stroke();
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = C.axis;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let p = Math.ceil(lo / pStep) * pStep; p <= hi; p += pStep) ctx.fillText(p.toFixed(f.precision), ax + 8, this.y(p));
    // time axis (UTC)
    const tStep = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 43_200_000].find((s) => s * this.lastScale.pxPerMs >= 80) ?? 86_400_000;
    ctx.textAlign = 'center';
    for (let t = Math.ceil(tStart / tStep) * tStep; t <= tEnd; t += tStep) ctx.fillText(fmtUtc(t), this.x(t), plotH + TIME_H / 2);
    // POC / VAH / VAL axis tags, spread apart and kept clear of the last-price tag
    if (f.layers.levels) {
      const levels = this.levelList(f);
      const lastY = f.view.last !== null ? this.y(f.view.last) : null;
      const ys = spreadLabels(levels.map((l) => this.y(l.price)), 16, 8, plotH - 8).map((y) => (lastY !== null && Math.abs(y - lastY) < 22 ? (y < lastY ? lastY - 22 : lastY + 30) : y));
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      levels.forEach((l, i) => {
        const y = ys[i]!;
        if (y < 0 || y > plotH) return;
        ctx.fillStyle = l.name === 'POC' ? '#5a3a06' : '#13235a';
        ctx.fillRect(ax + 1, y - 7, AXIS_W - 2, 14);
        ctx.fillStyle = l.name === 'POC' ? '#ffd27a' : '#b3c8ff';
        ctx.fillText(`${l.name} ${l.price.toFixed(f.precision)}`, ax + 4, y);
      });
    }
    // last price tag + bar countdown
    const last = f.view.last;
    const lastBar = f.view.bars[f.view.bars.length - 1];
    if (last !== null && lastBar) {
      const y = this.y(last);
      const up = lastBar.c >= lastBar.o;
      ctx.strokeStyle = up ? C.up : C.down;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(ax, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = up ? '#14a35f' : '#c63447';
      ctx.fillRect(ax + 1, y - 10, AXIS_W - 2, 20);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.fillText(last.toFixed(f.precision), ax + 6, y);
      const left = Math.max(0, lastBar.t + msBar - f.now);
      if (!f.replay && left > 0 && left <= msBar) {
        const s = Math.ceil(left / 1000);
        ctx.fillStyle = '#0d1a2b';
        ctx.fillRect(ax + 1, y + 10, AXIS_W - 2, 16);
        ctx.fillStyle = '#9fc2ff';
        ctx.font = '600 10px Inter, system-ui, sans-serif';
        ctx.fillText(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, ax + 6, y + 18);
      }
    }
  }

  private drawCrosshair(ctx: CanvasRenderingContext2D, f: ChartFrame, plotW: number, plotH: number, msBar: number) {
    const m = this.mouse;
    if (!m || m.x > plotW || m.y > plotH) {
      return;
    }
    const price = this.pAt(m.y);
    const t = this.tAt(m.x);
    ctx.save();
    ctx.strokeStyle = 'rgba(200,210,230,0.45)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(m.y) + 0.5);
    ctx.lineTo(plotW, Math.round(m.y) + 0.5);
    ctx.moveTo(Math.round(m.x) + 0.5, 0);
    ctx.lineTo(Math.round(m.x) + 0.5, plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#273142';
    ctx.fillRect(this.w - AXIS_W + 1, m.y - 9, AXIS_W - 2, 18);
    ctx.fillRect(m.x - 34, plotH + 2, 68, TIME_H - 4);
    ctx.fillStyle = '#fff';
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(price.toFixed(f.precision), this.w - AXIS_W + 6, m.y);
    ctx.textAlign = 'center';
    ctx.fillText(fmtUtc(t), m.x, plotH + TIME_H / 2);
    ctx.restore();
    // hover info for the page's readout
    const tick = f.view.recorder.tick;
    const bt = Math.floor(t / msBar) * msBar;
    const bar = f.view.bars.find((b) => b.t === bt) ?? null;
    const k = toTick(price, tick);
    const lv = bar?.levels.get(k) ?? null;
    const shown = bookShown(f);
    const bid = shown ? f.view.book.bids.find(([p]) => toTick(p, tick) === k) : undefined;
    const ask = shown ? f.view.book.asks.find(([p]) => toTick(p, tick) === k) : undefined;
    const liq = f.depthCurrent === false ? null : (f.liq?.levels.find((l) => l.tick === k) ?? null);
    this.cb.onHover?.({ t, price: fromTick(k, tick), bar, level: lv, resting: bid ? { side: 'BID', size: bid[1] } : ask ? { side: 'ASK', size: ask[1] } : null, liq, heat: this.heatHover(f, t, k) });
  }
}
