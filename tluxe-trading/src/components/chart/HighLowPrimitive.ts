import type {
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
import type { HLEDrawable } from '../highLowEngine/hleView';
import { layoutLabels } from './labelLayout';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** BUY green · SELL red · M5 structure purple · entry zone blue · followed H1 level gold. */
const TONE: Record<HLEDrawable['tone'], { rgb: string; text: string }> = {
  buy: { rgb: '60,201,160', text: '#86e3c6' },
  sell: { rgb: '239,93,93', text: '#f3a0a0' },
  structure: { rgb: '167,139,250', text: '#cdbdfd' },
  zone: { rgb: '91,140,255', text: '#a9c1ff' },
  gold: { rgb: '212,169,79', text: '#efcd84' },
  muted: { rgb: '138,147,163', text: '#9aa3b2' },
};
const LABEL_H = 18;
const PAD = 7;

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly src: HighLowPrimitive,
    private readonly layer: 'shapes' | 'labels',
  ) {}

  draw(target: Target): void {
    const { chart, series, items } = this.src;
    if (!chart || !series || items.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const xOf = (t: number | null, fallback: number) => {
        if (t === null) return fallback;
        const idx = ts.timeToIndex(t as UTCTimestamp, true);
        const x = idx === null ? null : ts.logicalToCoordinate(idx as unknown as Logical);
        return x ?? fallback;
      };
      const rows = items
        .map((d) => {
          const yTop = series.priceToCoordinate(d.high);
          const yBot = series.priceToCoordinate(d.low);
          if (yTop === null || yBot === null) return null;
          const x0 = Math.max(0, xOf(d.from, 0));
          const x1 = Math.min(mediaSize.width, d.to === null ? mediaSize.width : xOf(d.to, mediaSize.width));
          const top = Math.min(yTop, yBot);
          return { d, x0, x1, top, h: Math.abs(yBot - yTop), y: (yTop + yBot) / 2 };
        })
        .filter((r): r is NonNullable<typeof r> => !!r && r.top < mediaSize.height && r.top + r.h > 0);

      if (this.layer === 'shapes') {
        for (const r of rows) {
          const c = TONE[r.d.tone];
          if (r.d.kind === 'zone') {
            ctx.fillStyle = `rgba(${c.rgb},0.16)`;
            ctx.fillRect(r.x0, r.top, Math.max(1, r.x1 - r.x0), Math.max(2, r.h));
            ctx.strokeStyle = `rgba(${c.rgb},0.8)`;
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(r.x0) + 0.5, Math.round(r.top) + 0.5, Math.max(1, Math.round(r.x1 - r.x0) - 1), Math.max(2, Math.round(r.h)));
            continue;
          }
          ctx.strokeStyle = `rgba(${c.rgb},${r.d.emphasis ? 0.95 : 0.6})`;
          ctx.lineWidth = r.d.emphasis ? 1.6 : 1;
          ctx.setLineDash(r.d.dashed ? [6, 4] : []);
          ctx.beginPath();
          ctx.moveTo(r.x0, Math.round(r.y) + 0.5);
          ctx.lineTo(Math.max(r.x0 + 1, r.x1), Math.round(r.y) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        return;
      }

      ctx.font = '700 11px "Inter Variable", Inter, system-ui, sans-serif';
      const width = new Map(rows.map((r) => [r.d.id, ctx.measureText(r.d.label).width + 2 * PAD]));
      const placed = layoutLabels(
        rows.map((r) => ({ id: r.d.id, y: r.y, height: LABEL_H, priority: r.d.emphasis ? 0 : 2 })),
        mediaSize.height,
      );
      for (const p of placed) {
        const r = rows.find((x) => x.d.id === p.id)!;
        const w = width.get(p.id)!;
        // Structure labels sit at the end of their segment; everything else at the right edge.
        const x = r.d.kind === 'structure' ? Math.min(mediaSize.width - w - 10, r.x1 + 6) : mediaSize.width - w - 10;
        const c = TONE[r.d.tone];
        ctx.fillStyle = 'rgba(10,14,20,0.92)';
        ctx.strokeStyle = `rgba(${c.rgb},${r.d.emphasis ? 0.95 : 0.55})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x + 0.5, p.top + 0.5, w, LABEL_H, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = c.text;
        ctx.fillText(r.d.label, x + PAD, p.top + 13);
      }
    });
  }
}

class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(
    src: HighLowPrimitive,
    private readonly layer: 'shapes' | 'labels',
  ) {
    this.r = new Renderer(src, layer);
  }
  zOrder() {
    return this.layer === 'shapes' ? ('bottom' as const) : ('top' as const);
  }
  renderer() {
    return this.r;
  }
}

/** Series primitive for High / Low Engine overlays (engine output prepared by the UI). */
export class HighLowPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  series: ISeriesApi<SeriesType, Time> | null = null;
  items: HLEDrawable[] = [];
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new View(this, 'shapes'), new View(this, 'labels')];

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
  setItems(items: HLEDrawable[]): void {
    this.items = items;
    this.requestUpdate?.();
  }
}
