// 从「文档 + 取到的序列数据」算出每个图层最终要画的点(平移后的序列)。渲染层与图例只认这里的结果,不再自己拼。
import { useMemo } from 'react';
import type { LinePoint } from '../../../chart/core';
import { earliestIso } from '../../../../shared/calc/isoDate';
import { isEventsLayer, type ChartDoc, type Layer, type Pane } from '../../../views/chartDoc/chartDoc';
import { requestKey } from '../../../views/chartDoc/useSeriesData';

export type LayerData = {
  /** 画在图上的点 */
  display: LinePoint[];
};

const EMPTY: LinePoint[] = [];

// 竖线裁剪的结果按「原数组 + 起点」缓存:文档每改一次(改色、拖分隔条)都会重算 computeLayerData,
// 不缓存的话 filter 每次给新数组,渲染层按引用判断「数据变了」,竖线整段重灌
const clipped = new WeakMap<LinePoint[], { from: string; out: LinePoint[] }>();
function clipFrom(pts: LinePoint[], from: string | undefined): LinePoint[] {
  if (!from || !pts.length || pts[0].time >= from) return pts;
  const hit = clipped.get(pts);
  if (hit?.from === from) return hit.out;

  const out = pts.filter((p) => p.time >= from);
  clipped.set(pts, { from, out });
  return out;
}

export function layerRequest(l: Layer) {
  return { series: l.series, ...(l.calc && { calc: l.calc }), shift: l.shift ?? 0 };
}

export function computeLayerData(doc: ChartDoc, points: Record<string, LinePoint[]>): Record<string, LayerData> {
  const layers = doc.panes.flatMap((p) => p.layers);
  const raw = (l: Layer) => points[requestKey(layerRequest(l))] ?? EMPTY;
  // 事件竖线裁到其它线最早的起点:竖线比线早开始的话,时间轴会给那段只有竖线的日子留位置,把线挤到一边
  const starts = layers
    .filter((l) => !isEventsLayer(l))
    .flatMap((l) =>
      raw(l)
        .slice(0, 1)
        .map((p) => p.time),
    );
  const from = starts.length ? earliestIso(starts) : undefined;

  return Object.fromEntries(layers.map((l) => [l.id, { display: isEventsLayer(l) ? clipFrom(raw(l), from) : raw(l) }]));
}

/** 文档或数据变了才重算。 */
export function useLayerData(doc: ChartDoc, points: Record<string, LinePoint[]>): Record<string, LayerData> {
  return useMemo(() => computeLayerData(doc, points), [doc, points]);
}

/**
 * 这根轴能不能取对数:挂在上面的图层(画出来的值)全都大于 0,且轴的下限框不把范围撑到 ≤0。
 * 还没数据的图层不算阻碍;隐藏的也不算 —— 除非它是被叠加的 A,那条照样撑轴(见 useEditorChart)。
 */
export function canLogScale(pane: Pane, scaleId: string, data: Record<string, LayerData>): boolean {
  const expand = pane.scales.find((sc) => sc.id === scaleId)?.expandVisibleTo;
  if (expand && expand[0] <= 0) return false;

  const fitTargets = new Set(pane.layers.flatMap((l) => (l.fit ? [l.fit.target] : [])));
  // 事件竖线挂自己的隐形轴,不在这根轴上
  return pane.layers
    .filter((l) => l.scale === scaleId && !isEventsLayer(l) && (!l.hidden || fitTargets.has(l.id)))
    .every((l) => (data[l.id]?.display ?? []).every((p) => p.value > 0));
}
