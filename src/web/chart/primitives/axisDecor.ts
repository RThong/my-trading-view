// 纵轴上的补充绘制(插件接口 priceAxisPaneViews,画在图表库自己的纵轴画布上 → 多格、截图导出都自然带上):
// ① 轴头单位:数字上万的轴刻度除以 1000(上千万除以 100 万),轴顶写「×1,000」(同研报图),刻度不用把 0 写全;
// ② 多出来的纵轴(第 3、4 根…):图表库一格只给左右各一根看得见的轴,独立轴没有刻度 ——
//    把右轴设宽(minimumWidth),在多出来的那截里从左往右一根根画,刻度按那条线自己的 价格 ↔ 坐标 换算(对数 / 倒轴都对)。
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PriceFormat,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { MismatchDirection, PriceScaleMode } from 'lightweight-charts';

/** 一根多出来的轴占的宽度 */
export const STRIP_W = 52;
// 相邻刻度至少隔这么多像素(同原生轴的疏密);轴顶留给单位字样的高度,刻度不进这一截
const MIN_GAP = 36;
export const HEAD_H = 18;

export type AxisUnit = { div: number; label: string };

/** 按这根轴上数据的最大绝对值定单位:上万 ×1,000、上千万 ×1M;更小的不缩 */
export function axisUnit(maxAbs: number): AxisUnit | undefined {
  if (maxAbs >= 1e7) return { div: 1e6, label: '×1M' };
  if (maxAbs >= 1e4) return { div: 1e3, label: '×1,000' };
  return undefined;
}

/** 刻度数字:按量级留小数(同原生轴的观感,不带尾随 0) */
export function fmtTick(v: number): string {
  const abs = Math.abs(v);
  return v.toLocaleString('en-US', { maximumFractionDigits: abs >= 100 ? 0 : abs >= 1 ? 2 : 4 });
}

/**
 * 带单位的轴:这根轴上各条线的价格格式(刻度、最新值标签、十字线标签都按单位缩)。
 * inHead:这个价位的刻度是否落进轴顶单位字样那一截 —— 是就不写字(只对刻度,不影响最新值 / 十字线标签),
 * 否则刻度字会被单位字样的底色压掉半截
 */
export function unitPriceFormat(unit: AxisUnit | undefined, inHead?: (price: number) => boolean): PriceFormat {
  if (!unit) return { type: 'price', precision: 2, minMove: 0.01 };
  const formatter = (p: number) => fmtTick(p / unit.div);

  return {
    type: 'custom',
    formatter,
    tickmarksFormatter: (prices) => prices.map((p) => (inHead?.(p) ? '' : formatter(p))),
    minMove: 0.01,
  };
}

/** 线性刻度:按 1 / 2 / 5 × 10^k 挑步长,让刻度数接近 count */
export function linearTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo) || count < 1) return [];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // 留一点容差:0.6 / 3 浮点出来是 0.20000000000000004,不容差会跳过 0.2 选成 0.5
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw * (1 - 1e-9)) ?? 10 * mag;
  const first = Math.ceil(lo / step) * step;
  const n = Math.floor((hi - first) / step + 1e-9) + 1;
  return Array.from({ length: Math.max(n, 0) }, (_, i) => Number((first + i * step).toPrecision(12)));
}

/** 对数刻度:每个数量级取 1 / 2 / 5(太密就只取 1);范围窄到一个数量级以内时退回线性 */
export function logTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo) || lo <= 0) return [];
  if (hi / lo < 10) return linearTicks(lo, hi, count);
  const from = Math.floor(Math.log10(lo));
  const decades = Array.from({ length: Math.floor(Math.log10(hi)) - from + 1 }, (_, i) => 10 ** (from + i));
  const dense = decades.flatMap((d) => [d, 2 * d, 5 * d]).filter((v) => v >= lo && v <= hi);

  return dense.length <= count ? dense : decades.filter((v) => v >= lo && v <= hi);
}

/** 色块上的字色:同图表库原生最新值标签的取法(灰度 > 160 用黑字),浅色线(亮黄 / 亮绿)上白字看不清 */
export function textOn(bg: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg);
  if (!m) return '#ffffff';
  const [r, g, b] = m.slice(1).map((h) => Number.parseInt(h, 16));

  return 0.199 * r + 0.687 * g + 0.114 * b > 160 ? '#000000' : '#ffffff';
}

/** 一根多出来的轴:画谁的刻度、什么色、单位;tag = 最新值色块的颜色(同原生轴的最新值标签),没有就不画 */
export type Strip = {
  series: ISeriesApi<SeriesType>;
  color: string;
  unit?: AxisUnit;
  tag?: string;
};

/** 可视区某一端的那根的值(折线取值、蜡烛取收盘);那一根是空白占位 → undefined */
function visibleEnd(
  series: ISeriesApi<SeriesType>,
  chart: IChartApi | undefined,
  end: 'from' | 'to',
): number | undefined {
  const range = chart?.timeScale().getVisibleLogicalRange();
  if (!range) return undefined;
  // 同图表库的可视区取整(左 floor、右 ceil):最新值标签取 ceil(右端) 往左第一根,
  // 百分比 / 起点 100 的基准取 floor(左端) 往右第一根。右端用 floor 会差一根,和原生轴的标签对不上
  const [at, dir] =
    end === 'to'
      ? [Math.ceil(range.to), MismatchDirection.NearestLeft]
      : [Math.floor(range.from), MismatchDirection.NearestRight];
  const d = series.dataByIndex(at, dir);
  if (!d) return undefined;

  return 'value' in d ? d.value : 'close' in d ? d.close : undefined;
}

/**
 * 刻度写什么:价格 ↔ 刻度上的数。普通 / 对数写价格(上万按单位缩);百分比 / 起点 100 按「可视区第一根」换算,
 * 同图表库原生轴(它的基准也是可视区第一根,拖动时跟着变),不然线按百分比画、刻度却写原值。
 * base 缺(可视区里没有这条线的点)时退回写价格
 */
export type AxisSpace = {
  toLabel: (price: number) => number;
  fromLabel: (label: number) => number;
  text: (label: number) => string;
  ticks: (lo: number, hi: number, count: number) => number[];
};

export function axisSpace(mode: PriceScaleMode, base: number | undefined, unit: AxisUnit | undefined): AxisSpace {
  if (base && mode === PriceScaleMode.Percentage)
    return {
      toLabel: (p) => (p / base - 1) * 100,
      fromLabel: (v) => base * (1 + v / 100),
      text: (v) => `${fmtTick(v)}%`,
      ticks: linearTicks,
    };
  if (base && mode === PriceScaleMode.IndexedTo100)
    return { toLabel: (p) => (p / base) * 100, fromLabel: (v) => (v * base) / 100, text: fmtTick, ticks: linearTicks };

  return {
    toLabel: (p) => p,
    fromLabel: (v) => v,
    text: (v) => fmtTick(unit ? v / unit.div : v),
    ticks: mode === PriceScaleMode.Logarithmic ? logTicks : linearTicks,
  };
}

/**
 * 一根纵轴(左或右)上要补画的:轴自己的单位字样,以及(只右轴)多出来的几根轴。
 * slots = 整张图右侧留出的根数(各格取最多的那格,图表库各格的右轴等宽),本格的从左往右排在前面
 */
export type AxisDecor = {
  side: 'left' | 'right';
  head?: { text: string; color: string };
  strips: Strip[];
  slots: number;
  font: string;
  fontSize: number;
  /** 图表底色:单位字样垫一条底色,压在它下面的原生刻度(轴顶那一个)不再和它叠字 */
  bg: string;
};

function drawStrip(
  ctx: CanvasRenderingContext2D,
  { series, color, unit, tag }: Strip,
  x: number,
  height: number,
  fontSize: number,
  chart: IChartApi | undefined,
): void {
  const top = series.coordinateToPrice(0);
  const bottom = series.coordinateToPrice(height);
  if (top === null || bottom === null) return;
  const mode = series.priceScale().options().mode;
  const relative = mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
  // 基准用这条线自己可视区第一根:图表库在百分比 / 起点 100 下把每条线各按自己的第一根换算(轴上几条线起点不同也一样),
  // priceToCoordinate 用的也是它。别换成「整根轴最早的那根」—— 2026-11-18 试过,刻度和色块整体错位
  const space = axisSpace(mode, relative ? visibleEnd(series, chart, 'from') : undefined, unit);
  // 换算是单调增的(基准 > 0):刻度在「刻度上的数」里取整,再换回价格定高度
  const [lo, hi] = [Math.min(top, bottom), Math.max(top, bottom)].map(space.toLabel);
  const ticks = space.ticks(lo, hi, Math.max(2, Math.floor(height / MIN_GAP)));
  // 最新值色块的纵向位置与半高:压在它下面的刻度不画(原生轴会叠字)
  const last = tag === undefined ? undefined : visibleEnd(series, chart, 'to');
  const tagY = last === undefined ? null : series.priceToCoordinate(last);
  const tagHalf = fontSize / 2 + 3;

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  // 轴线:用这条线的颜色贯穿整格高(同研报图)
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, height);
  ctx.stroke();
  ticks.forEach((v) => {
    const y = series.priceToCoordinate(space.fromLabel(v));
    if (y === null || y < HEAD_H || y > height - 6) return;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 4, y);
    ctx.stroke();
    if (tagY !== null && Math.abs(y - tagY) < tagHalf + fontSize / 2) return;
    ctx.fillText(space.text(v), x + 7, y);
  });
  if (unit && !relative) ctx.fillText(unit.label, x + 7, HEAD_H / 2);
  if (tagY === null || last === undefined || tag === undefined || tagY < 0 || tagY > height) return;

  ctx.fillStyle = tag;
  ctx.fillRect(x + 1, tagY - tagHalf, STRIP_W - 2, tagHalf * 2);
  ctx.fillStyle = textOn(tag);
  // 两位小数(普通坐标同线的价格格式;百分比 / 起点 100 同原生轴的写法);放不下一根轴宽时退回刻度那种少小数的写法
  const label = space.toLabel(last);
  const full = relative
    ? `${label.toFixed(2)}${mode === PriceScaleMode.Percentage ? '%' : ''}`
    : series.priceFormatter().format(last);
  const text = ctx.measureText(full).width <= STRIP_W - 7 ? full : space.text(label);
  ctx.fillText(text, x + 5, tagY);
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly decor: AxisDecor,
    private readonly chart: IChartApi | undefined,
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void {
    const { side, head, strips, slots, font, fontSize, bg } = this.decor;
    // biome-ignore lint/correctness/useHookAtTopLevel: useMediaCoordinateSpace 是 canvas 方法,不是 React hook
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: { width, height } }) => {
      ctx.font = font;
      ctx.textBaseline = 'middle';
      // 轴自己的单位:写在轴顶靠内侧(右轴的刻度靠左、左轴的靠右,同原生刻度的对齐)
      if (head) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width - slots * STRIP_W, HEAD_H);
        ctx.fillStyle = head.color;
        ctx.textAlign = side === 'right' ? 'left' : 'right';
        ctx.fillText(head.text, side === 'right' ? 8 : width - 8, HEAD_H / 2);
      }
      ctx.textAlign = 'left';
      strips.forEach((s, k) => {
        drawStrip(ctx, s, width - (slots - k) * STRIP_W, height, fontSize, this.chart);
      });
    });
  }
}

/** 挂在某根轴(左 / 右)上一条线上的插件:画这根轴的单位字样,右轴的还画多出来的几根轴 */
export class AxisDecorPrimitive implements ISeriesPrimitive<Time> {
  private decor?: AxisDecor;
  private param?: SeriesAttachedParameter<Time>;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }

  detached(): void {
    this.param = undefined;
  }

  setDecor(decor: AxisDecor): void {
    this.decor = decor;
    this.param?.requestUpdate();
  }

  priceAxisPaneViews(): IPrimitivePaneView[] {
    const decor = this.decor;
    // normal:画在原生刻度之后(底色能压住轴顶那截的刻度短线)、最新值标签和十字线标签之前(鼠标移到轴顶时标签不被单位字样盖住)
    return decor ? [{ zOrder: () => 'normal', renderer: () => new Renderer(decor, this.param?.chart) }] : [];
  }
}
