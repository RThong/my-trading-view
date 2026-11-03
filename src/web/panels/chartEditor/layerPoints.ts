// 从「文档 + 取到的序列数据」算出每个图层最终要画的点(平移后的序列)。渲染层与图例只认这里的结果,不再自己拼。
import { useMemo } from 'react';
import type { LinePoint } from '../../lib/chart';
import type { ChartDoc, Layer, Pane } from './chartDoc';
import { requestKey } from './useEditorSeriesData';

export type LayerData = {
  /** 画在图上的点 */
  display: LinePoint[];
};

const EMPTY: LinePoint[] = [];

export const layerRequest = (l: Layer) => ({ series: l.series, shift: l.shift ?? 0 });

export const computeLayerData = (doc: ChartDoc, points: Record<string, LinePoint[]>): Record<string, LayerData> =>
  Object.fromEntries(
    doc.panes.flatMap((p) => p.layers).map((l) => [l.id, { display: points[requestKey(layerRequest(l))] ?? EMPTY }]),
  );

/** 文档或数据变了才重算。 */
export function useLayerData(doc: ChartDoc, points: Record<string, LinePoint[]>): Record<string, LayerData> {
  return useMemo(() => computeLayerData(doc, points), [doc, points]);
}

/** 这根轴能不能取对数:挂在上面的图层(画出来的值)全都大于 0。还没数据的图层不算阻碍。 */
export const canLogScale = (pane: Pane, scaleId: string, data: Record<string, LayerData>): boolean =>
  pane.layers.filter((l) => l.scale === scaleId).every((l) => (data[l.id]?.display ?? []).every((p) => p.value > 0));
