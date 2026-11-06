// 从「文档 + 取到的序列数据」算出每个图层最终要画的点(平移后的序列)。渲染层与图例只认这里的结果,不再自己拼。
import { useMemo } from 'react';
import type { LinePoint } from '../../../chart/core';
import type { ChartDoc, Layer, Pane } from '../../../views/chartDoc/chartDoc';
import { requestKey } from '../../../views/chartDoc/useSeriesData';

export type LayerData = {
  /** 画在图上的点 */
  display: LinePoint[];
};

const EMPTY: LinePoint[] = [];

export function layerRequest(l: Layer) {
  return { series: l.series, ...(l.calc && { calc: l.calc }), shift: l.shift ?? 0 };
}

export function computeLayerData(doc: ChartDoc, points: Record<string, LinePoint[]>): Record<string, LayerData> {
  return Object.fromEntries(
    doc.panes.flatMap((p) => p.layers).map((l) => [l.id, { display: points[requestKey(layerRequest(l))] ?? EMPTY }]),
  );
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
  return pane.layers
    .filter((l) => l.scale === scaleId && (!l.hidden || fitTargets.has(l.id)))
    .every((l) => (data[l.id]?.display ?? []).every((p) => p.value > 0));
}
