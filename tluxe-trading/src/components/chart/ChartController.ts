import type * as LightweightCharts from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, Time, UTCTimestamp } from 'lightweight-charts';
import type { LiquidityDrawable, LiquidityMarker } from '../liquidity/liquidityView';
import { LiquidityPrimitive } from './LiquidityPrimitive';
import type { OBDrawable } from '../orderBlocks/obView';
import { OrderBlockPrimitive } from './OrderBlockPrimitive';
import type { HLRDrawable, HLRMarker } from '../hlReversal/hlrView';
import { HLRPrimitive } from './HLRPrimitive';
import type { HLEDrawable, HLEMarker } from '../highLowEngine/hleView';
import { HighLowPrimitive } from './HighLowPrimitive';
import type { SmcDrawable, SmcMarker } from '../smc/smcView';
import { SmcPrimitive } from './SmcPrimitive';
import type { Candle } from '../../types/market';
import type { ChartOverlay } from '../../types/overlays';
import { COMPACT_LABEL_WIDTH, ZONE_LABEL_MARGIN_MAX_SHARE, ZONE_LABEL_MARGIN_PX, ZonesPrimitive, type ZoneDrawable } from './ZonesPrimitive';

type ChartLib = typeof LightweightCharts;

/** Default candle spacing (px) — the "Reset chart view" zoom level (lightweight-charts' own default). */
export const DEFAULT_BAR_SPACING = 6;
/** One Zoom In / Zoom Out step (× / ÷ bar spacing). */
export const ZOOM_STEP = 1.25;
export const MIN_BAR_SPACING = 0.5;
export const MAX_BAR_SPACING = 60;

/**
 * Native interaction options, identical on every chart: wheel / pinch zoom, drag to pan,
 * drag either axis to scale, double-click an axis to reset that axis. Presentation only.
 */
export const CHART_INTERACTION = {
  handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
  kineticScroll: { mouse: false, touch: true },
} as const;

const COLORS = {
  up: '#3fcf7c',
  down: '#ef5d5d',
  grid: 'rgba(255,255,255,0.045)',
  text: '#8a93a3',
  border: '#1b2330',
  gold: '#d4a94f',
};

/**
 * Imperative chart owner, deliberately outside React: live ticks call
 * `upsert()` which touches only the last bar, never re-rendering components.
 * Overlays (Phase 2+) are handed in as finished data via `setOverlays()`.
 */
export class ChartController {
  private chart: IChartApi;
  private candles: ISeriesApi<'Candlestick'>;
  private volume: ISeriesApi<'Histogram'>;
  private priceLines: IPriceLine[] = [];
  private zonesPrimitive: ZonesPrimitive | null = null;
  private liquidityPrimitive: LiquidityPrimitive | null = null;
  private orderBlockPrimitive: OrderBlockPrimitive | null = null;
  private hlrPrimitive: HLRPrimitive | null = null;
  private hlePrimitive: HighLowPrimitive | null = null;
  private smcPrimitive: SmcPrimitive | null = null;
  private newsLines: IPriceLine[] = [];
  private markers: ISeriesMarkersPluginApi<Time> | null = null;
  private readonly lib: ChartLib;
  /** After destroy() every call is a no-op (React cleanups may run after the chart is gone). */
  private disposed = false;

  constructor(lib: ChartLib, container: HTMLElement, priceDecimals: number) {
    this.lib = lib;
    this.chart = lib.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: lib.ColorType.Solid, color: 'transparent' },
        textColor: COLORS.text,
        fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: lib.CrosshairMode.Normal },
      // Explicit locale: some environments report tags like "en-US@posix" that Intl rejects.
      localization: { locale: 'en-US' },
      ...CHART_INTERACTION,
    });
    const minMove = 1 / 10 ** priceDecimals;
    this.candles = this.chart.addSeries(lib.CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
      priceFormat: { type: 'price', precision: priceDecimals, minMove },
    });
    this.volume = this.chart.addSeries(lib.HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
  }

  private static bar(c: Candle) {
    return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
  }

  private static vol(c: Candle) {
    // Real volume when supplied, else the source's tick volume (labelled as such in the UI).
    // Bars with neither are omitted, never drawn as zero.
    const v = c.volume ?? c.tickVolume ?? null;
    return v === null
      ? { time: c.time as UTCTimestamp }
      : { time: c.time as UTCTimestamp, value: v, color: c.close >= c.open ? 'rgba(63,207,124,.35)' : 'rgba(239,93,93,.35)' };
  }

  setData(candles: readonly Candle[]): void {
    if (this.disposed) return;
    this.candles.setData(candles.map(ChartController.bar));
    this.volume.setData(candles.map(ChartController.vol));
  }

  /** Update or append the most recent bar. */
  upsert(candle: Candle): void {
    if (this.disposed) return;
    this.candles.update(ChartController.bar(candle));
    this.volume.update(ChartController.vol(candle));
  }

  /** Phase 1 renders level overlays only; zones/markers are defined but not drawn yet. */
  setOverlays(overlays: readonly ChartOverlay[]): void {
    if (this.disposed) return;
    this.priceLines.forEach((l) => this.candles.removePriceLine(l));
    this.priceLines = overlays
      .filter((o) => o.shape === 'level')
      .map((o) =>
        this.candles.createPriceLine({ price: o.price, color: COLORS.gold, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: o.label ?? '' }),
      );
  }

  /** Draw S&R zones (engine output prepared by the UI) as bands behind the candles. */
  setZones(zones: ZoneDrawable[]): void {
    if (this.disposed) return;
    if (!this.zonesPrimitive) {
      this.zonesPrimitive = new ZonesPrimitive();
      this.candles.attachPrimitive(this.zonesPrimitive);
    }
    this.zonesPrimitive.setZones(zones);
    // Reserve empty bars on the right so labels never sit on top of recent candles.
    const ts = this.chart.timeScale();
    const width = ts.width();
    const margin = Math.min(width < COMPACT_LABEL_WIDTH ? 110 : ZONE_LABEL_MARGIN_PX, width * ZONE_LABEL_MARGIN_MAX_SHARE);
    ts.applyOptions({ rightOffset: zones.length ? Math.ceil(margin / ts.options().barSpacing) : 0 });
  }

  /** Click on the chart → open time of the clicked bar (null outside the bars). Returns an unsubscribe. */
  onBarClick(cb: (time: number | null) => void): () => void {
    const handler = (p: { time?: unknown }) => cb(typeof p.time === 'number' ? p.time : null);
    if (this.disposed) return () => {};
    this.chart.subscribeClick(handler);
    return () => {
      if (!this.disposed) this.chart.unsubscribeClick(handler);
    };
  }

  /** Draw Liquidity pools (Liquidity page). Independent of the S&R zone layer. */
  setLiquidity(items: LiquidityDrawable[]): void {
    if (this.disposed) return;
    if (!this.liquidityPrimitive) {
      this.liquidityPrimitive = new LiquidityPrimitive();
      this.candles.attachPrimitive(this.liquidityPrimitive);
    }
    this.liquidityPrimitive.setItems(items);
    const ts = this.chart.timeScale();
    const width = ts.width();
    const margin = Math.min(width < COMPACT_LABEL_WIDTH ? 110 : ZONE_LABEL_MARGIN_PX, width * ZONE_LABEL_MARGIN_MAX_SHARE);
    ts.applyOptions({ rightOffset: items.length ? Math.ceil(margin / ts.options().barSpacing) : 0 });
  }

  /** Draw Order Block zones (Order Blocks page). Independent of the S&R and Liquidity layers. */
  setOrderBlocks(items: OBDrawable[]): void {
    if (this.disposed) return;
    if (!this.orderBlockPrimitive) {
      this.orderBlockPrimitive = new OrderBlockPrimitive();
      this.candles.attachPrimitive(this.orderBlockPrimitive);
    }
    this.orderBlockPrimitive.setItems(items);
    const ts = this.chart.timeScale();
    const width = ts.width();
    const margin = Math.min(width < COMPACT_LABEL_WIDTH ? 110 : ZONE_LABEL_MARGIN_PX, width * ZONE_LABEL_MARGIN_MAX_SHARE);
    ts.applyOptions({ rightOffset: items.length ? Math.ceil(margin / ts.options().barSpacing) : 0 });
  }

  /** High / Low Reversal overlays + event markers (High / Low Reversal page). */
  setHighLowReversal(items: HLRDrawable[], markers: readonly HLRMarker[]): void {
    if (this.disposed) return;
    if (!this.hlrPrimitive) {
      this.hlrPrimitive = new HLRPrimitive();
      this.candles.attachPrimitive(this.hlrPrimitive);
    }
    this.hlrPrimitive.setItems(items);
    const ts = this.chart.timeScale();
    const width = ts.width();
    const margin = Math.min(width < COMPACT_LABEL_WIDTH ? 110 : 170, width * ZONE_LABEL_MARGIN_MAX_SHARE);
    ts.applyOptions({ rightOffset: items.length ? Math.ceil(margin / ts.options().barSpacing) : 0 });
    const m = markers.map((x) => ({ ...x, time: x.time as UTCTimestamp, size: 0.9 }));
    if (!this.markers) this.markers = this.lib.createSeriesMarkers(this.candles, m);
    else this.markers.setMarkers(m);
  }

  /** High / Low Engine overlays + markers (High / Low Engine page; separate from High / Low Reversal). */
  setHighLowEngine(items: HLEDrawable[], markers: readonly HLEMarker[]): void {
    if (this.disposed) return;
    if (!this.hlePrimitive) {
      this.hlePrimitive = new HighLowPrimitive();
      this.candles.attachPrimitive(this.hlePrimitive);
    }
    this.hlePrimitive.setItems(items);
    const ts = this.chart.timeScale();
    const width = ts.width();
    const margin = Math.min(width < COMPACT_LABEL_WIDTH ? 110 : 190, width * ZONE_LABEL_MARGIN_MAX_SHARE);
    ts.applyOptions({ rightOffset: items.length ? Math.ceil(margin / ts.options().barSpacing) : 0 });
    const m = markers.map((x) => ({ ...x, time: x.time as UTCTimestamp, size: 0.9 }));
    if (!this.markers) this.markers = this.lib.createSeriesMarkers(this.candles, m);
    else this.markers.setMarkers(m);
  }

  /** SMC Engine overlays + markers (SMC page only; engine output, nothing decorative). */
  setSmc(items: SmcDrawable[], markers: readonly SmcMarker[]): void {
    if (this.disposed) return;
    if (!this.smcPrimitive) {
      this.smcPrimitive = new SmcPrimitive();
      this.candles.attachPrimitive(this.smcPrimitive);
    }
    this.smcPrimitive.setItems(items);
    const ts = this.chart.timeScale();
    const width = ts.width();
    const margin = Math.min(width < COMPACT_LABEL_WIDTH ? 110 : 170, width * ZONE_LABEL_MARGIN_MAX_SHARE);
    ts.applyOptions({ rightOffset: items.length ? Math.ceil(margin / ts.options().barSpacing) : 0 });
    const m = markers.map((x) => ({ ...x, time: x.time as UTCTimestamp, size: 0.8 }));
    if (!this.markers) this.markers = this.lib.createSeriesMarkers(this.candles, m);
    else this.markers.setMarkers(m);
  }

  /** News Analysis reaction chart: release / horizon markers and reference price lines (real data only). */
  setNewsReaction(markers: readonly { time: number; position: 'aboveBar' | 'belowBar'; shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'; color: string; text: string }[], lines: readonly { price: number; title: string; color: string }[]): void {
    if (this.disposed) return;
    this.newsLines.forEach((l) => this.candles.removePriceLine(l));
    this.newsLines = lines.map((l) => this.candles.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title }));
    const m = [...markers].sort((a, b) => a.time - b.time).map((x) => ({ ...x, time: x.time as UTCTimestamp, size: 0.9 }));
    if (!this.markers) this.markers = this.lib.createSeriesMarkers(this.candles, m);
    else this.markers.setMarkers(m);
  }

  /** Small event markers (real engine events only), e.g. "BSL SWEPT" / "RECLAIM". */
  setEventMarkers(markers: readonly LiquidityMarker[]): void {
    if (this.disposed) return;
    const items = markers.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.side === 'BSL' ? ('aboveBar' as const) : ('belowBar' as const),
      shape: m.kind === 'reclaim' ? ('circle' as const) : m.side === 'BSL' ? ('arrowDown' as const) : ('arrowUp' as const),
      color: m.kind === 'reclaim' ? COLORS.gold : m.side === 'BSL' ? '#e8925f' : '#3cc9b0',
      text: m.text,
      size: 0.8,
    }));
    if (!this.markers) this.markers = this.lib.createSeriesMarkers(this.candles, items);
    else this.markers.setMarkers(items);
  }

  /* -------------------- view navigation (presentation only) -------------------- */
  // These change ONLY the visible time range / price scale through the library's own APIs.
  // Candle data, overlays, markers and every engine result are untouched; primitives redraw
  // from the chart's coordinate mapping, so overlays stay aligned with the candles.

  /** Zoom in one step (wider candles), keeping the right edge anchored. */
  zoomIn(): void {
    if (this.disposed) return;
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: Math.min(MAX_BAR_SPACING, ts.options().barSpacing * ZOOM_STEP) });
  }

  /** Zoom out one step (narrower candles). */
  zoomOut(): void {
    if (this.disposed) return;
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: Math.max(MIN_BAR_SPACING, ts.options().barSpacing / ZOOM_STEP) });
  }

  /** Price axis back to automatic scaling (undoes a manual price-axis drag). */
  autoScalePrice(): void {
    if (this.disposed) return;
    this.candles.priceScale().applyOptions({ autoScale: true });
  }

  /** Reset chart view: default zoom, latest bars in view (keeps the overlay label margin), price autoscale. */
  resetView(): void {
    if (this.disposed) return;
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: DEFAULT_BAR_SPACING });
    // Immediate (not animated) jump to the latest bar plus the overlay layer's reserved right margin.
    ts.scrollToPosition(ts.options().rightOffset, false);
    this.autoScalePrice();
  }

  /** Fit / Auto Scale: every loaded bar in view and price autoscale. */
  fitView(): void {
    if (this.disposed) return;
    this.chart.timeScale().fitContent();
    this.autoScalePrice();
  }

  /** PNG snapshot of the chart canvas. */
  screenshot(): HTMLCanvasElement {
    return this.chart.takeScreenshot();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.chart.remove();
  }
}
