// 手绘趋势线的纯核心:几何命中检测 + localStorage 序列化。图元渲染类见 Task 2(同文件)。
import type {
  Time,
  Logical,
  IChartApi,
  ISeriesApi,
  SeriesType,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

// 锚点用「逻辑坐标(logical index)」而非时间:logicalToCoordinate 在最右空白区也有效,
// 故线能画进无数据区、预览/端点始终跟手;时间坐标在空白区为 null,做不到。
export type Anchor = { logical: number; price: number };
export type TrendLine = { a: Anchor; b: Anchor };

// 点 (px,py) 到线段 (x1,y1)-(x2,y2) 的最短距离。垂足落在段外时取到最近端点的距离。
// 用于点击命中检测(≤阈值即选中该线)。
export function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  // 退化成一个点:直接返回到该点的距离,避免除零。
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

export function serializeLines(lines: TrendLine[]): string {
  return JSON.stringify(lines);
}

const isAnchor = (v: unknown): v is Anchor =>
  typeof v === 'object' && v !== null && Number.isFinite((v as Anchor).logical) && Number.isFinite((v as Anchor).price);

const isLine = (v: unknown): v is TrendLine =>
  typeof v === 'object' && v !== null && isAnchor((v as TrendLine).a) && isAnchor((v as TrendLine).b);

// 容错解析:null / 坏 JSON / 非数组一律得空数组,绝不抛(localStorage 内容不可信)。
// 逐元素校验形状——[null]、[{}] 等合法 JSON 也要滤掉,否则渲染取 ln.a 会崩。
export function parseLines(raw: string | null): TrendLine[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isLine) : [];
  } catch {
    return [];
  }
}

const COLOR = '#eab308';
const COLOR_SELECTED = '#fde047';

// 已投影到像素的线段;端点任一不在可视区(投影 null)则整条不画,置 null。
type Seg = { x1: number; y1: number; x2: number; y2: number } | null;

class TrendLinePaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly segs: Seg[],
    private readonly selected: number | null,
    private readonly preview: Seg, // 画线中随光标的橡皮筋段(虚线)
    private readonly handles: Array<{ x: number; y: number }>, // 选中线两端点手柄(可点击调整)
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    // media space:坐标即 CSS 像素,与 priceToCoordinate/timeToCoordinate 返回值同系,无需 pixelRatio 换算。
    // biome-ignore lint/correctness/useHookAtTopLevel: useMediaCoordinateSpace is a canvas method, not a React hook
    target.useMediaCoordinateSpace((scope: { context: CanvasRenderingContext2D }) => {
      const ctx = scope.context;
      this.segs.forEach((seg, i) => {
        if (!seg) return;
        ctx.lineWidth = i === this.selected ? 3 : 2;
        ctx.strokeStyle = i === this.selected ? COLOR_SELECTED : COLOR;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
      });
      // 预览段:虚线
      if (this.preview) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = COLOR;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(this.preview.x1, this.preview.y1);
        ctx.lineTo(this.preview.x2, this.preview.y2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 选中线的端点手柄:实心小圆(点击可抓起调整)
      for (const h of this.handles) {
        ctx.fillStyle = COLOR_SELECTED;
        ctx.beginPath();
        ctx.arc(h.x, h.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
}

class TrendLinePaneView implements IPrimitivePaneView {
  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<SeriesType>,
    private readonly lines: TrendLine[],
    private readonly selected: number | null,
    private readonly preview: TrendLine | null,
    private readonly handlesIndex: number | null, // 显示端点手柄的线(hover/选中)
  ) {}

  private px(anchor: Anchor): { x: number; y: number } | null {
    const x = this.chart.timeScale().logicalToCoordinate(anchor.logical as Logical);
    const y = this.series.priceToCoordinate(anchor.price);
    if (x == null || y == null) return null;
    return { x, y };
  }

  private project(ln: TrendLine): Seg {
    const a = this.px(ln.a);
    const b = this.px(ln.b);
    if (!a || !b) return null;
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  // 每次重画都实时投影锚点(logical,price)→ 像素,故平移/缩放线自动跟随。
  renderer(): IPrimitivePaneRenderer {
    const segs = this.lines.map((ln) => this.project(ln));
    const previewSeg = this.preview ? this.project(this.preview) : null;
    // hover/选中线的两端点手柄
    const handles: Array<{ x: number; y: number }> = [];
    const hi = this.handlesIndex;
    if (hi != null && this.lines[hi]) {
      for (const h of [this.px(this.lines[hi].a), this.px(this.lines[hi].b)]) if (h) handles.push(h);
    }
    return new TrendLinePaneRenderer(segs, this.selected, previewSeg, handles);
  }
}

// 挂到某 pane 主 series 的趋势线图元:持有该 pane 的线 + 选中索引;setLines 后请求重画。
export class TrendLinePrimitive implements ISeriesPrimitive<Time> {
  private lines: TrendLine[] = [];
  private selected: number | null = null;
  private preview: TrendLine | null = null;
  private handlesIndex: number | null = null;
  private requestUpdate?: () => void;

  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<SeriesType>,
  ) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setLines(lines: TrendLine[], selected: number | null): void {
    this.lines = lines;
    this.selected = selected;
    this.requestUpdate?.();
  }

  // 画线中:预览橡皮筋段;null 即清除。
  setPreview(preview: TrendLine | null): void {
    this.preview = preview;
    this.requestUpdate?.();
  }

  // 显示端点手柄的线(hover 或选中);null 不显示。
  setHandles(index: number | null): void {
    this.handlesIndex = index;
    this.requestUpdate?.();
  }

  paneViews(): IPrimitivePaneView[] {
    return [new TrendLinePaneView(this.chart, this.series, this.lines, this.selected, this.preview, this.handlesIndex)];
  }
}
