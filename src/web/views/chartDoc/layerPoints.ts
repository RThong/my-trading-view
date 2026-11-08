// 从「文档 + 取到的序列数据」算出每个图层最终要画的点(平移后的序列)。渲染层与图例只认这里的结果,不再自己拼。
import { useMemo } from 'react';
import { aggregateMax, type Bar, type LinePoint } from '../../chart/core';
import type { Interval } from '../../hooks/interval';
import { earliestIso } from '../../../shared/calc/isoDate';
import { shiftBusinessDays } from '../../chart/analysis';
import { type BandPoint, percentileMarks } from '../../chart/percentileMarks';
import { INDICATORS, periodsOf, type PlotSpec } from '../../chart/indicatorDefs';
import { isMarkLayer, type ChartDoc, type Layer, type Pane, type RefLine } from './chartDoc';
import { drawnKind, seriesDef } from './registry';
import { requestKey } from './useSeriesData';

export type LayerData = {
  /** 画在图上的点(蜡烛图层是收盘:图例、分位、对准横轴都读它) */
  display: LinePoint[];
  /** 蜡烛图层的 K 线 */
  bars?: Bar[];
};

const EMPTY: LinePoint[] = [];

// ── 指标图层:展开成普通子线(id = 图层 id#样名)。渲染层只画展开后的,改色 / 换轴 / 显隐的对账全部复用;
// 图例按原图层分组(一个指标一行)。子线不进 JSON,只在内存里
export function plotId(l: Layer, p: PlotSpec): string {
  return `${l.id}#${p.key}`;
}

/** 渲染用文档里的指标子线(id 带 #;用户的图层 id 由 nextId 生成,不含 #) */
export function isPlotLayer(l: Layer): boolean {
  return l.id.includes('#');
}

/**
 * 指标画哪几样(与数据无关)。sevenDay = 整张图都是 7×24(见 allSevenDay):这时 EMA 默认那组才带 365 年线 ——
 * 混了工作日序列的图会去掉 BTC 的周末,365 根就成了约 1.45 年、不是年线了(用户定:混合图不自动带)
 */
export function plotsOf(l: Layer, sevenDay: boolean): PlotSpec[] {
  if (!l.indicator) return [];
  const { id, periods } = l.indicator;
  return INDICATORS[id].plots(periodsOf(id, periods, sevenDay));
}

function expandLayer(l: Layer, sevenDay: boolean): Layer[] {
  if (!l.indicator) return [l];
  return plotsOf(l, sevenDay).map((p) => ({
    id: plotId(l, p),
    series: l.series,
    scale: l.scale,
    color: p.color,
    title: p.title,
    ...(p.kind === 'signed' && { render: { kind: 'signed' as const } }),
    ...(l.hidden && { hidden: true as const }),
  }));
}

// 同一份文档展开一次:渲染层的 effect 按引用判断文档变没变,每次新展开一份会让它们白跑
const expanded = new WeakMap<ChartDoc, ChartDoc>();
/** 渲染用的文档:指标图层换成它的各条子线,其余原样 */
export function expandIndicators(doc: ChartDoc): ChartDoc {
  const hit = expanded.get(doc);
  if (hit) return hit;

  const out = doc.panes.some((p) => p.layers.some((l) => l.indicator))
    ? {
        ...doc,
        panes: doc.panes.map((p) => ({ ...p, layers: p.layers.flatMap((l) => expandLayer(l, allSevenDay(doc))) })),
      }
    : doc;
  expanded.set(doc, out);
  return out;
}

// 指标结果按「源序列的点 × 指标签名」缓存:同一条现货上同时有 EMA 和布林带(期权页就是)各存各的,
// 切眼睛、改色时不重算、子线不重灌
const computed = new WeakMap<LinePoint[], Map<string, LinePoint[][]>>();
function indicatorPoints(l: Layer, pts: LinePoint[], daily: boolean, sevenDay: boolean): LinePoint[][] {
  const { id, periods } = l.indicator!;
  const sig = JSON.stringify([id, periods, sevenDay, daily]);
  const bySig = computed.get(pts) ?? new Map<string, LinePoint[][]>();
  computed.set(pts, bySig);
  const hit = bySig.get(sig);
  if (hit) return hit;

  const out = INDICATORS[id].compute(pts, periodsOf(id, periods, sevenDay), { daily, autoYear: sevenDay && !periods });
  bySig.set(sig, out);
  return out;
}
// 取不到 K 线时给同一个空数组:渲染层按引用判断要不要重灌,每次新建 [] 会让蜡烛图层随每次文档改动 setData([])
const EMPTY_BARS: Bar[] = [];

// 标记图层裁剪的结果按「原数组 + 起点」缓存:文档每改一次(改色、拖分隔条)都会重算 computeLayerData,
// 不缓存的话 filter 每次给新数组,渲染层按引用判断「数据变了」,标记图层整段重灌
const clipped = new WeakMap<LinePoint[], { from: string; out: LinePoint[] }>();
function clipFrom(pts: LinePoint[], from: string | undefined): LinePoint[] {
  if (!from || !pts.length || pts[0].time >= from) return pts;
  const hit = clipped.get(pts);
  if (hit?.from === from) return hit.out;

  const out = pts.filter((p) => p.time >= from);
  clipped.set(pts, { from, out });
  return out;
}

// 标记图层按周期取最大值的结果,按「日线原数组 + 周期」缓存(理由同 clipFrom)
const maxed = new WeakMap<LinePoint[], { interval: Interval; out: LinePoint[] }>();
function periodMax(pts: LinePoint[], interval: Interval): LinePoint[] {
  const hit = maxed.get(pts);
  if (hit?.interval === interval) return hit.out;

  const out = aggregateMax(pts, interval);
  maxed.set(pts, { interval, out });
  return out;
}

/**
 * 整张图的线(含计算图层的第二条腿)都是 7×24 序列(BTC、GPU 租赁价这类周末也有数的):取数时保留周末。
 * 混了工作日序列才去周末 —— 共用一条时间轴,周末点会让工作日序列在周六日留空档;全是 7×24 时去掉反而丢了真实读数
 * (周 / 月线也会从周日收盘变成周五收盘)。只认注册表静态标的 weekends;Yahoo 任意代码要拿到数据才知道,不算
 */
export function allSevenDay(doc: ChartDoc): boolean {
  const ids = doc.panes.flatMap((p) => p.layers.flatMap((l) => [l.series, ...(l.calc ? [l.calc.series] : [])]));
  return ids.length > 0 && ids.every((id) => seriesDef(id)?.weekends);
}

/**
 * 图层的取数请求。标记图层(竖线、背景)取不聚合的日线,自己按周期处理(见 computeLayerData):
 * 默认聚合取每期最后一天,周 / 月线下会漏掉期中出现过的事件。
 * sevenDay:整张图都是 7×24(见 allSevenDay),保留周末。同一张图的所有请求要传同一个值,点按请求键对回图层
 */
export function layerRequest(l: Layer, sevenDay = false) {
  return {
    series: l.series,
    ...(l.calc && { calc: l.calc }),
    shift: l.shift ?? 0,
    ...(isMarkLayer(l) && { daily: true as const }),
    // 蜡烛图层多要一份 K 线(按 drawnKind:写了 candle 却画不了的按折线取)
    ...(drawnKind(l) === 'candle' && { bars: true as const }),
    ...(sevenDay && { weekends: true as const }),
  };
}

export function computeLayerData(
  doc: ChartDoc,
  points: Record<string, LinePoint[]>,
  interval: Interval,
  bars: Record<string, Bar[]> = {},
): Record<string, LayerData> {
  const sevenDay = allSevenDay(doc);
  const raw = (l: Layer) => points[requestKey(layerRequest(l, sevenDay))] ?? EMPTY;
  // 标记图层(竖线、色带)裁到本格线最早的起点:比线早开始的话,时间轴会给那段只有竖线的日子留位置,把线挤到一边;
  // 按格算不按整张图:别格的长历史线不该让短历史那格在没数据的地方也画满竖线(同旧固定面板)
  const paneStart = (p: Pane) => {
    const starts = p.layers
      .filter((l) => !isMarkLayer(l))
      .flatMap((l) =>
        raw(l)
          .slice(0, 1)
          .map((pt) => pt.time),
      );
    return starts.length ? earliestIso(starts) : undefined;
  };

  // 事件竖线按周期取最大值 =「这一期里出现过就标上」。背景色带只在日线画:状态(如错月)比周还细,
  // 按期标的话错月这种每月都有一段的状态在月线下整格染满、周线下过半的周都标上,读不出东西(2026-11-07 用户定)
  const display = (l: Layer, from: string | undefined) => {
    if (!isMarkLayer(l)) return raw(l);
    if (drawnKind(l) === 'background' && interval !== '1D') return EMPTY;
    return clipFrom(periodMax(raw(l), interval), from);
  };
  const candle = (l: Layer) =>
    drawnKind(l) === 'candle' ? { bars: bars[requestKey(layerRequest(l, sevenDay))] ?? EMPTY_BARS } : {};

  // 指标图层:源序列的点照给(图例取不到子线时兜底),每条子线另给一份算好的点
  const plotData = (l: Layer) => {
    const out = indicatorPoints(l, raw(l), interval === '1D', sevenDay);
    return plotsOf(l, sevenDay).map((p, i) => [plotId(l, p), { display: out[i] ?? EMPTY }] as const);
  };

  return Object.fromEntries(
    doc.panes.flatMap((p) => {
      const from = paneStart(p);
      return p.layers.flatMap((l) => [
        [l.id, { display: display(l, from), ...candle(l) }] as const,
        ...(l.indicator ? plotData(l) : []),
      ]);
    }),
  );
}

/** 文档或数据变了才重算。 */
export function useLayerData(
  doc: ChartDoc,
  points: Record<string, LinePoint[]>,
  interval: Interval,
  bars: Record<string, Bar[]>,
): Record<string, LayerData> {
  return useMemo(() => computeLayerData(doc, points, interval, bars), [doc, points, interval, bars]);
}

/**
 * 这根轴能不能取对数:挂在上面的图层(画出来的值)全都大于 0,且轴的下限框不把范围撑到 ≤0。
 * 还没数据的图层不算阻碍;隐藏的也不算 —— 除非它是被叠加的 A,那条照样撑轴(见 useDocChart)。
 */
export function canLogScale(pane: Pane, scaleId: string, data: Record<string, LayerData>): boolean {
  const expand = pane.scales.find((sc) => sc.id === scaleId)?.expandVisibleTo;
  if (expand && expand[0] <= 0) return false;

  const fitTargets = new Set(pane.layers.flatMap((l) => (l.fit ? [l.fit.target] : [])));
  // 指标图层画的是子线:看子线算出来的值(MACD 柱、穿 0 序列上的 RSI 有 ≤0 的值),不看源序列。
  // 渲染层传的是展开后的格(子线自带数据),编辑器侧栏传的是原格,两边结论要一致
  const values = (l: Layer) =>
    l.indicator
      ? Object.entries(data).flatMap(([id, d]) => (id.startsWith(`${l.id}#`) ? d.display : []))
      : (data[l.id]?.display ?? []);
  // 标记图层挂自己的隐形轴,不在这根轴上
  return pane.layers
    .filter((l) => l.scale === scaleId && !isMarkLayer(l) && (!l.hidden || fitTargets.has(l.id)))
    .every((l) => values(l).every((p) => p.value > 0));
}

/** 一个图层要画的水平线和背景带;window = 算分位用的那段值(图例的分位排名徽标也按它排),没配分位为 null */
export type LayerMarks = { lines: RefLine[]; band: BandPoint[] | null; window: number[] | null };

// 同一图层对象 + 同一份点只算一次:价位线和背景带两处都要它;文档改了别处(改色、拖分隔条)时没动的图层对象不变,直接复用
const marksCache = new WeakMap<Layer, { pts: LinePoint[]; marks: LayerMarks }>();

/**
 * 图层的水平线(基线、参考线、分位 P5 / P95)与分位背景带。分位规则(参考线优先、riskTail 定染色)在 chart/percentileMarks,
 * 这里定口径(编辑器与固定面板同一套):
 * - 阈值按画在图上的点算(周 / 月线是聚合点),同 TradingView 指标默认跟随图表周期
 * - since 比的是平移前的日期(画在图上的日期已按 shift 挪过)
 * - 符号柱恒有一条 0 线(同固定面板)
 */
export function layerMarks(layer: Layer, pts: LinePoint[]): LayerMarks {
  const hit = marksCache.get(layer);
  if (hit?.pts === pts) return hit.marks;

  const marks = computeMarks(layer, pts);
  marksCache.set(layer, { pts, marks });
  return marks;
}

function computeMarks(layer: Layer, pts: LinePoint[]): LayerMarks {
  const render = layer.render;
  const baseline = render?.kind === 'signed' ? 0 : render?.kind === 'line' ? render.baseline : undefined;
  const base: RefLine[] = baseline !== undefined ? [{ price: baseline, title: String(baseline) }] : [];
  const pctl = layer.percentile;
  if (!pctl) return { lines: [...base, ...(layer.refLines ?? [])], band: null, window: null };

  const since = pctl.since;
  const shift = layer.shift ?? 0;
  const window = (since ? pts.filter((p) => (shift ? shiftBusinessDays(p.time, -shift) : p.time) >= since) : pts).map(
    (p) => p.value,
  );
  const marks = percentileMarks(window, pts, { riskTail: pctl.riskTail, refLines: layer.refLines });

  return { lines: [...base, ...(marks?.lines ?? layer.refLines ?? [])], band: marks?.band ?? null, window };
}
