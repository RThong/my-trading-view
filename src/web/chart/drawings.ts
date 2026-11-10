// 手画线(趋势线 / 水平线 / 竖线)的纯计算 + 格级图元。文档模型见 views/chartDoc/chartDoc 的 Drawing,交互见编辑器 useDrawings。
import type {
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { SIGNED_DOWN, SIGNED_UP } from './palette';
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

type TwoPoints = { id: string; x1: number; y1: number; x2: number; y2: number };

/** 一条画线换算到当前这一格的像素(media 坐标,绘图区左上角为原点) */
export type Shape =
  | (TwoPoints & { kind: 'trend' })
  | (TwoPoints & { kind: 'ray' })
  | { id: string; kind: 'hline'; y: number }
  | { id: string; kind: 'hray'; x: number; y: number }
  | (TwoPoints & { kind: 'channel'; x3: number; y3: number })
  | { id: string; kind: 'vline'; x: number };

/**
 * 平行通道的平行线相对底边的纵向偏移(像素):第三点 (x3,y3) 到底边在同一横坐标处的竖直距离。
 * 在屏幕上平行,所以对数 / 倒轴下也是两条平行直线。底边竖直(两点同一天)没有斜率 → 0
 */
export function channelOffset(s: { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }): number {
  return s.x2 === s.x1 ? 0 : s.y3 - lineYAt(s, s.x3);
}

/** 过 (x1,y1)(x2,y2) 的直线在横坐标 x 处的纵坐标;竖直线(两点同横坐标)返回 y1 */
export function lineYAt(s: { x1: number; y1: number; x2: number; y2: number }, x: number): number {
  return s.x2 === s.x1 ? s.y1 : s.y1 + ((s.y2 - s.y1) * (x - s.x1)) / (s.x2 - s.x1);
}

// 射线画到这么远:比任何屏幕都大,超出画布的部分 canvas 自己裁掉,不用算和边框的交点
const RAY_FAR = 100_000;

/** 射线的远端:从 (x1,y1) 出发、沿穿过 (x2,y2) 的方向延伸;两点重合没有方向 → 就停在 (x2,y2) */
export function rayEnd(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return { x: x2, y: y2 };

  // 再加上起点离原点的距离:起点在画布外很远时(早年画的射线放大后滚到最新),远端仍保证越过画布
  const far = RAY_FAR + Math.hypot(x1, y1);
  return { x: x1 + ((x2 - x1) / len) * far, y: y1 + ((y2 - y1) / len) * far };
}

/** 命中:哪条、抓的是哪儿(两点线的两端 a / b,水平射线的起点 a,通道平行线上的宽度手柄 c,其余一律线身) */
export type Hit = { id: string; part: 'a' | 'b' | 'c' | 'body'; dist: number };

// 离线多近算点中;端点手柄比线身优先(同一处既是端点又在线上时,拖端点)
const HIT_PX = 6;
const HANDLE_PX = 8;
const HANDLE_R = 4;

function hitOne(s: Shape, x: number, y: number): Hit | null {
  if (s.kind === 'hline')
    return Math.abs(y - s.y) <= HIT_PX ? { id: s.id, part: 'body', dist: Math.abs(y - s.y) } : null;
  if (s.kind === 'vline')
    return Math.abs(x - s.x) <= HIT_PX ? { id: s.id, part: 'body', dist: Math.abs(x - s.x) } : null;
  if (s.kind === 'hray') {
    if (Math.hypot(x - s.x, y - s.y) <= HANDLE_PX) return { id: s.id, part: 'a', dist: 0 };
    const d = Math.abs(y - s.y);
    return d <= HIT_PX && x >= s.x ? { id: s.id, part: 'body', dist: d } : null;
  }

  const da = Math.hypot(x - s.x1, y - s.y1);
  const db = Math.hypot(x - s.x2, y - s.y2);
  if (Math.min(da, db) <= HANDLE_PX) return { id: s.id, part: da <= db ? 'a' : 'b', dist: 0 };
  if (s.kind === 'channel') return hitChannel(s, x, y);
  const end = s.kind === 'ray' ? rayEnd(s.x1, s.y1, s.x2, s.y2) : { x: s.x2, y: s.y2 };
  const d = pointToSegmentDistance(x, y, s.x1, s.y1, end.x, end.y);
  return d <= HIT_PX ? { id: s.id, part: 'body', dist: d } : null;
}

/** 通道:宽度手柄(平行线中点)> 两条边附近 > 通道里面(点中填色也算选中,同 TradingView;排在贴边命中之后) */
function hitChannel(s: ShapeOf<'channel'>, x: number, y: number): Hit | null {
  const off = channelOffset(s);
  const [mx, my] = [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2 + off];
  if (Math.hypot(x - mx, y - my) <= HANDLE_PX) return { id: s.id, part: 'c', dist: 0 };

  const d = Math.min(
    pointToSegmentDistance(x, y, s.x1, s.y1, s.x2, s.y2),
    pointToSegmentDistance(x, y, s.x1, s.y1 + off, s.x2, s.y2 + off),
  );
  if (d <= HIT_PX) return { id: s.id, part: 'body', dist: d };

  const inX = x >= Math.min(s.x1, s.x2) && x <= Math.max(s.x1, s.x2);
  const base = lineYAt(s, x);
  const inY = y >= Math.min(base, base + off) && y <= Math.max(base, base + off);
  return inX && inY ? { id: s.id, part: 'body', dist: HIT_PX } : null;
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

type ShapeOf<K extends Shape['kind']> = Extract<Shape, { kind: K }>;
type Pt = [number, number];
type Size = { width: number; height: number };

/** 一种画线在这一格里怎么画:几段实线 + 可选的虚线(通道中线)/ 填色区域 + 选中时手柄的位置 */
type Geom = { lines: [Pt, Pt][]; dashed?: [Pt, Pt][]; fill?: Pt[]; handles: Pt[] };

function twoPointGeom(s: TwoPoints, to: Pt): Geom {
  return {
    lines: [[[s.x1, s.y1], to]],
    handles: [
      [s.x1, s.y1],
      [s.x2, s.y2],
    ],
  };
}

function channelGeom(s: ShapeOf<'channel'>): Geom {
  const off = channelOffset(s);
  const [a, b]: Pt[] = [
    [s.x1, s.y1],
    [s.x2, s.y2],
  ];
  const [a2, b2]: Pt[] = [
    [s.x1, s.y1 + off],
    [s.x2, s.y2 + off],
  ];

  return {
    lines: [
      [a, b],
      [a2, b2],
    ],
    dashed: [
      [
        [s.x1, s.y1 + off / 2],
        [s.x2, s.y2 + off / 2],
      ],
    ],
    fill: [a, b, b2, a2],
    handles: [a, b, [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2 + off]],
  };
}

// 两点线两端、水平射线起点、通道平行线中点(拖它改宽度)的手柄可拖;水平 / 竖线的手柄在中点,拖它 = 拖线身,只为看得出选中了
const GEOM: { [K in Shape['kind']]: (s: ShapeOf<K>, size: Size) => Geom } = {
  trend: (s) => twoPointGeom(s, [s.x2, s.y2]),
  ray: (s) => {
    const end = rayEnd(s.x1, s.y1, s.x2, s.y2);
    return twoPointGeom(s, [end.x, end.y]);
  },
  channel: channelGeom,
  hray: (s, size) => ({
    lines: [
      [
        [s.x, s.y],
        [size.width, s.y],
      ],
    ],
    handles: [[s.x, s.y]],
  }),
  hline: (s, size) => ({
    lines: [
      [
        [0, s.y],
        [size.width, s.y],
      ],
    ],
    handles: [[size.width / 2, s.y]],
  }),
  vline: (s, size) => ({
    lines: [
      [
        [s.x, 0],
        [s.x, size.height],
      ],
    ],
    handles: [[s.x, size.height / 2]],
  }),
};

/** 这一格此刻要画的:各条画线的像素、选中的那条、绘图模式下的光标 */
export type PaneDrawingState = {
  shapes: Shape[];
  selected: string | null;
  cursor?: string;
  /** 绘图工具下「点下去落在哪」的预览(已过磁吸等插件):光标跟着吸附点跳,看得出吸没吸上 */
  preview?: { x: number; y: number };
  /** 测量尺(临时,不存进文档):起点 → 终点的像素 + 框下两行字;涨绿跌红 */
  measure?: { x1: number; y1: number; x2: number; y2: number; up: boolean; label: [string, string] };
};

const PREVIEW_R = 4;
// 通道填色的不透明度:淡到不挡住里面的 K 线
const FILL_ALPHA = 0.08;
const MEASURE_ALPHA = 0.15;
const LABEL_FONT = '12px system-ui, -apple-system, sans-serif';
const LABEL_PAD = 6;
const LABEL_LINE = 16;

/** 测量框:淡色区域 + 横竖两条中线(看得出量的是哪两点)+ 框下(跌时框上)的实底标签 */
function drawMeasure(ctx: CanvasRenderingContext2D, m: NonNullable<PaneDrawingState['measure']>) {
  const color = m.up ? SIGNED_UP : SIGNED_DOWN;
  const [left, right] = [Math.min(m.x1, m.x2), Math.max(m.x1, m.x2)];
  const [top, bottom] = [Math.min(m.y1, m.y2), Math.max(m.y1, m.y2)];
  const [cx, cy] = [(left + right) / 2, (top + bottom) / 2];

  ctx.globalAlpha = MEASURE_ALPHA;
  ctx.fillStyle = color;
  ctx.fillRect(left, top, right - left, bottom - top);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, m.y1);
  ctx.lineTo(cx, m.y2);
  ctx.moveTo(m.x1, cy);
  ctx.lineTo(m.x2, cy);
  ctx.stroke();

  ctx.font = LABEL_FONT;

  const width = Math.max(...m.label.map((t) => ctx.measureText(t).width)) + LABEL_PAD * 2;
  const height = LABEL_LINE * m.label.length + LABEL_PAD;
  const boxTop = m.up ? bottom + LABEL_PAD : top - LABEL_PAD - height;

  ctx.fillStyle = color;
  ctx.fillRect(cx - width / 2, boxTop, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  m.label.forEach((t, i) => {
    ctx.fillText(t, cx, boxTop + LABEL_PAD / 2 + 2 + i * LABEL_LINE);
  });
}

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly state: PaneDrawingState) {}

  draw(target: CanvasRenderingTarget2D): void {
    const { shapes, selected, preview, measure } = this.state;
    // biome-ignore lint/correctness/useHookAtTopLevel: useMediaCoordinateSpace 是 canvas 方法,不是 React hook
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      shapes.forEach((s) => {
        const on = s.id === selected;
        ctx.lineWidth = on ? 2 : 1.5;
        ctx.strokeStyle = COLOR;
        // 按 kind 取对应那一行;联合类型下 TS 认不出 s 和 GEOM[s.kind] 是同一种,只能断言
        const g = GEOM[s.kind](s as never, mediaSize);
        if (g.fill) {
          ctx.globalAlpha = FILL_ALPHA;
          ctx.fillStyle = COLOR;
          ctx.beginPath();
          const [first, ...rest] = g.fill;
          ctx.moveTo(...first);
          rest.forEach((pt) => {
            ctx.lineTo(...pt);
          });
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        g.lines.forEach(([from, to]) => {
          ctx.moveTo(...from);
          ctx.lineTo(...to);
        });
        ctx.stroke();

        if (g.dashed) {
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          g.dashed.forEach(([from, to]) => {
            ctx.moveTo(...from);
            ctx.lineTo(...to);
          });
          ctx.stroke();
          ctx.setLineDash([]);
        }

        if (!on) return;

        ctx.fillStyle = COLOR;
        g.handles.forEach(([hx, hy]) => {
          ctx.beginPath();
          ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
          ctx.fill();
        });
      });

      if (measure) drawMeasure(ctx, measure);

      // 落点预览:空心圈,不挡下面的 K 线
      if (preview) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = COLOR;
        ctx.beginPath();
        ctx.arc(preview.x, preview.y, PREVIEW_R, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }
}

/**
 * 挂在一个 lw 格上的图元。不自己存画线:每次重画都调 source 现算(平移 / 缩放 / 拖动草稿都即时跟上),
 * 状态变了由外面调 update() 请求重画。格级图元总画在 K 线下面 —— 有意的,同 TradingView 默认(设计文档 §5「渲染」)
 */
export class DrawingsPrimitive implements IPanePrimitive<Time> {
  private requestUpdate?: () => void;
  // 同一个数组:lw-charts 按数组引用做缓存,集合没变就别换
  private readonly views: readonly IPanePrimitivePaneView[];

  constructor(private readonly source: () => PaneDrawingState) {
    this.views = [{ renderer: () => new DrawingsRenderer(this.source()) }];
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
