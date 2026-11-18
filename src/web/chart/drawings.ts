// 手画线的纯计算:时间轴换算、命中检测、文字尺寸、光标。画在格子上的图元见 primitives/drawings,
// 文档模型见 views/chartDoc/chartDoc 的 Drawing,交互见编辑器 useDrawings。
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

export type TwoPoints = { id: string; x1: number; y1: number; x2: number; y2: number };

/** 一条画线换算到当前这一格的像素(media 坐标,绘图区左上角为原点);color / dash 原样带过来(见 chartDoc 的 DrawingStyle) */
export type Shape = { color?: string; dash?: LineDash; locked?: true } & (
  | (TwoPoints & { kind: 'trend' })
  | (TwoPoints & { kind: 'ray' })
  | { id: string; kind: 'hline'; y: number }
  | { id: string; kind: 'hray'; x: number; y: number }
  | (TwoPoints & { kind: 'channel'; x3: number; y3: number })
  /** 文字:左上角 (x,y),w / h = 整块(含加框的留白)的像素大小,命中和画框都用它 */
  | { id: string; kind: 'text'; x: number; y: number; lines: string[]; box: boolean; w: number; h: number }
  /** 矩形:(x1,y1)(x2,y2) 是对角两点;extend = 右边不封口,上下边画到画布右缘 */
  | (TwoPoints & { kind: 'rect'; extend: boolean })
  /**
   * 回归通道:(x1,y1)(x2,y2) = 中线两端(手柄);mid / up / down = 中线、上下轨在每个数据点处的像素(折线:对数 / 倒轴下
   * 数值上的直线在屏幕上不一定直);r = 相关系数
   */
  | (TwoPoints & { kind: 'regression'; mid: Pt[]; up: Pt[]; down: Pt[]; r: number | null })
  /** 标注气泡:(x1,y1) = 指针尖,(x2,y2) = 文字框中心,w / h 见 calloutSize(框以中心向四周长) */
  | (TwoPoints & { kind: 'callout'; lines: string[]; w: number; h: number })
  | { id: string; kind: 'vline'; x: number }
);

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

/** 命中:哪条、抓的是哪儿(两点线的两端 a / b,水平射线的起点 a,通道平行线上的宽度手柄 c,矩形的 8 个手柄,其余一律线身) */
export type Hit = { id: string; part: 'a' | 'b' | 'c' | 'body' | RectHandle; dist: number };

// 离线多近算点中;端点手柄比线身优先(同一处既是端点又在线上时,拖端点)
const HIT_PX = 6;
const HANDLE_PX = 8;
export const HANDLE_R = 4;

// 文字的字体与排版(画、量尺寸、编辑器的就地编辑框用同一套,命中范围和编辑时的位置才对得上)
export const TEXT_FONT = '13px system-ui, -apple-system, sans-serif';
export const TEXT_LINE = 18;
export const TEXT_PAD = 6;

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** 一行字的宽度。用一块离屏画布量;没有 DOM 的环境(单测)按字符估:ASCII 半个字宽、其余一个字宽 */
function lineWidth(line: string): number {
  if (measureCtx === undefined)
    measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measureCtx) return [...line].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? 7 : 13), 0);

  measureCtx.font = TEXT_FONT;
  return measureCtx.measureText(line).width;
}

/** 文字整块的大小(左右各留 TEXT_PAD,不论加不加框都按这个算,加框与否位置不跳) */
export function textSize(lines: string[]): { w: number; h: number } {
  return { w: Math.max(0, ...lines.map(lineWidth)) + TEXT_PAD * 2, h: lines.length * TEXT_LINE + TEXT_PAD };
}

// 气泡框 / 就地编辑框共用的最小宽度(InlineTextEditor 也读它):空着画的框正好被编辑框盖住
export const CALLOUT_MIN_W = 64;

/** 气泡框的大小:同文字,但不窄于编辑框(画到一半还没字时框也看得见) */
export function calloutSize(lines: string[]): { w: number; h: number } {
  const t = textSize(lines);
  return { w: Math.max(t.w, CALLOUT_MIN_W), h: t.h };
}

// 气泡指针根部的半宽:根部埋在框中心,露出框的是从框边收窄到尖的一截
const POINTER_HALF = 10;

/** 气泡文字框的左上角 */
export function calloutBox(s: ShapeOf<'callout'>): { left: number; top: number } {
  return { left: s.x2 - s.w / 2, top: s.y2 - s.h / 2 };
}

/**
 * 气泡指针三角:根部在框中心、垂直于「中心 → 尖」各让出半宽,尖在 a。半宽不超过半个框高,根部总在框里。
 * 尖和框中心重合没有方向 → null
 */
export function calloutPointer(s: Omit<TwoPoints, 'id'> & { h: number }): [Pt, Pt, Pt] | null {
  const [dx, dy] = [s.x1 - s.x2, s.y1 - s.y2];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;

  const half = Math.min(POINTER_HALF, s.h / 2 - 1);
  const [nx, ny] = [(-dy / len) * half, (dx / len) * half];
  return [
    [s.x2 + nx, s.y2 + ny],
    [s.x2 - nx, s.y2 - ny],
    [s.x1, s.y1],
  ];
}

/** 气泡:尖的手柄(改指向)> 框里(只挪框,同 TradingView)> 指针附近(整个挪) */
function hitCallout(s: ShapeOf<'callout'>, x: number, y: number): Hit | null {
  if (Math.hypot(x - s.x1, y - s.y1) <= HANDLE_PX) return { id: s.id, part: 'a', dist: 0 };

  const { left, top } = calloutBox(s);
  if (x >= left && x <= left + s.w && y >= top && y <= top + s.h) return { id: s.id, part: 'b', dist: HIT_PX / 2 };

  const d = pointToSegmentDistance(x, y, s.x2, s.y2, s.x1, s.y1);
  return d <= HIT_PX ? { id: s.id, part: 'body', dist: d } : null;
}

function hitOne(s: Shape, x: number, y: number): Hit | null {
  if (s.kind === 'callout') return hitCallout(s, x, y);
  if (s.kind === 'text') {
    if (Math.hypot(x - s.x, y - s.y) <= HANDLE_PX) return { id: s.id, part: 'a', dist: 0 };
    return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h
      ? { id: s.id, part: 'body', dist: HIT_PX / 2 }
      : null;
  }
  if (s.kind === 'hline')
    return Math.abs(y - s.y) <= HIT_PX ? { id: s.id, part: 'body', dist: Math.abs(y - s.y) } : null;
  if (s.kind === 'vline')
    return Math.abs(x - s.x) <= HIT_PX ? { id: s.id, part: 'body', dist: Math.abs(x - s.x) } : null;
  if (s.kind === 'hray') {
    if (Math.hypot(x - s.x, y - s.y) <= HANDLE_PX) return { id: s.id, part: 'a', dist: 0 };
    const d = Math.abs(y - s.y);
    return d <= HIT_PX && x >= s.x ? { id: s.id, part: 'body', dist: d } : null;
  }
  if (s.kind === 'rect') return hitRect(s, x, y);

  const da = Math.hypot(x - s.x1, y - s.y1);
  const db = Math.hypot(x - s.x2, y - s.y2);
  if (Math.min(da, db) <= HANDLE_PX) return { id: s.id, part: da <= db ? 'a' : 'b', dist: 0 };
  if (s.kind === 'channel') return hitChannel(s, x, y);
  if (s.kind === 'regression') return hitRegression(s, x, y);
  const end = s.kind === 'ray' ? rayEnd(s.x1, s.y1, s.x2, s.y2) : { x: s.x2, y: s.y2 };
  const d = pointToSegmentDistance(x, y, s.x1, s.y1, end.x, end.y);
  return d <= HIT_PX ? { id: s.id, part: 'body', dist: d } : null;
}

/** 折线的相邻两点连成的各段 */
export function segments(pts: Pt[]): [Pt, Pt][] {
  return pts.slice(1).map((p, i) => [pts[i], p]);
}

/** 回归通道:中线、上下轨三条折线附近算线身;两轨之间点不中(同矩形,框里按住拖是平移图表) */
function hitRegression(s: ShapeOf<'regression'>, x: number, y: number): Hit | null {
  const d = Math.min(
    ...[s.mid, s.up, s.down].flatMap(segments).map(([p, q]) => pointToSegmentDistance(x, y, ...p, ...q)),
  );
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

type RectBounds = { l: number; r: number; t: number; b: number };

/** 两点围成的框的上下左右边(两点不分哪个在左上;编辑器拖矩形手柄也用它) */
export function boxOf(x1: number, y1: number, x2: number, y2: number): RectBounds {
  return { l: Math.min(x1, x2), r: Math.max(x1, x2), t: Math.min(y1, y2), b: Math.max(y1, y2) };
}

/** 矩形的上下左右边;向右延伸的右边在 right(画线用画布右缘,命中用无穷远);手柄按不延伸的框算(right 不用) */
export function rectBounds(s: ShapeOf<'rect'>, right?: number): RectBounds {
  const box = boxOf(s.x1, s.y1, s.x2, s.y2);
  return s.extend && right !== undefined ? { ...box, r: right } : box;
}

/** 矩形的 8 个手柄(四角 + 四边中点,按方位命名) */
export type RectHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 每个手柄管哪几条边(同 TradingView:角改两条邻边,边中点只改这一条) */
export const RECT_EDGES: Record<RectHandle, { x?: 'l' | 'r'; y?: 't' | 'b' }> = {
  nw: { x: 'l', y: 't' },
  n: { y: 't' },
  ne: { x: 'r', y: 't' },
  e: { x: 'r' },
  se: { x: 'r', y: 'b' },
  s: { y: 'b' },
  sw: { x: 'l', y: 'b' },
  w: { x: 'l' },
};
const RECT_HANDLES = Object.keys(RECT_EDGES) as RectHandle[];

export function isRectHandle(part: string): part is RectHandle {
  return Object.hasOwn(RECT_EDGES, part);
}

/** 手柄位置:管到的边取那条边,没管到的方向取中点 */
export function rectHandleAt(box: RectBounds, h: RectHandle): Pt {
  const { x, y } = RECT_EDGES[h];
  return [x ? box[x] : (box.l + box.r) / 2, y ? box[y] : (box.t + box.b) / 2];
}

/**
 * 矩形:8 个手柄 > 边上;框里点不中(同 TradingView,负责人 2026-11-10 实测:框里按住拖是平移图表,停到边上才拖框;
 * 向右延伸的价格带也就不会挡住平移)。上下边在左右范围内、左右边在上下范围内才算,各放宽 HIT_PX
 */
function hitRect(s: ShapeOf<'rect'>, x: number, y: number): Hit | null {
  const box = rectBounds(s);
  const handle = RECT_HANDLES.find((h) => {
    const [hx, hy] = rectHandleAt(box, h);
    return Math.hypot(x - hx, y - hy) <= HANDLE_PX;
  });
  if (handle) return { id: s.id, part: handle, dist: 0 };

  const { l, r, t, b } = rectBounds(s, Number.POSITIVE_INFINITY);
  const alongX = x >= l - HIT_PX && x <= r + HIT_PX;
  const alongY = y >= t - HIT_PX && y <= b + HIT_PX;

  const d = Math.min(
    alongX ? Math.min(Math.abs(y - t), Math.abs(y - b)) : Number.POSITIVE_INFINITY,
    alongY ? Math.min(Math.abs(x - l), Math.abs(x - r)) : Number.POSITIVE_INFINITY,
  );
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

// 画线默认颜色(浮条里可改);选中不换色(同 TradingView;以前换成的亮黄在暖白底上几乎看不见):靠加粗 + 手柄表示选中
export const DRAWING_COLOR = '#eab308';
/** 线型的虚线节奏(canvas setLineDash 的线段 / 间隔像素);实线不存 */
export const LINE_DASH: Record<'dashed' | 'dotted', number[]> = { dashed: [6, 4], dotted: [2, 3] };
export type LineDash = keyof typeof LINE_DASH;

export type ShapeOf<K extends Shape['kind']> = Extract<Shape, { kind: K }>;
export type Pt = [number, number];
export type Size = { width: number; height: number };

/** 方向 (dx,dy) 取最近的双向放缩箭头(屏幕纵轴朝下:往右下 = nwse);方向线不分正反,只看 0~180° */
export function resizeCursor(dx: number, dy: number): string {
  const signed = (Math.atan2(dy, dx) * 180) / Math.PI;
  const deg = (signed + 180) % 180;

  if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
  if (deg < 67.5) return 'nwse-resize';
  if (deg < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

/** 矩形手柄的光标:角按斜向(左上 / 右下同一斜线),边中点按它管的方向 */
function rectCursor(h: RectHandle): string {
  const { x, y } = RECT_EDGES[h];
  if (x && y) return (x === 'l') === (y === 't') ? 'nwse-resize' : 'nesw-resize';

  return x ? 'ew-resize' : 'ns-resize';
}

/**
 * 悬停在画线上的光标:线身是「移动」;矩形的 8 个手柄见 rectCursor;两点画线的端点 / 气泡的尖是放缩箭头,方向 = 对面那一点 → 这一点
 * (负责人 2026-11-10 定:端点别用手);通道的宽度手柄只改宽度,竖向箭头;水平射线起点、文字左上角、气泡的框
 * 拖它是整个挪,也是「移动」
 */
export function hitCursor(s: Shape, part: Hit['part']): string {
  if (isRectHandle(part)) return rectCursor(part);
  if (part === 'body' || !('x2' in s) || (s.kind === 'callout' && part === 'b')) return 'move';
  if (part === 'c') return 'ns-resize';

  return part === 'a' ? resizeCursor(s.x1 - s.x2, s.y1 - s.y2) : resizeCursor(s.x2 - s.x1, s.y2 - s.y1);
}
