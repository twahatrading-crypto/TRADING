import type { IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, Logical, SeriesAttachedParameter, Time, UTCTimestamp } from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** A vertical time range shaded behind the candles (trading sessions, thin-history region). */
export interface TimeBand {
  id: string;
  /** [from, to) epoch s. */
  from: number;
  to: number;
  /** "r,g,b" */
  rgb: string;
  alpha: number;
  /** Small caption at the top of the band ('' = none). */
  label: string;
  /** Hatched (e.g. thin / excluded history). */
  hatched?: boolean;
}

class BandsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly src: TimeBandsPrimitive) {}
  draw(target: Target): void {
    const { chart, bands } = this.src;
    if (!chart || bands.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const x = (t: number) => {
        const idx = ts.timeToIndex(t as UTCTimestamp, true);
        return idx === null ? null : ts.logicalToCoordinate(idx as unknown as Logical);
      };
      const half = Math.max(1, ts.options().barSpacing / 2);
      let lastLabelEnd = -Infinity;
      for (const b of bands) {
        const x0 = x(b.from), x1 = x(b.to - 1);
        if (x0 === null || x1 === null) continue;
        const left = Math.max(0, x0 - half), right = Math.min(mediaSize.width, x1 + half);
        if (right <= 0 || left >= mediaSize.width || right - left < 1) continue;
        ctx.fillStyle = `rgba(${b.rgb},${b.alpha})`;
        ctx.fillRect(left, 0, right - left, mediaSize.height);
        if (b.hatched) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, 0, right - left, mediaSize.height);
          ctx.clip();
          ctx.strokeStyle = `rgba(${b.rgb},${Math.min(0.35, b.alpha * 3)})`;
          ctx.lineWidth = 1;
          for (let s = left - mediaSize.height; s < right; s += 14) {
            ctx.beginPath();
            ctx.moveTo(s, mediaSize.height);
            ctx.lineTo(s + mediaSize.height, 0);
            ctx.stroke();
          }
          ctx.restore();
        }
        if (b.label && right - left > 60) {
          ctx.font = '600 10px "Inter Variable", Inter, system-ui, sans-serif';
          const w = ctx.measureText(b.label).width;
          const cx = Math.max(left + 4, Math.min((left + right) / 2 - w / 2, right - w - 4));
          if (cx > lastLabelEnd + 8) {
            ctx.fillStyle = `rgba(${b.rgb},0.95)`;
            ctx.fillText(b.label, cx, 12);
            lastLabelEnd = cx + w;
          }
        }
      }
    });
  }
}

class BandsView implements IPrimitivePaneView {
  private readonly r: BandsRenderer;
  constructor(src: TimeBandsPrimitive) {
    this.r = new BandsRenderer(src);
  }
  zOrder() {
    return 'bottom' as const;
  }
  renderer() {
    return this.r;
  }
}

/** Series primitive: shaded vertical time bands behind the candles. */
export class TimeBandsPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  bands: TimeBand[] = [];
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new BandsView(this)];

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
  setBands(bands: TimeBand[]): void {
    this.bands = bands;
    this.requestUpdate?.();
  }
}
