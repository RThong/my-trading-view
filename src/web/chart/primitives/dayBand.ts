// 按日期整根 K 线宽度画背景色块的图元(周末、换月错配这类 0/1 标记的背景色带)。
// 面积图只能在相邻两根 K 线的**中心**之间填色,标记日画出来会多出半根(周末两根画成三根宽);
// 直方图柱子之间有缝,连续一段放大后碎成竖纹。所以自绘:每个标记日盖住「中心 ± 半根间距」,
// 相邻的标记日并成一块再画(分开画在接缝处半透明色会叠深一道)。挂在背景层的 series 上,画在最底层。
import type {
  Time,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  PrimitivePaneViewZOrder,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

type Span = { left: number; right: number };

/** 标记日的 x(K 线中心,升序)→ 合并后的色块:相邻两根间距 ≤ 1.5 根即视为连着 */
export function mergeSpans(xs: number[], barSpacing: number): Span[] {
  const half = barSpacing / 2;
  return xs.reduce<Span[]>((spans, x) => {
    const last = spans.at(-1);
    if (last && x - (last.right - half) <= barSpacing * 1.5) {
      last.right = x + half;
      return spans;
    }
    spans.push({ left: x - half, right: x + half });
    return spans;
  }, []);
}

// 细带只占格子底部这么高(比例):够看出颜色,又压不住上面的线
const STRIP_H = 0.06;

// 虚线模式(竖线图层的 dash):每个日期一根 1px 竖虚线,画在 K 线中心
const DASH = [4, 3];

class DayBandRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly spans: Span[],
    private readonly color: string,
    private readonly strip: boolean,
    private readonly dashXs?: number[],
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    // biome-ignore lint/correctness/useHookAtTopLevel: useMediaCoordinateSpace 是 canvas 方法,不是 React hook
    target.useMediaCoordinateSpace((scope: { context: CanvasRenderingContext2D; mediaSize: { height: number } }) => {
      const ctx = scope.context;
      const { height } = scope.mediaSize;
      if (this.dashXs) {
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 1;
        ctx.setLineDash(DASH);
        ctx.beginPath();
        this.dashXs.forEach((x) => {
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, height);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      const [top, h] = this.strip ? [height * (1 - STRIP_H), height * STRIP_H] : [0, height];
      ctx.fillStyle = this.color;
      this.spans.forEach((s) => {
        ctx.fillRect(s.left, top, s.right - s.left, h);
      });
    });
  }
}

export class DayBandPrimitive implements ISeriesPrimitive<Time> {
  private times: string[] = [];
  private color = 'transparent';
  private strip = false;
  private dash = false;
  private param?: SeriesAttachedParameter<Time>;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }

  detached(): void {
    this.param = undefined;
  }

  /** times = 要上色的日期(升序);strip = 只染格子底部一条细带;dash = 不画色块,每个日期画一根竖虚线 */
  setData(times: string[], color: string, strip = false, dash = false): void {
    this.times = times;
    this.color = color;
    this.strip = strip;
    this.dash = dash;
    this.param?.requestUpdate();
  }

  paneViews(): IPrimitivePaneView[] {
    const param = this.param;
    const times = this.times;
    const { color, strip, dash } = this;
    return [
      {
        zOrder: (): PrimitivePaneViewZOrder => 'bottom',
        // 每帧按当前缩放实时投影;背景层被隐藏时不画
        renderer: () => {
          if (!param?.series.options().visible) return null;
          const ts = param.chart.timeScale();
          const xs = times.flatMap((t) => {
            const x = ts.timeToCoordinate(t as Time);
            return x == null ? [] : [x];
          });
          if (dash) return new DayBandRenderer([], color, false, xs);
          return new DayBandRenderer(mergeSpans(xs, ts.options().barSpacing), color, strip);
        },
      },
    ];
  }
}
