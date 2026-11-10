// 编辑器的画线:工具栏状态 + 画 / 选 / 拖 / 删(只在编辑器,固定面板不给画)。设计见 docs/chart-editor-design.md §5。
// 画线存进 ChartDoc(挂在图层上);每个 lw 格挂一个 DrawingsPrimitive,绘制时现读这里的 ref 现算像素,平移缩放自动跟上。
// 拖动 / 画趋势线途中只改本地草稿(draftRef),松手才写回文档:每帧写文档会整页重渲染 + 落盘
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { IChartApi, IPaneApi, ISeriesApi, Logical, SeriesType, Time } from 'lightweight-charts';
import {
  calloutSize,
  channelOffset,
  DrawingsPrimitive,
  hitShapes,
  textSize,
  lineYAt,
  timeAxis,
  type Hit,
  type PaneDrawingState,
  type Shape,
  type TimeAxis,
} from '../../../chart/drawings';
import {
  allDrawings,
  canOwnDrawings,
  findLayer,
  nextId,
  type ChartDoc,
  type Drawing,
  type DrawingPoint,
  type Layer,
} from '../../../views/chartDoc/chartDoc';
import { fmtDate } from '../../../chart/core';
import type { LayerData } from '../../../views/chartDoc/layerPoints';
import type { LayerSeries } from '../../../views/chartDoc/useDocChart';
import type { BarValues } from '../../../chart/magnet';
import { measureLabel, measureStats } from '../../../chart/measure';
import { CHART_CHROME, getTheme } from '../../../hooks/theme';
import type { PointCtx } from '../drawingPlugins/types';
import { paneAt, paneCoords } from './paneHit';

export type DrawingTool =
  | 'cursor'
  | 'trend'
  | 'ray'
  | 'channel'
  | 'hline'
  | 'hray'
  | 'vline'
  | 'measure'
  | 'text'
  | 'callout';

/** 要就地写字的画线(文字 / 标注气泡):新放的(还没存进文档,id 缺)或改已有的那条 */
type TextDraft = { id?: string; layerId: string; a: DrawingPoint; text: string } & (
  | { kind: 'text'; box: boolean }
  | { kind: 'callout'; b: DrawingPoint }
);
/**
 * 正在图上就地编辑的那条。x / y = 编辑框相对图表容器的像素位置(文字是左上角 = 锚点,气泡是框中心 = b),
 * 打开时算一次(编辑中平移 / 缩放图表会先结束编辑)
 */
export type TextEditing = TextDraft & { x: number; y: number };

type TwoPoint = Extract<Drawing, { kind: 'trend' | 'ray' }>;
/** 两点画的线(趋势线、射线):画法、拖端点、吸附后重合判断都一样,只是渲染时射线往外延伸 */
function isTwoPoint(d: Drawing | undefined): d is TwoPoint {
  return d?.kind === 'trend' || d?.kind === 'ray';
}

/**
 * 按住 / 点两下画出 a→b 的:两点线 + 平行通道(通道第二下之后还要一下定宽度,见 Gesture 的 stage)
 * + 标注气泡(a = 指针尖、b = 框中心,画成后就地写字)
 */
type Creatable = TwoPoint | Extract<Drawing, { kind: 'channel' | 'callout' }>;
function hasAB(d: Drawing | undefined): d is Creatable {
  return isTwoPoint(d) || d?.kind === 'channel' || d?.kind === 'callout';
}

/** 按住 / 点两下画的工具 → 第一下落点处的草稿(其余点先和第一点重合,之后跟着光标改,见 followCursor) */
const START: { [K in Creatable['kind']]: (id: string, p: DrawingPoint) => Extract<Creatable, { kind: K }> } = {
  trend: (id, p) => ({ id, kind: 'trend', a: p, b: p }),
  ray: (id, p) => ({ id, kind: 'ray', a: p, b: p }),
  channel: (id, p) => ({ id, kind: 'channel', a: p, b: p, c: p }),
  callout: (id, p) => ({ id, kind: 'callout', a: p, b: p, text: '' }),
};

/** 画到一半的线跟着光标:定第二点阶段改 b(通道的 c 先跟着 b,平行线和底边重合);通道定宽阶段改 c */
function followCursor(d: Creatable, p: DrawingPoint, stage: 'b' | 'c'): Creatable {
  if (d.kind !== 'channel') return { ...d, b: p };

  return stage === 'c' ? { ...d, c: p } : { ...d, b: p, c: p };
}

/** 锚点变换(扩展点):鼠标落点换算出的锚点交给它再处理一遍(磁吸等插件);不认识具体插件 */
export type TransformPoint = (p: DrawingPoint, ctx: PointCtx) => DrawingPoint;
const IDENTITY: TransformPoint = (p) => p;

export type DrawingActions = {
  addDrawing: (layerId: string, drawing: Drawing) => void;
  updateDrawing: (drawing: Drawing) => void;
  removeDrawing: (id: string) => void;
};

// 按下到松开移动不超过这么多像素,算「点一下」而不是拖
const CLICK_PX = 3;
// 趋势线两点在屏幕上近于这么多像素不画:零长度的线看不见,却占着「全部删除」的条数(用户定)
const MIN_TREND_PX = 4;

type Entry = { drawing: Drawing; layer: Layer; paneIndex: number };
type Draft = { drawing: Drawing; layerId: string };
/** 进行中的手势:画趋势线(第一点已定,第二点跟手)/ 拖一条已有的线(拖哪一部分) */
type Gesture =
  | {
      kind: 'create';
      layerId: string;
      pane: number;
      x0: number;
      y0: number;
      moved: boolean;
      /** 放下第一点的那次按键还没松开:只有这次按键拖动才算「按住拖画线」,之后在轴上 / 侧栏按住拖都不算 */
      pressed: boolean;
      /** 在定哪个点:b = 第二点;c = 通道的宽度(第二点定完、再点一下) */
      stage: 'b' | 'c';
    }
  | {
      kind: 'drag';
      layerId: string;
      pane: number;
      part: Hit['part'];
      orig: Drawing;
      x0: number;
      y0: number;
      moved: boolean;
    };

/** 换算像素要用的:日期 ↔ 下标、下标 ↔ 横坐标、图层 → 它的 series(纵坐标由 series 按自己的轴算,对数 / 倒轴都对) */
type Ctx = {
  axis: TimeAxis;
  toX: (logical: number) => number;
  toLogical: (x: number) => number;
  seriesOf: (layerId: string) => ISeriesApi<SeriesType> | undefined;
  transform: TransformPoint;
};

/**
 * 当前视图的换算。lw-charts 的 logicalToCoordinate 只认整数下标(带小数直接返回 0),
 * 而锚点落在两根之间、空白区时下标是小数 —— 按第 0、1 根的横坐标线性换算(横轴本来就是等距的)
 */
function makeCtx(chart: IChartApi, series: LayerSeries, axis: TimeAxis, transform = IDENTITY): Ctx | null {
  const ts = chart.timeScale();
  const x0 = ts.logicalToCoordinate(0 as Logical);
  const x1 = ts.logicalToCoordinate(1 as Logical);
  if (x0 === null || x1 === null || x1 === x0) return null;

  const bar = x1 - x0;
  // 指标图层在图上是几条子线(id#plot),换算纵坐标用第一条
  const seriesOf = (layerId: string) =>
    series.get(layerId) ?? [...series].find(([k]) => k.startsWith(`${layerId}#`))?.[1];
  return { axis, toX: (l) => x0 + l * bar, toLogical: (x) => (x - x0) / bar, seriesOf, transform };
}

function toPx(ctx: Ctx, s: ISeriesApi<SeriesType>, p: DrawingPoint) {
  const l = ctx.axis.toLogical(p.time);
  const y = s.priceToCoordinate(p.value);
  return l === null || y === null ? null : { x: ctx.toX(l), y };
}

/** 鼠标像素 → 锚点(不过插件):日期取整到天,数值按所属图层的轴 */
function rawPoint(ctx: Ctx, s: ISeriesApi<SeriesType>, x: number, y: number): DrawingPoint | null {
  const time = ctx.axis.toTime(ctx.toLogical(x));
  const value = s.coordinateToPrice(y);
  return time === null || value === null ? null : { time, value };
}

/** 光标所在那一根的数据:线 = 一个值,蜡烛 = 开高低收;没数据(空白区、缺值)= null */
function barAt(ctx: Ctx, s: ISeriesApi<SeriesType>, x: number): BarValues | null {
  const item: object | null = s.dataByIndex(Math.round(ctx.toLogical(x)));
  if (!item || !('time' in item)) return null;

  const nums = (keys: string[]) =>
    keys.map((k) => (item as Record<string, unknown>)[k]).filter((v): v is number => typeof v === 'number');
  const values = 'close' in item ? nums(['open', 'high', 'low', 'close']) : nums(['value']);

  return values.length ? { time: fmtDate(item.time), values } : null;
}

type PointExtra = { anchor: DrawingPoint | null; shift: boolean; onlyTime?: boolean; dragging?: boolean };

/** 鼠标像素 → 锚点,再过锚点变换(插件)。画线工具「鼠标落在哪」一律走这里,不自己换算(见设计文档 §5.3) */
function toPoint(ctx: Ctx, s: ISeriesApi<SeriesType>, x: number, y: number, extra: PointExtra): DrawingPoint | null {
  const raw = rawPoint(ctx, s, x, y);
  return (
    raw &&
    ctx.transform(raw, {
      x,
      y,
      bar: barAt(ctx, s, x),
      toY: (v) => s.priceToCoordinate(v),
      onlyTime: false,
      dragging: false,
      ...extra,
    })
  );
}

/**
 * 画到一半时跟着光标的那一点。气泡的框不过插件:框中心吸到 K 线的价位上没有意义,开着磁吸框会一格格乱跳;
 * 其余照常过插件(anchor = 已定的那一点,Shift 等按它约束)
 */
function followPoint(
  ctx: Ctx,
  s: ISeriesApi<SeriesType>,
  d: Creatable,
  at: { x: number; y: number },
  anchor: DrawingPoint | null,
  shift: boolean,
): DrawingPoint | null {
  return d.kind === 'callout' ? rawPoint(ctx, s, at.x, at.y) : toPoint(ctx, s, at.x, at.y, { anchor, shift });
}

/** 第 i 格此刻要画的像素:趋势线 / 水平线只画在所属图层那一格;竖线延伸的每格都画,只画本格的(paneOnly)只在那一格 */
function paneShapes(ctx: Ctx, entries: Entry[], i: number): Shape[] {
  return entries.flatMap(({ drawing: d, layer, paneIndex }): Shape[] => {
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
    return [{ id: d.id, kind: d.kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
  });
}

/** 正在就地编辑的气泡:按空文字画(框 + 指针),编辑框以同一中心盖在框上;只有指针露在外面 */
function editingCallout(doc: ChartDoc, ed: TextEditing | null): Entry[] {
  const owner = ed?.kind === 'callout' ? findLayer(doc, ed.layerId) : undefined;
  if (ed?.kind !== 'callout' || !owner || owner.layer.hidden) return [];

  const drawing: Drawing = { id: ed.id ?? '', kind: 'callout', a: ed.a, b: ed.b, text: '' };
  return [{ drawing, layer: owner.layer, paneIndex: doc.panes.indexOf(owner.pane) }];
}

/** 要画的画线:所属图层隐藏的不画;拖动 / 画到一半的用草稿替换(新画的那条追加) */
function liveEntries(doc: ChartDoc, draft: Draft | null): Entry[] {
  const base = allDrawings(doc)
    .filter((e) => !e.layer.hidden)
    .map((e) => (draft && e.drawing.id === draft.drawing.id ? { ...e, drawing: draft.drawing } : e));
  if (!draft || base.some((e) => e.drawing.id === draft.drawing.id)) return base;

  const owner = findLayer(doc, draft.layerId);
  const paneIndex = owner ? doc.panes.indexOf(owner.pane) : -1;
  return owner ? [...base, { drawing: draft.drawing, layer: owner.layer, paneIndex }] : base;
}

/** 新画线挂哪条图层:这一格里已选中的那条线(先点选再画),否则这一格第一条看得见的线 */
function pickOwner(doc: ChartDoc, paneIndex: number, selectedLine: string | null): string | undefined {
  const layers = doc.panes[paneIndex]?.layers.filter(canOwnDrawings) ?? [];
  return (layers.find((l) => l.id === selectedLine) ?? layers[0])?.id;
}

/**
 * 拖动中的那条:端点拖到鼠标处,线身整条按像素位移平移(日期轴非等距,先在像素上挪再换回日期)。
 * 拖端点、拖水平 / 竖线过锚点变换(磁吸照常吸);拖趋势线整条不过:两端各吸各的会把线拧歪
 */
function dragged(
  ctx: Ctx,
  s: ISeriesApi<SeriesType>,
  g: Gesture & { kind: 'drag' },
  dx: number,
  dy: number,
  at: { x: number; y: number } | undefined,
  shift: boolean,
) {
  const d = g.orig;
  if (d.kind === 'vline') {
    const l = ctx.axis.toLogical(d.time);
    // 只用日期:点中的格不一定是所属图层那一格,at.y 跟所属格的纵坐标对不上,磁吸也不该看高度
    const p =
      l === null || !at
        ? null
        : toPoint(ctx, s, ctx.toX(l) + dx, at.y, { anchor: null, shift, onlyTime: true, dragging: true });
    return p ? { ...d, time: p.time } : null;
  }
  if (d.kind === 'hline') {
    const y = s.priceToCoordinate(d.value);
    const p = y === null || !at ? null : toPoint(ctx, s, at.x, y + dy, { anchor: null, shift, dragging: true });
    return p ? { ...d, value: p.value } : null;
  }
  // 水平射线 / 文字只有一个点:拖起点、拖线身都是整条挪,照拖端点处理(过插件)
  if (d.kind === 'hray' || d.kind === 'text') {
    const px = toPx(ctx, s, d.a);
    const p = px && toPoint(ctx, s, px.x + dx, px.y + dy, { anchor: null, shift, dragging: true });
    return p ? { ...d, a: p } : null;
  }

  // 整条平移、拖气泡的框不过插件(框中心吸到价位上没有意义,见 followPoint)
  const raw = g.part === 'body' || (d.kind === 'callout' && g.part === 'b');
  const shifted = (p: DrawingPoint, anchor: DrawingPoint | null) => {
    const px = toPx(ctx, s, p);
    if (!px) return null;
    return raw
      ? rawPoint(ctx, s, px.x + dx, px.y + dy)
      : toPoint(ctx, s, px.x + dx, px.y + dy, { anchor, shift, dragging: true });
  };
  // 通道拖宽度手柄:平行线改为穿过光标(按光标那一根过插件;手柄画在平行线中点,第三点却可能在线上任何地方,
  // 按第三点 + 位移取点的话磁吸会吸到别处那根 K 线)
  if (d.kind === 'channel' && g.part === 'c') {
    const c = at && toPoint(ctx, s, at.x, at.y, { anchor: null, shift, dragging: true });
    return c ? { ...d, c } : null;
  }

  // 拖哪个点只动哪个点(另一端当锚点);拖线身全部点一起平移
  const moves = (part: 'a' | 'b') => g.part === 'body' || g.part === part;
  const a = moves('a') ? shifted(d.a, g.part === 'a' ? d.b : null) : d.a;
  const b = moves('b') ? shifted(d.b, g.part === 'b' ? d.a : null) : d.b;
  if (!a || !b) return null;
  if (d.kind !== 'channel') return { ...d, a, b };
  if (g.part === 'body') {
    const c = shifted(d.c, null);
    return c ? { ...d, a, b, c } : null;
  }

  // 拖底边一端:第三点那一处的像素宽度保持不变(同 TradingView 拖角时宽度不变);
  // 第三点不动的话,平行线会绕着这个看不见的点转,宽度时窄时宽
  const [pa, pb, oa, ob, pc] = [a, b, d.a, d.b, d.c].map((p) => toPx(ctx, s, p));
  if (!pa || !pb || !oa || !ob || !pc) return null;
  const width = channelOffset({ x1: oa.x, y1: oa.y, x2: ob.x, y2: ob.y, x3: pc.x, y3: pc.y });
  const value = s.coordinateToPrice(lineYAt({ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }, pc.x) + width);
  return value === null ? null : { ...d, a, b, c: { time: d.c.time, value } };
}

/** 第二点离第一下按下处太近。按鼠标原始位置比,不按换算后的锚点:日期取整到天,放大时相邻两个像素会被拉开成一整天 */
function tooShort(g: { x0: number; y0: number }, e: { clientX: number; clientY: number }): boolean {
  return Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < MIN_TREND_PX;
}

type Pointer = { clientX: number; clientY: number; shift: boolean };
type PreviewState = {
  tool: DrawingTool;
  gesture: Gesture | null;
  draft: Draft | null;
  doc: ChartDoc;
  selectedLine: string | null;
  /** 测量尺还在:量到一半时终点自己就画着;已定住时下一下只会收起它、不会起新的,都不画落点圈 */
  measuring: boolean;
};

/**
 * 落点预览:按「点下去会怎么取锚点」现算(同一格、同一条挂靠线、同样过插件),画成空心圈。
 * 每次重画按最后的鼠标位置现算、不存像素:光标不动而滚轮缩放 / 平移、取消手势、增删格后,圈都跟着当前视图。
 * 画趋势线第二点时锁在第一点那一格(同 onDown 的第二下)
 */
function previewFor(
  el: HTMLElement,
  chart: IChartApi,
  ctx: Ctx,
  st: PreviewState,
  m: Pointer,
): { pane: number; x: number; y: number } | null {
  const { tool, gesture: g } = st;
  if (tool === 'cursor' || g?.kind === 'drag' || st.measuring) return null;

  // 画第二点:锁在第一点那一格、那条线(光标出了格照样跟);否则看光标落在哪一格的绘图区
  const creating = g?.kind === 'create' ? g : null;
  // 气泡的框跟着光标走、不过插件(见 followPoint),框自己就是落点,不再画圈
  if (creating && st.draft?.drawing.kind === 'callout') return null;
  const pane = creating ? creating.pane : paneAt(el, chart, m)?.index;
  if (pane === undefined) return null;
  const at = paneCoords(el, chart, pane, m);
  const layerId = creating ? creating.layerId : pickOwner(st.doc, pane, st.selectedLine);
  const s = layerId && ctx.seriesOf(layerId);
  if (!at || !s) return null;

  const draft = st.draft?.drawing;
  const anchor = creating && hasAB(draft) && creating.stage === 'b' ? draft.a : null;
  const p = toPoint(ctx, s, at.x, at.y, { anchor, shift: m.shift, onlyTime: tool === 'vline' });
  const px = p && toPx(ctx, s, p);

  // 竖线只用日期:圈画在吸附后的那一天、光标的高度
  return px ? { pane, x: px.x, y: tool === 'vline' ? at.y : px.y } : null;
}

/** 测量尺(临时,不存进文档):起点所在那一格、那条线 + 起终点;fixed = 第二下已定住(再点任意处或 Esc 收起) */
type Measure = {
  pane: number;
  layerId: string;
  a: DrawingPoint;
  b: DrawingPoint;
  fixed: boolean;
  /** 起点按下处 + 那次按键是否还按着:按住拖、松手即定住(同画趋势线) */
  x0: number;
  y0: number;
  pressed: boolean;
};

/** 测量框在这一格的像素 + 两行读数(根数按图上的逻辑下标算,周 / 月线就是周 / 月数) */
function measureShape(ctx: Ctx, m: Measure): NonNullable<PaneDrawingState['measure']> | null {
  const s = ctx.seriesOf(m.layerId);
  const pa = s && toPx(ctx, s, m.a);
  const pb = s && toPx(ctx, s, m.b);
  const la = ctx.axis.toLogical(m.a.time);
  const lb = ctx.axis.toLogical(m.b.time);
  if (!pa || !pb || la === null || lb === null) return null;

  const stats = measureStats(m.a, m.b, lb - la);
  return { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, up: stats.delta >= 0, label: measureLabel(stats) };
}

/** 两点完全重合:鼠标隔得够远,但磁吸把两下吸到同一根的同一个值上,画出来是零长度、看不见的线 */
function samePoint(a: DrawingPoint, b: DrawingPoint): boolean {
  return a.time === b.time && a.value === b.value;
}

/**
 * 两点线 / 通道底边画不出方向:两点重合(磁吸把两下吸到同一根同一个值上),或射线 / 通道两点同一天(放大后两下点在同一根里、
 * 关着磁吸) —— 射线会竖着贯穿整张图、通道底边竖着就没有「平行」可言。这类两下当作「太近」,不画、第一点留着。
 * 气泡只怕重合(框盖住尖、指针没了);同一天 = 框在尖的正上 / 正下方,正常
 */
function noDirection(d: Creatable): boolean {
  return samePoint(d.a, d.b) || ((d.kind === 'ray' || d.kind === 'channel') && d.a.time === d.b.time);
}

function redrawAll(prims: Map<IPaneApi<Time>, DrawingsPrimitive>) {
  prims.forEach((p) => {
    p.update();
  });
}

// 输入框里打字、弹层(侧栏的设置浮层、下拉菜单)里按键都不归画线管:弹层自己在 document 冒泡阶段听 Esc 关闭
const POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** 已有的那条文字 / 气泡(拿来就地改);别的画线或已不在文档里就是 null */
function existingText(doc: ChartDoc, id: string): TextDraft | null {
  const entry = allDrawings(doc).find((e) => e.drawing.id === id);
  const d = entry?.drawing;
  if (!entry || !d) return null;

  const base = { id, layerId: entry.layer.id };
  if (d.kind === 'text') return { ...base, kind: 'text', a: d.a, text: d.text, box: !!d.box };
  if (d.kind === 'callout') return { ...base, kind: 'callout', a: d.a, b: d.b, text: d.text };
  return null;
}

/**
 * 编辑框放到屏幕上(相对图表容器;横坐标要加上左轴宽,纵坐标加上所在格的顶边):文字放在锚点,气泡放在框中心;
 * 换算不出就是 null
 */
function placeEditor(el: HTMLElement, chart: IChartApi, ctx: Ctx, doc: ChartDoc, t: TextDraft): TextEditing | null {
  const s = ctx.seriesOf(t.layerId);
  const owner = findLayer(doc, t.layerId);
  const px = s && toPx(ctx, s, t.kind === 'callout' ? t.b : t.a);
  const paneTop = owner
    ? chart.panes()[doc.panes.indexOf(owner.pane)]?.getHTMLElement()?.getBoundingClientRect().top
    : undefined;
  if (!px || paneTop === undefined) return null;

  return { ...t, x: px.x + chart.priceScale('left').width(), y: px.y + paneTop - el.getBoundingClientRect().top };
}

function notOurs(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || !!t.closest(POPUP))
  );
}

export function useDrawings(
  containerRef: RefObject<HTMLDivElement | null>,
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<LayerSeries>,
  selectedLineRef: RefObject<string | null>,
  doc: ChartDoc,
  data: Record<string, LayerData>,
  actions: DrawingActions,
  transformPoint: TransformPoint,
) {
  const [tool, setTool] = useState<DrawingTool>('cursor');
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [editing, setEditing] = useState<TextEditing | null>(null);
  // 选中的那条被删了(删图层、撤掉画线、导入别的图)就不算选中:nextId 可能把同一个 id 发给新画的线;
  // 所属图层被隐藏了也不算:看不见的线别留着浮条、被 Delete 删掉
  const live =
    selected !== null && allDrawings(doc).some((e) => e.drawing.id === selected && !e.layer.hidden) ? selected : null;
  // 真清掉(不只是遮住):所属图层重新显示时,那条别自己又变回选中
  if (selected !== null && live === null) setSelected(null);

  // 以下都只在图元绘制、事件监听里读,不参与渲染
  const docRef = useRef(doc);
  const toolRef = useRef(tool);
  const selectedRef = useRef(live);
  const hiddenRef = useRef(hidden);
  const draftRef = useRef<Draft | null>(null);
  // 正在就地编辑的那条不画在画布上(编辑框盖在原处显示它;气泡按空文字画、编辑框盖在框上,见 editingCallout)
  const editingRef = useRef<TextEditing | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const measureRef = useRef<Measure | null>(null);
  // 鼠标最后在哪(落点预览按它现算);鼠标离开页面 / 窗口失焦就清掉
  const pointerRef = useRef<Pointer | null>(null);
  const axisRef = useRef<TimeAxis>(timeAxis([]));
  const actionsRef = useRef(actions);
  const transformRef = useRef(transformPoint);
  const primsRef = useRef(new Map<IPaneApi<Time>, DrawingsPrimitive>());

  // 下面两个只在文档换了时跑,要拿旧文档(docRef)比对,所以都放在「状态同步」之前(effect 按声明顺序执行)。

  // 画 / 拖到一半时所属图层被别处换掉(导入 JSON、在编辑器中打开、侧栏改了它):草稿是按旧图层取的值,作废
  useEffect(() => {
    const g = gestureRef.current;
    if (g && findLayer(docRef.current, g.layerId)?.layer !== findLayer(doc, g.layerId)?.layer) {
      gestureRef.current = null;
      draftRef.current = null;
    }
  }, [doc]);

  // 测量尺同理:所挂的线被换掉 / 删了、所在的格挪了位(删了上面的格),框会画错格、挂错线,
  // 线不在了还会看不见却截下下一次点击和 Esc —— 收起(随后的状态同步会重画)
  useEffect(() => {
    const m = measureRef.current;
    if (!m) return;

    const owner = findLayer(doc, m.layerId);
    const stale =
      !owner || owner.layer !== findLayer(docRef.current, m.layerId)?.layer || doc.panes.indexOf(owner.pane) !== m.pane;
    if (stale) measureRef.current = null;
  }, [doc]);

  // 状态同步进 ref,并请求重画
  useEffect(() => {
    docRef.current = doc;
    toolRef.current = tool;
    selectedRef.current = live;
    hiddenRef.current = hidden;
    editingRef.current = editing;
    actionsRef.current = actions;
    transformRef.current = transformPoint;
    redrawAll(primsRef.current);
  });

  // 时间轴(日期 ↔ 下标)跟着数据重建。取图上真有的 series 灌进去的点(= lw-charts 时间轴):
  // data 里还有图上不画的(指标的源线只画展开后的子线),算进来下标会整体错位
  useEffect(() => {
    axisRef.current = timeAxis([...seriesRef.current.values()].flatMap((s) => s.data().map((p) => fmtDate(p.time))));
    redrawAll(primsRef.current);
  }, [seriesRef, doc, data]);

  // 每个 lw 格挂上图元(加格后新格要挂,删掉的格丢掉)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const prims = primsRef.current;
    const panes = chart.panes();
    [...prims.keys()]
      .filter((api) => !panes.includes(api))
      .forEach((api) => {
        prims.delete(api);
      });
    panes
      .filter((api) => !prims.has(api))
      .forEach((api) => {
        const prim = new DrawingsPrimitive((): PaneDrawingState => {
          const ctx = makeCtx(chart, seriesRef.current, axisRef.current, transformRef.current);
          const shapes =
            ctx && !hiddenRef.current
              ? paneShapes(
                  ctx,
                  [
                    ...liveEntries(docRef.current, draftRef.current).filter(
                      (e) => e.drawing.id !== editingRef.current?.id,
                    ),
                    ...editingCallout(docRef.current, editingRef.current),
                  ],
                  api.paneIndex(),
                )
              : [];
          const el = containerRef.current;
          const m = pointerRef.current;
          const pv =
            ctx && el && m
              ? previewFor(
                  el,
                  chart,
                  ctx,
                  {
                    tool: toolRef.current,
                    gesture: gestureRef.current,
                    draft: draftRef.current,
                    doc: docRef.current,
                    selectedLine: selectedLineRef.current,
                    measuring: !!measureRef.current,
                  },
                  m,
                )
              : null;
          const ms = measureRef.current;
          const mv = ctx && ms && ms.pane === api.paneIndex() ? measureShape(ctx, ms) : null;
          return {
            shapes,
            selected: selectedRef.current,
            ...(toolRef.current !== 'cursor' && { cursor: 'crosshair' }),
            ...(pv && pv.pane === api.paneIndex() && !hiddenRef.current && { preview: { x: pv.x, y: pv.y } }),
            ...(mv && { measure: mv }),
            ink: { text: CHART_CHROME[getTheme()].ink, bg: CHART_CHROME[getTheme()].bg },
          };
        });
        api.attachPrimitive(prim);
        prims.set(api, prim);
      });
    redrawAll(prims);
  }, [chartRef, seriesRef, containerRef, selectedLineRef, doc]);

  // 指针 / 键盘。在容器的捕获阶段处理:画线 / 抓住画线时截下按键,lw-charts 的平移和选线拖轴(useLineDrag)都收不到
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // lw-charts 听的是 mousedown(在 pointerdown 之后到):接管了这次按键就把随后那个 mousedown 也截掉
    let swallow = false;
    const prims = primsRef.current;

    const ctxNow = () => {
      const chart = chartRef.current;
      return chart ? makeCtx(chart, seriesRef.current, axisRef.current, transformRef.current) : null;
    };
    // id 在提交这一刻按最新文档取(趋势线第一下到第二下之间文档可能变了)
    const finish = (drawing: Drawing, layerId: string) => {
      const id = nextId(docRef.current, 'd');
      actionsRef.current.addDrawing(layerId, { ...drawing, id });
      setSelected(id);
      setTool('cursor');
    };
    /** 通道底边定完:进入定宽阶段,平行线跟着光标,再点一下画成 */
    const toWidthStage = (g: Gesture & { kind: 'create' }, d: Creatable, e: PointerEvent) => {
      g.stage = 'c';
      // 第三下离第二下太近不算(习惯性在第二点上双击,紧跟的那下会画出宽度 0 的通道)
      g.x0 = e.clientX;
      g.y0 = e.clientY;
      g.moved = false;
      g.pressed = false;
      draftRef.current = { drawing: d, layerId: g.layerId };
      redrawAll(prims);
    };
    /** 收起测量尺;从测量工具量的回到光标(同 TradingView:量完一次就退出) */
    const clearMeasure = () => {
      measureRef.current = null;
      if (toolRef.current === 'measure') setTool('cursor');
      redrawAll(prims);
    };
    const cancelGesture = () => {
      gestureRef.current = null;
      draftRef.current = null;
      redrawAll(prims);
    };
    /** 两点定完:气泡先就地打字(回到光标,写完才存进文档,见 commitText),其余直接存 */
    const complete = (d: Creatable, layerId: string) => {
      cancelGesture();
      if (d.kind !== 'callout') return finish(d, layerId);

      const chart = chartRef.current;
      const ctx = ctxNow();
      setTool('cursor');
      if (chart && ctx)
        setEditing(placeEditor(el, chart, ctx, docRef.current, { kind: 'callout', layerId, a: d.a, b: d.b, text: '' }));
    };

    const onDown = (e: PointerEvent) => {
      swallow = false;
      const chart = chartRef.current;
      const ctx = ctxNow();
      const hit = chart && e.button === 0 ? paneAt(el, chart, e) : undefined;
      if (!chart || !ctx || !hit) return;
      const doc = docRef.current;
      const g = gestureRef.current;
      // 不在这里 preventDefault:那会让浏览器不再派发随后的 mousedown,swallow 就清不掉、误吞下一次普通按键
      const take = () => {
        e.stopPropagation();
        swallow = true;
        // 随后的 mousedown 被 preventDefault,焦点不会自己离开输入框:还留在搜索框里的话 Delete / Esc 会被当成打字
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      };

      // 测量尺:已定住 → 这一下收起;量到一半 → 这一下定住(落在起点那一格的坐标系里)
      const m = measureRef.current;
      if (m) {
        take();
        if (m.fixed) return clearMeasure();
        const at = paneCoords(el, chart, m.pane, e);
        const s = ctx.seriesOf(m.layerId);
        const b = at && s && toPoint(ctx, s, at.x, at.y, { anchor: m.a, shift: e.shiftKey });
        measureRef.current = { ...m, b: b ?? m.b, fixed: true, pressed: false };
        redrawAll(prims);
        return;
      }
      // 起一把测量尺:测量工具,或光标工具下按住 Shift 点(同 TradingView)
      if (toolRef.current === 'measure' || (toolRef.current === 'cursor' && e.shiftKey)) {
        const layerId = pickOwner(doc, hit.index, selectedLineRef.current);
        const s = layerId && ctx.seriesOf(layerId);
        const a = s && toPoint(ctx, s, hit.x, hit.y, { anchor: null, shift: false });
        if (!layerId || !a) return;
        take();
        measureRef.current = {
          pane: hit.index,
          layerId,
          a,
          b: a,
          fixed: false,
          x0: e.clientX,
          y0: e.clientY,
          pressed: true,
        };
        redrawAll(prims);
        return;
      }

      // 第二下(通道还有第三下定宽):落在第一点那一格的坐标系里(点到别的格也按那一格算)
      if (g?.kind === 'create') {
        take();
        const at = paneCoords(el, chart, g.pane, e);
        const s = ctx.seriesOf(g.layerId);
        const d = draftRef.current?.drawing;
        const anchor = hasAB(d) && g.stage === 'b' ? d.a : null;
        const p = at && s && hasAB(d) && followPoint(ctx, s, d, at, anchor, e.shiftKey);
        if (!s || !p || !hasAB(d)) return cancelGesture();
        const next = followCursor(d, p, g.stage);
        if (g.stage === 'b') {
          // 两下点得太近(快速点两下 / 点在同一处),或画不出方向(见 noDirection):不画,第一点留着等下一下
          if (tooShort(g, e) || noDirection(next)) return;
          if (next.kind === 'channel') return toWidthStage(g, next, e);
        } else if (tooShort(g, e)) return;
        complete(next, g.layerId);
        return;
      }

      const tool = toolRef.current;
      if (tool !== 'cursor') {
        const layerId = pickOwner(doc, hit.index, selectedLineRef.current);
        const s = layerId && ctx.seriesOf(layerId);
        const p = s && toPoint(ctx, s, hit.x, hit.y, { anchor: null, shift: e.shiftKey, onlyTime: tool === 'vline' });
        if (!layerId || !p) return;
        take();
        const id = nextId(doc, 'd');
        if (tool === 'hline') finish({ id, kind: 'hline', value: p.value }, layerId);
        else if (tool === 'vline') finish({ id, kind: 'vline', time: p.time }, layerId);
        else if (tool === 'hray') finish({ id, kind: 'hray', a: p }, layerId);
        // 文字:就地打开编辑框、回到光标(同 TradingView),写完才存进文档(见 commitText)
        else if (tool === 'text') {
          setTool('cursor');
          setEditing(placeEditor(el, chart, ctx, doc, { kind: 'text', layerId, a: p, text: '', box: false }));
        } else {
          gestureRef.current = {
            kind: 'create',
            layerId,
            pane: hit.index,
            x0: e.clientX,
            y0: e.clientY,
            moved: false,
            pressed: true,
            stage: 'b',
          };
          draftRef.current = { drawing: START[tool](id, p), layerId };
          redrawAll(prims);
        }
        return;
      }

      // 光标:点中画线 = 选中并开始拖;点空白 = 取消选中,照常交给图表
      const entries = hiddenRef.current ? [] : liveEntries(doc, null);
      const h = hitShapes(paneShapes(ctx, entries, hit.index), hit.x, hit.y);
      const entry = h && entries.find((en) => en.drawing.id === h.id);
      if (!h || !entry) {
        setSelected(null);
        return;
      }
      take();
      setSelected(h.id);
      gestureRef.current = {
        kind: 'drag',
        layerId: entry.layer.id,
        pane: hit.index,
        part: h.part,
        orig: entry.drawing,
        x0: e.clientX,
        y0: e.clientY,
        moved: false,
      };
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      // 拖画线时别顺带选中页面文字
      e.preventDefault();
    };

    // 双击落在画线上、或正在用绘图工具(快速点两下画短趋势线):截下,别让 useLineDrag 的双击把这一格纵轴复位(用户定)
    const onDblClick = (e: MouseEvent) => {
      const chart = chartRef.current;
      const ctx = ctxNow();
      const hit = chart ? paneAt(el, chart, e) : undefined;
      if (!chart || !ctx || !hit) return;
      const entries = hiddenRef.current ? [] : liveEntries(docRef.current, null);
      const h = hitShapes(paneShapes(ctx, entries, hit.index), hit.x, hit.y);
      if (toolRef.current !== 'cursor' || h) e.stopPropagation();

      // 双击文字 = 就地改它(监听里读 docRef:闭包里的 doc 是挂监听那次的旧文档)
      const t = toolRef.current === 'cursor' && h ? existingText(docRef.current, h.id) : null;
      if (t) setEditing(placeEditor(el, chart, ctx, docRef.current, t));
    };

    // 记下鼠标位置;绘图工具下请求重画(预览圈在图元里按它现算)
    const trackPointer = (e: PointerEvent) => {
      pointerRef.current = { clientX: e.clientX, clientY: e.clientY, shift: e.shiftKey };
      if (toolRef.current !== 'cursor') redrawAll(prims);
    };
    // 鼠标出了页面 / 切走窗口:那之后收不到 pointermove,不清掉圈会停在最后的位置
    const forgetPointer = () => {
      pointerRef.current = null;
      redrawAll(prims);
    };

    const onMove = (e: PointerEvent) => {
      trackPointer(e);
      const m = measureRef.current;
      if (m && !m.fixed) return followMeasure(m, e);
      const g = gestureRef.current;
      const chart = chartRef.current;
      const ctx = ctxNow();
      const s = g && ctx?.seriesOf(g.layerId);
      if (!g || !chart || !ctx || !s) return;
      const far = Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > CLICK_PX;
      // 「按住拖」才算拖,且必须是手势自己那次按键:点完第一下后松开键移动只是预览,
      // 之后点工具栏 / 在轴上按住拖(那次按键没被截下)松开时都不能把线提交了
      if (far && e.buttons & 1 && (g.kind === 'drag' || g.pressed)) g.moved = true;
      if (!g.moved && g.kind === 'drag') return;

      const at = paneCoords(el, chart, g.pane, e);
      if (g.kind === 'create') {
        const d = draftRef.current;
        const anchor = hasAB(d?.drawing) && g.stage === 'b' ? d.drawing.a : null;
        const p = at && d && hasAB(d.drawing) && followPoint(ctx, s, d.drawing, at, anchor, e.shiftKey);
        if (p && d && hasAB(d.drawing)) draftRef.current = { ...d, drawing: followCursor(d.drawing, p, g.stage) };
      } else {
        const next = dragged(ctx, s, g, e.clientX - g.x0, e.clientY - g.y0, at, e.shiftKey);
        if (next) draftRef.current = { drawing: next, layerId: g.layerId };
      }
      redrawAll(prims);
    };

    /** 测量尺终点跟着光标(起点那一格的坐标系、过插件,磁吸能把终点吸到价位上) */
    const followMeasure = (m: Measure, e: PointerEvent) => {
      const chart = chartRef.current;
      const ctx = ctxNow();
      const s = ctx?.seriesOf(m.layerId);
      const at = chart && paneCoords(el, chart, m.pane, e);
      const b = ctx && s && at && toPoint(ctx, s, at.x, at.y, { anchor: m.a, shift: e.shiftKey });
      if (!b) return;

      measureRef.current = { ...m, b };
      redrawAll(prims);
    };

    const onUp = (e: PointerEvent) => {
      // 测量尺按住拖了一段再松手 = 定住;只是点了一下 = 等第二下
      const m = measureRef.current;
      if (m && !m.fixed && m.pressed) {
        const movedFar = Math.hypot(e.clientX - m.x0, e.clientY - m.y0) > CLICK_PX;
        measureRef.current = { ...m, pressed: false, fixed: movedFar };
        redrawAll(prims);
        return;
      }

      const g = gestureRef.current;
      const d = draftRef.current;
      // 按住拖 = 松手即定下第二点(两点线画完;通道进入定宽,再点一下);只是点了一下 = 等第二下
      if (g?.kind === 'create') {
        g.pressed = false;
        if (!g.moved || g.stage !== 'b') return;
        // 拖回了起点附近 / 画不出方向:同点两下,不画,第一点留着
        if (tooShort(g, e) || (hasAB(d?.drawing) && noDirection(d.drawing))) {
          g.moved = false;
          return;
        }
        if (d?.drawing.kind === 'channel') return toWidthStage(g, d.drawing, e);
        if (d && hasAB(d.drawing)) complete(d.drawing, g.layerId);
        else cancelGesture();
        return;
      }
      if (g?.kind !== 'drag') return;
      cancelGesture();
      // 拖端点拖成画不出方向的(同新画时的规则,见 noDirection):放弃这次拖动,线回原处。
      // 只判拖端点:整条平移不改方向;规则之前画的 / 导入的同一天射线若平移也判,会每次弹回、像拖不动
      const broken = (g.part === 'a' || g.part === 'b') && hasAB(d?.drawing) && noDirection(d.drawing);
      if (g.moved && d && !broken) actionsRef.current.updateDrawing(d.drawing);
    };

    // 在 window 的捕获阶段听:画线这边用掉了这次按键就截下,useLineDrag 的 Esc 不再顺带清掉选中的线
    // (先点选 B 线再画,Esc 取消重画时还挂 B;用户定)。没东西可取消时不截,Esc 照旧去清选中的线
    const onKey = (e: KeyboardEvent) => {
      if (notOurs(e.target)) return;
      const id = selectedRef.current;
      if (e.key === 'Escape') {
        // 先收起测量尺,再取消画到一半 / 拖到一半的(拖动丢掉草稿、线回原处),再退出绘图工具,最后取消选中画线
        if (measureRef.current) clearMeasure();
        else if (gestureRef.current) cancelGesture();
        else if (toolRef.current !== 'cursor') setTool('cursor');
        else if (id) setSelected(null);
        else return;
        e.stopPropagation();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && id && !gestureRef.current) {
        e.preventDefault();
        e.stopPropagation();
        actionsRef.current.removeDrawing(id);
        setSelected(null);
      }
    };

    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('mousedown', onMouseDown, true);
    el.addEventListener('dblclick', onDblClick, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
    document.documentElement.addEventListener('pointerleave', forgetPointer);
    window.addEventListener('blur', forgetPointer);

    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('mousedown', onMouseDown, true);
      el.removeEventListener('dblclick', onDblClick, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey, true);
      document.documentElement.removeEventListener('pointerleave', forgetPointer);
      window.removeEventListener('blur', forgetPointer);
    };
  }, [containerRef, chartRef, seriesRef, selectedLineRef]);

  /** 换工具:取消画到一半的线;选绘图工具时把「全部隐藏」关掉(看不见就画不了) */
  const chooseTool = (t: DrawingTool) => {
    gestureRef.current = null;
    draftRef.current = null;
    measureRef.current = null;
    // 再点一次同一个工具时状态没变、不会重渲染,预览线得自己擦掉
    redrawAll(primsRef.current);
    // 测量不画线、也不受「全部隐藏」影响,别顺手把隐藏的画线翻出来
    if (t !== 'cursor' && t !== 'measure') setHidden(false);
    setTool(t);
  };

  /** 全部隐藏 / 显示;隐藏时取消选中、退回光标(看不见的线别被 Delete 删掉,也别画出看不见的新线) */
  const toggleHidden = () => {
    if (!hidden) {
      setSelected(null);
      chooseTool('cursor');
    }
    setHidden(!hidden);
  };

  /** 浮条「编辑」:就地改这条文字 / 气泡(同双击) */
  const editText = (id: string) => {
    const chart = chartRef.current;
    const el = containerRef.current;
    const ctx = chart && makeCtx(chart, seriesRef.current, axisRef.current, transformRef.current);
    const t = existingText(doc, id);
    if (el && chart && ctx && t) setEditing(placeEditor(el, chart, ctx, doc, t));
  };

  /**
   * 写完(Esc / 点到别处):新放的存进文档,改的覆盖原文,都选中它(同 TradingView)。
   * 空白:新放的不存,已有的改成空白就删掉(TradingView 的空文字取消选中时自动消失)
   */
  const commitText = (text: string) => {
    const ed = editing;
    setEditing(null);
    if (!ed) return;
    // 改已有的:编辑中整份文档被换掉(画线 id 是 d1、d2 这种,新图里很可能有同 id 的另一条),别改到别的线上
    const now = ed.id ? existingText(doc, ed.id) : null;
    if (ed.id && (now?.layerId !== ed.layerId || now?.kind !== ed.kind)) return;
    if (text.trim() === '') {
      if (ed.id) actions.removeDrawing(ed.id);
      return;
    }

    const drawing =
      ed.kind === 'callout'
        ? { kind: 'callout' as const, a: ed.a, b: ed.b, text }
        : { kind: 'text' as const, a: ed.a, text, ...(ed.box && { box: true as const }) };
    const id = ed.id ?? nextId(doc, 'd');
    if (ed.id) actions.updateDrawing({ id, ...drawing });
    else actions.addDrawing(ed.layerId, { id, ...drawing });
    setSelected(id);
  };

  return {
    tool,
    chooseTool,
    selected: live,
    setSelected,
    hidden,
    toggleHidden,
    editing,
    editText,
    commitText,
  };
}
