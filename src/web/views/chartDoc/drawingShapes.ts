// 画线 → 这一格的像素(纯换算,不管交互):编辑器(pages/editor 的 useDrawings)和只读图(DocChart 的 useDrawingsView)共用。
import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts';
import { calloutSize, textSize, type Pt, type Shape, type TimeAxis } from '../../chart/drawings';
import { linearRegression, regressionAt } from '../../chart/regression';
import type { Drawing, DrawingPoint, Layer } from './chartDoc';
import type { LayerSeries } from './useDocChart';

export type Entry = { drawing: Drawing; layer: Layer; paneIndex: number };

/** 换算像素要用的:日期 ↔ 下标、下标 ↔ 横坐标、图层 → 它的 series(纵坐标由 series 按自己的轴算,对数 / 倒轴都对) */
export type ShapeCtx = {
  axis: TimeAxis;
  toX: (logical: number) => number;
  toLogical: (x: number) => number;
  /** 画布右缘的逻辑下标(回归通道向右延伸画到这里) */
  right: number;
  seriesOf: (layerId: string) => ISeriesApi<SeriesType> | undefined;
};

/**
 * 当前视图的换算。lw-charts 的 logicalToCoordinate 只认整数下标(带小数直接返回 0),
 * 而锚点落在两根之间、空白区时下标是小数 —— 按第 0、1 根的横坐标线性换算(横轴本来就是等距的)
 */
export function makeShapeCtx(chart: IChartApi, series: LayerSeries, axis: TimeAxis): ShapeCtx | null {
  const ts = chart.timeScale();
  const x0 = ts.logicalToCoordinate(0 as Logical);
  const x1 = ts.logicalToCoordinate(1 as Logical);
  if (x0 === null || x1 === null || x1 === x0) return null;

  const bar = x1 - x0;
  // 指标图层在图上是几条子线(id#plot),换算纵坐标用第一条
  const seriesOf = (layerId: string) =>
    series.get(layerId) ?? [...series].find(([k]) => k.startsWith(`${layerId}#`))?.[1];
  return {
    axis,
    toX: (l) => x0 + l * bar,
    toLogical: (x) => (x - x0) / bar,
    right: (ts.width() - x0) / bar,
    seriesOf,
  };
}

export function toPx(ctx: ShapeCtx, s: ISeriesApi<SeriesType>, p: DrawingPoint) {
  const l = ctx.axis.toLogical(p.time);
  const y = s.priceToCoordinate(p.value);
  return l === null || y === null ? null : { x: ctx.toX(l), y };
}

// 回归通道上下轨 = 中线 ± 这么多倍残差标准差(同 TradingView 默认;先不做可调)
const REGRESSION_K = 2;

/** series 一个数据点的值:蜡烛取收盘,线 / 柱取 value;空白点(只有时间)是 null */
function itemValue(item: object): number | null {
  const v = 'close' in item ? item.close : 'value' in item ? item.value : null;
  return typeof v === 'number' ? v : null;
}

/**
 * 回归通道要拟合的点:两个日期换成图上的逻辑下标,只按下标取区间内的那几根(dataByIndex),不扫整条序列 ——
 * 图元每次重画、每次鼠标移动(lw 的 hitTest)都要算一遍,日线从 1990 年起有上万根。下标处这条序列没数据(空白点)就跳过。
 * 对数拟合(log)时纵坐标取 ln;≤ 0 的点取不了对数,跳过(对数拟合本来就只对价格这类正值有意义)
 */
export function regressionPoints(
  ctx: ShapeCtx,
  s: ISeriesApi<SeriesType>,
  d: Extract<Drawing, { kind: 'regression' }>,
): { x: number; y: number }[] {
  const [la, lb] = [ctx.axis.toLogical(d.a.time), ctx.axis.toLogical(d.b.time)];
  if (la === null || lb === null) return [];

  const from = Math.ceil(Math.min(la, lb));
  const to = Math.floor(Math.max(la, lb));
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i).flatMap((x) => {
    const item = s.dataByIndex(x);
    const y = item ? itemValue(item) : null;
    if (y === null || (d.log && y <= 0)) return [];
    return [{ x, y: d.log ? Math.log(y) : y }];
  });
}

/**
 * 回归通道在这一格的像素:取所挂序列在两个日期之间(含两端)的数据点,对图上的逻辑下标做直线回归(同 TradingView 按根数,
 * 不按日历天),中线 / 上下轨在每个数据点处换成像素;不足两个点画不出来。手柄按 a / b 各自落在中线的哪一端放,拖哪个改哪个日期。
 * 向右延伸(同 TradingView Extend lines):拟合不变,从区间最后一点起逐根往右算到画布右缘 —— 逐根而不是连直线,对数轴下才弯得对。
 * 对数拟合:拟合在 ln 空间做,画的时候 exp 回原值 —— 上下轨是中线乘除同一个比例,对数轴下三条都是直线
 */
function regressionShape(
  ctx: ShapeCtx,
  s: ISeriesApi<SeriesType>,
  d: Extract<Drawing, { kind: 'regression' }>,
): Shape[] {
  const pts = regressionPoints(ctx, s, d);
  const g = linearRegression(pts);
  if (!g) return [];

  const px = (x: number, k: number): Pt[] => {
    const v = regressionAt(g, x) + k * g.sd;
    const y = s.priceToCoordinate(d.log ? Math.exp(v) : v);
    // 下降趋势延伸到负值时对数轴换不出坐标
    return y === null || !Number.isFinite(y) ? [] : [[ctx.toX(x), y]];
  };
  const end = pts[pts.length - 1].x;
  const tail = d.extend ? Math.max(0, Math.ceil(ctx.right) - end) : 0;
  const xs = [...pts.map((p) => p.x), ...Array.from({ length: tail }, (_, i) => end + 1 + i)];
  const [mid, up, down] = [0, REGRESSION_K, -REGRESSION_K].map((k) => xs.flatMap((x) => px(x, k)));
  const [first] = px(pts[0].x, 0);
  const [last] = px(end, 0);
  if (!first || !last) return [];

  const [pa, pb] = d.a.time <= d.b.time ? [first, last] : [last, first];
  return [{ id: d.id, kind: 'regression', x1: pa[0], y1: pa[1], x2: pb[0], y2: pb[1], mid, up, down, r: g.r }];
}

/** 第 i 格此刻要画的像素(带上画线的颜色 / 线型 / 锁定;lockAll = 左栏锁定全部,每条都按锁定画光标) */
export function paneShapes(ctx: ShapeCtx, entries: Entry[], i: number, lockAll = false): Shape[] {
  return entries.flatMap((e) =>
    drawingShapes(ctx, e, i).map((sh) => ({
      ...sh,
      color: e.drawing.color,
      dash: e.drawing.dash,
      locked: lockAll || e.drawing.locked,
    })),
  );
}

/** 一条画线在第 i 格的像素:趋势线 / 水平线只画在所属图层那一格;竖线延伸的每格都画,只画本格的(paneOnly)只在那一格 */
function drawingShapes(ctx: ShapeCtx, { drawing: d, layer, paneIndex }: Entry, i: number): Shape[] {
  if (d.kind === 'vline') {
    const l = ctx.axis.toLogical(d.time);
    return (d.paneOnly && paneIndex !== i) || l === null ? [] : [{ id: d.id, kind: 'vline', x: ctx.toX(l) }];
  }
  const s = paneIndex === i ? ctx.seriesOf(layer.id) : undefined;
  if (!s) return [];
  if (d.kind === 'hline') {
    const y = s.priceToCoordinate(d.value);
    return y === null ? [] : [{ id: d.id, kind: 'hline', y }];
  }
  if (d.kind === 'hray') {
    const a = toPx(ctx, s, d.a);
    return a ? [{ id: d.id, kind: 'hray', x: a.x, y: a.y }] : [];
  }
  if (d.kind === 'text') {
    const a = toPx(ctx, s, d.a);
    const lines = d.text.split('\n');
    return a ? [{ id: d.id, kind: 'text', x: a.x, y: a.y, lines, box: !!d.box, ...textSize(lines) }] : [];
  }
  const a = toPx(ctx, s, d.a);
  const b = toPx(ctx, s, d.b);
  if (!a || !b) return [];
  if (d.kind === 'channel') {
    const c = toPx(ctx, s, d.c);
    return c ? [{ id: d.id, kind: 'channel', x1: a.x, y1: a.y, x2: b.x, y2: b.y, x3: c.x, y3: c.y }] : [];
  }
  if (d.kind === 'callout') {
    const lines = d.text.split('\n');
    return [{ id: d.id, kind: 'callout', x1: a.x, y1: a.y, x2: b.x, y2: b.y, lines, ...calloutSize(lines) }];
  }
  if (d.kind === 'rect') return [{ id: d.id, kind: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y, extend: !!d.extend }];
  if (d.kind === 'regression') return regressionShape(ctx, s, d);
  return [{ id: d.id, kind: d.kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
}
