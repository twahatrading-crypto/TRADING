import type {
  AutoscaleInfo,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import { layoutLabels } from './labelLayout';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** What the chart needs to draw a zone. Built from engine snapshots by the UI. */
export interface ZoneDrawable {
  id: string;
  role: 'support' | 'resistance';
  low: number;
  high: number;
  /** Zone creation time (epoch s); the box starts at the nearest chart bar. */
  from: number;
  /** 0–1 visual weight (timeframe significance). */
  emphasis: number;
  /** e.g. "H4 SUPPORT | 82" */
  label: string;
  /** e.g. "2 touches | FRESH" */
  sublabel: string;
  selected: boolean;
  /** Highlighted as part of a selected confluence. */
  highlighted: boolean;
  dimmed: boolean;
}

const COLORS = {
  support: { fill: '63,207,124', text: '#7ee2a8' },
  resistance: { fill: '239,93,93', text: '#f59a9a' },
};

const LABEL_H = 30;
const LABEL_H_COMPACT = 18;
const LABEL_PAD = 8;
/** Charts narrower than this use single-line compact labels. */
export const COMPACT_LABEL_WIDTH = 560;

/** "H4 SUPPORT | 82" → "H4 SUP | 82" for narrow charts. */
const compactLabel = (l: string) => l.replace('SUPPORT', 'SUP').replace('RESISTANCE', 'RES');

class ZonesRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly src: ZonesPrimitive,
    private readonly layer: 'boxes' | 'labels',
  ) {}

  draw(target: Target): void {
    const { chart, series, zones } = this.src;
    if (!chart || !series || zones.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const boxes = zones
        .map((z) => {
          const yTop = series.priceToCoordinate(z.high);
          const yBot = series.priceToCoordinate(z.low);
          if (yTop === null || yBot === null) return null;
          const idx = ts.timeToIndex(z.from as UTCTimestamp, true);
          const xRaw = idx === null ? 0 : ts.logicalToCoordinate(idx as unknown as Logical);
          const x = Math.max(0, xRaw ?? 0);
          return { z, x, top: Math.min(yTop, yBot), h: Math.max(2, Math.abs(yBot - yTop)) };
        })
        .filter((b): b is NonNullable<typeof b> => !!b && b.top < mediaSize.height && b.top + b.h > 0);

      if (this.layer === 'boxes') {
      // Boxes: low-emphasis first so higher timeframes sit on top.
      for (const b of [...boxes].sort((a, c) => a.z.emphasis - c.z.emphasis)) {
        const c = COLORS[b.z.role].fill;
        const strong = b.z.selected || b.z.highlighted;
        const alpha = b.z.dimmed ? 0.05 : strong ? 0.26 : 0.07 + 0.11 * b.z.emphasis;
        ctx.fillStyle = `rgba(${c},${alpha})`;
        ctx.fillRect(b.x, b.top, mediaSize.width - b.x, b.h);
        ctx.strokeStyle = `rgba(${c},${b.z.dimmed ? 0.15 : strong ? 0.95 : 0.3 + 0.35 * b.z.emphasis})`;
        ctx.lineWidth = strong ? 1.5 : 1;
        ctx.setLineDash(b.z.selected ? [5, 3] : []);
        ctx.strokeRect(b.x + 0.5, b.top + 0.5, mediaSize.width - b.x - 1, b.h - 1);
        ctx.setLineDash([]);
      }
      return;
      }

      // Labels at the right edge (inside the reserved right margin), collision-free.
      const compact = mediaSize.width < COMPACT_LABEL_WIDTH;
      const labelH = compact ? LABEL_H_COMPACT : LABEL_H;
      const text = (z: ZoneDrawable) => (compact ? compactLabel(z.label) : z.label);
      ctx.font = '700 11px "Inter Variable", Inter, system-ui, sans-serif';
      const widths = new Map(
        boxes.map((b) => [b.z.id, (compact ? ctx.measureText(text(b.z)).width : Math.max(ctx.measureText(b.z.label).width, ctx.measureText(b.z.sublabel).width * 0.9)) + 2 * LABEL_PAD]),
      );
      const placed = layoutLabels(
        boxes.map((b) => ({
          id: b.z.id,
          y: b.top + b.h / 2,
          height: labelH,
          priority: b.z.selected ? 0 : b.z.highlighted ? 1 : 2 + (1 - b.z.emphasis),
        })),
        mediaSize.height,
      );
      for (const p of placed) {
        const b = boxes.find((x) => x.z.id === p.id)!;
        const w = widths.get(p.id)!;
        const x = mediaSize.width - w - 10;
        const col = COLORS[b.z.role];
        ctx.fillStyle = 'rgba(10,14,20,0.9)';
        ctx.strokeStyle = `rgba(${col.fill},${b.z.selected || b.z.highlighted ? 0.95 : 0.55})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x + 0.5, p.top + 0.5, w, labelH, 4);
        ctx.fill();
        ctx.stroke();
        // Leader line when the label had to move away from its zone.
        const cy = b.top + b.h / 2;
        if (cy < p.top || cy > p.top + labelH) {
          ctx.beginPath();
          ctx.moveTo(x, p.top + labelH / 2);
          ctx.lineTo(x - 8, cy);
          ctx.stroke();
        }
        ctx.fillStyle = col.text;
        ctx.font = '700 11px "Inter Variable", Inter, system-ui, sans-serif';
        ctx.fillText(text(b.z), x + LABEL_PAD, p.top + 13);
        if (!compact) {
          ctx.fillStyle = '#9aa3b2';
          ctx.font = '500 10px "Inter Variable", Inter, system-ui, sans-serif';
          ctx.fillText(b.z.sublabel, x + LABEL_PAD, p.top + 25);
        }
      }
    });
  }
}

class ZonesPaneView implements IPrimitivePaneView {
  private readonly r: ZonesRenderer;
  constructor(
    src: ZonesPrimitive,
    private readonly layer: 'boxes' | 'labels',
  ) {
    this.r = new ZonesRenderer(src, layer);
  }
  /** Boxes behind the candles; labels above everything so candles never hide them. */
  zOrder() {
    return this.layer === 'boxes' ? ('bottom' as const) : ('top' as const);
  }
  renderer() {
    return this.r;
  }
}

/** Horizontal space (px) reserved at the right of the chart for zone labels (max share of width below). */
export const ZONE_LABEL_MARGIN_PX = 170;
export const ZONE_LABEL_MARGIN_MAX_SHARE = 0.35;

/** Series primitive that draws S&R zones as price bands behind the candles. */
export class ZonesPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  series: ISeriesApi<SeriesType, Time> | null = null;
  zones: ZoneDrawable[] = [];
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new ZonesPaneView(this, 'boxes'), new ZonesPaneView(this, 'labels')];

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Keep the selected / highlighted zones inside the visible price range (only those). */
  autoscaleInfo(): AutoscaleInfo | null {
    const focus = this.zones.filter((z) => z.selected || z.highlighted);
    if (focus.length === 0) return null;
    return {
      priceRange: { minValue: Math.min(...focus.map((z) => z.low)), maxValue: Math.max(...focus.map((z) => z.high)) },
    };
  }

  setZones(zones: ZoneDrawable[]): void {
    this.zones = zones;
    this.requestUpdate?.();
  }
}
