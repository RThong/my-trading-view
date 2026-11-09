// 手画线(趋势线 / 水平线 / 竖线)的纯计算 + 格级图元。文档模型见 views/chartDoc/chartDoc 的 Drawing,交互见编辑器 useDrawings。
import type {
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { pointToSegmentDistance } from './trendlines';

const DAY_MS = 86_400_000;

function dayNum(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
}
function isoOf(day: number): string {
  return new Date(Math.round(day) * DAY_MS).toISOString().slice(0, 10);
}

/** 日期 ↔ lw-charts 逻辑下标(可带小数)。图上没有任何点时两边都是 null */
export type TimeAxis = { toLogical: (iso: string) => number | null; toTime: (logical: number) => string | null };

/** 升序数组里最后一个 ≤ d 的下标(调用方保证 days[0] ≤ d < days.at(-1)) */
function floorIndex(days: number[], d: number): number {
  let lo = 0;
  let hi = days.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (days[mid] <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * 按图上所有序列的时间点并集建轴(并集的下标 = lw-charts 的逻辑下标):两根之间按日历天数比例插值(周线上一周中间的日期
 * 落在两根之间),数据两端之外按相邻两根的中位间隔外推(最右边空白区也画得出;周末 / 节假日不另算,只是外推的近似)
 */
export function timeAxis(times: string[]): TimeAxis {
  const days = [...new Set(times)].sort().map(dayNum);
  const n = days.length;
  if (n === 0) return { toLogical: () => null, toTime: () => null };

  const gaps = days
    .slice(1)
    .map((d, i) => d - days[i])
    .sort((a, b) => a - b);
  const step = gaps.length ? gaps[gaps.length >> 1] : 1;
  const first = days[0];
  const last = days[n - 1];

  const toLogical = (iso: string) => {
    const d = dayNum(iso);
    if (d <= first) return (d - first) / step;
    if (d >= last) return n - 1 + (d - last) / step;
    const i = floorIndex(days, d);
    return i + (d - days[i]) / (days[i + 1] - days[i]);
  };
  const toTime = (logical: number) => {
    if (logical <= 0) return isoOf(first + logical * step);
    if (logical >= n - 1) return isoOf(last + (logical - (n - 1)) * step);
    const i = Math.floor(logical);
    return isoOf(days[i] + (logical - i) * (days[i + 1] - days[i]));
  };

  return { toLogical, toTime };
}

/** 一条画线换算到当前这一格的像素(media 坐标,绘图区左上角为原点) */
export type Shape =
  | { id: string; kind: 'trend'; x1: number; y1: number; x2: number; y2: number }
  | { id: string; kind: 'hline'; y: number }
  | { id: string; kind: 'vline'; x: number };

/** 命中:哪条、抓的是哪儿(趋势线两端 a / b,其余一律线身) */
export type Hit = { id: string; part: 'a' | 'b' | 'body'; dist: number };

// 离线多近算点中;端点手柄比线身优先(同一处既是端点又在线上时,拖端点)
const HIT_PX = 6;
const HANDLE_PX = 8;
const HANDLE_R = 4;

function hitOne(s: Shape, x: number, y: number): Hit | null {
  if (s.kind === 'hline')
    return Math.abs(y - s.y) <= HIT_PX ? { id: s.id, part: 'body', dist: Math.abs(y - s.y) } : null;
  if (s.kind === 'vline')
    return Math.abs(x - s.x) <= HIT_PX ? { id: s.id, part: 'body', dist: Math.abs(x - s.x) } : null;

  const da = Math.hypot(x - s.x1, y - s.y1);
  const db = Math.hypot(x - s.x2, y - s.y2);
  if (Math.min(da, db) <= HANDLE_PX) return { id: s.id, part: da <= db ? 'a' : 'b', dist: 0 };
  const d = pointToSegmentDistance(x, y, s.x1, s.y1, s.x2, s.y2);
  return d <= HIT_PX ? { id: s.id, part: 'body', dist: d } : null;
}

/** 鼠标下最近的那条;都不够近 → null */
export function hitShapes(shapes: Shape[], x: number, y: number): Hit | null {
  return (
    shapes
      .map((s) => hitOne(s, x, y))
      .filter((h) => h !== null)
      .sort((a, b) => a.dist - b.dist)[0] ?? null
  );
}

// 选中不换色(同 TradingView;以前换成的亮黄在暖白底上几乎看不见):靠加粗 + 手柄表示选中
const COLOR = '#eab308';

/** 这一格此刻要画的:各条画线的像素、选中的那条、绘图模式下的光标 */
export type PaneDrawingState = { shapes: Shape[]; selected: string | null; cursor?: string };

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly state: PaneDrawingState) {}

  draw(target: CanvasRenderingTarget2D): void {
    const { shapes, selected } = this.state;
    // biome-ignore lint/correctness/useHookAtTopLevel: useMediaCoordinateSpace 是 canvas 方法,不是 React hook
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      shapes.forEach((s) => {
        const on = s.id === selected;
        ctx.lineWidth = on ? 2 : 1.5;
        ctx.strokeStyle = COLOR;
        ctx.beginPath();
        if (s.kind === 'trend') {
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
        } else if (s.kind === 'hline') {
          ctx.moveTo(0, s.y);
          ctx.lineTo(mediaSize.width, s.y);
        } else {
          ctx.moveTo(s.x, 0);
          ctx.lineTo(s.x, mediaSize.height);
        }
        ctx.stroke();
        if (!on) return;

        // 选中出手柄:趋势线两端(可拖端点);水平 / 竖线在中点(拖它 = 拖线身,只为看得出选中了)
        const handles =
          s.kind === 'trend'
            ? [
                [s.x1, s.y1],
                [s.x2, s.y2],
              ]
            : s.kind === 'hline'
              ? [[mediaSize.width / 2, s.y]]
              : [[s.x, mediaSize.height / 2]];
        ctx.fillStyle = COLOR;
        handles.forEach(([hx, hy]) => {
          ctx.beginPath();
          ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
          ctx.fill();
        });
      });
    });
  }
}

/**
 * 挂在一个 lw 格上的图元。不自己存画线:每次重画都调 source 现算(平移 / 缩放 / 拖动草稿都即时跟上),
 * 状态变了由外面调 update() 请求重画
 */
export class DrawingsPrimitive implements IPanePrimitive<Time> {
  private requestUpdate?: () => void;
  // 同一个数组:lw-charts 按数组引用做缓存,集合没变就别换
  private readonly views: readonly IPanePrimitivePaneView[];

  constructor(private readonly source: () => PaneDrawingState) {
    this.views = [{ zOrder: () => 'top', renderer: () => new DrawingsRenderer(this.source()) }];
  }

  attached({ requestUpdate }: PaneAttachedParameter<Time>): void {
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  update(): void {
    this.requestUpdate?.();
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }

  // 只用来换光标(lw-charts 按它设格子的 cursor):绘图模式下整格十字,悬停在画线上是手 / 拖动
  hitTest(x: number, y: number) {
    const { shapes, cursor } = this.source();
    if (cursor) return { externalId: 'drawing-tool', zOrder: 'top' as const, cursorStyle: cursor };
    const hit = hitShapes(shapes, x, y);
    return hit
      ? {
          externalId: hit.id,
          zOrder: 'top' as const,
          cursorStyle: hit.part === 'body' ? 'move' : 'grab',
          distance: hit.dist,
        }
      : null;
  }
}
