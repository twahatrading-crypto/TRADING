import type * as LightweightCharts from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../../types/market';
import type { ChartOverlay } from '../../types/overlays';
import { COMPACT_LABEL_WIDTH, ZONE_LABEL_MARGIN_MAX_SHARE, ZONE_LABEL_MARGIN_PX, ZonesPrimitive, type ZoneDrawable } from './ZonesPrimitive';

type ChartLib = typeof LightweightCharts;

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

  constructor(lib: ChartLib, container: HTMLElement, priceDecimals: number) {
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
    // Bars without a provider-supplied volume are omitted, not drawn as zero.
    return c.volume === null
      ? { time: c.time as UTCTimestamp }
      : { time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? 'rgba(63,207,124,.35)' : 'rgba(239,93,93,.35)' };
  }

  setData(candles: readonly Candle[]): void {
    this.candles.setData(candles.map(ChartController.bar));
    this.volume.setData(candles.map(ChartController.vol));
  }

  /** Update or append the most recent bar. */
  upsert(candle: Candle): void {
    this.candles.update(ChartController.bar(candle));
    this.volume.update(ChartController.vol(candle));
  }

  /** Phase 1 renders level overlays only; zones/markers are defined but not drawn yet. */
  setOverlays(overlays: readonly ChartOverlay[]): void {
    this.priceLines.forEach((l) => this.candles.removePriceLine(l));
    this.priceLines = overlays
      .filter((o) => o.shape === 'level')
      .map((o) =>
        this.candles.createPriceLine({ price: o.price, color: COLORS.gold, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: o.label ?? '' }),
      );
  }

  /** Draw S&R zones (engine output prepared by the UI) as bands behind the candles. */
  setZones(zones: ZoneDrawable[]): void {
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

  /** PNG snapshot of the chart canvas. */
  screenshot(): HTMLCanvasElement {
    return this.chart.takeScreenshot();
  }

  destroy(): void {
    this.chart.remove();
  }
}
