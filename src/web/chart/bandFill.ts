// 两条线之间填色的图元(布林带通道底色)。lightweight-charts 没有原生「线间填充」,
// 用面积图叠背景色去遮又会盖住网格和蜡烛,故自绘:挂在上轨 series 上,画在最底层(zOrder 'bottom')。
import type {
  Time,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  PrimitivePaneViewZOrder,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export type BandPoint = { time: string; upper: number; lower: number };
type Px = { x: number; yU: number; yL: number };

class BandFillRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly pts: Px[],
    private readonly color: string,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    if (this.pts.length < 2) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: useMediaCoordinateSpace is a canvas method, not a React hook
    target.useMediaCoordinateSpace((scope: { context: CanvasRenderingContext2D }) => {
      const ctx = scope.context;
      // 上轨从左到右、下轨从右到左,围成一个闭合多边形。
      ctx.beginPath();
      ctx.moveTo(this.pts[0].x, this.pts[0].yU);
      for (const p of this.pts.slice(1)) ctx.lineTo(p.x, p.yU);
      for (const p of [...this.pts].reverse()) ctx.lineTo(p.x, p.yL);
      ctx.closePath();
      ctx.fillStyle = this.color;
      ctx.fill();
    });
  }
}

export class BandFillPrimitive implements ISeriesPrimitive<Time> {
  private points: BandPoint[] = [];
  private color = 'transparent';
  private param?: SeriesAttachedParameter<Time>;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }

  detached(): void {
    this.param = undefined;
  }

  setData(points: BandPoint[], color: string): void {
    this.points = points;
    this.color = color;
    this.param?.requestUpdate();
  }

  paneViews(): IPrimitivePaneView[] {
    const param = this.param;
    const points = this.points;
    const color = this.color;
    return [
      {
        zOrder: (): PrimitivePaneViewZOrder => 'bottom',
        // 每帧按当前缩放实时投影;series 被折叠隐藏时不画(否则收起的薄条里还留一块底色)。
        renderer: () => {
          if (!param?.series.options().visible) return null;
          const ts = param.chart.timeScale();
          const px = points.flatMap((p): Px[] => {
            const x = ts.timeToCoordinate(p.time as Time);
            const yU = param.series.priceToCoordinate(p.upper);
            const yL = param.series.priceToCoordinate(p.lower);
            return x == null || yU == null || yL == null ? [] : [{ x, yU, yL }];
          });
          return new BandFillRenderer(px, color);
        },
      },
    ];
  }
}
