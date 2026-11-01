// 从「文档 + 取到的序列数据」算出每个图层最终要画的点:平移后的序列、参照期换算后的线、
// 滚动相关性、劈叉幅度。渲染层与图例只认这里的结果,不再自己拼。
import { useMemo } from 'react';
import type { LinePoint } from '../../lib/chart';
import { applyFit, fitParams, gapPoints, rollingCorr, type FitParams } from './analysis';
import { isSeriesLayer, type ChartDoc, type Pane, type SeriesLayer } from './chartDoc';
import { requestKey } from './useEditorSeriesData';

export type LayerData = {
  /** 画在图上的点 */
  display: LinePoint[];
  /** 图例读数用的点:换算过的线读原始值(换算值没有物理意义),其余同 display */
  raw: LinePoint[];
  /** 带 fit 的图层:参照期算出的比例;参照期样本不够 → null */
  fit?: FitParams | null;
};

const EMPTY: LinePoint[] = [];

export const layerRequest = (l: SeriesLayer) => ({ series: l.series, shift: l.shift ?? 0 });

// 两个输入数组 + 参数串 → 结果的缓存。按数组引用做键(WeakMap,数组换了自然失效、可回收):
// 改色 / 换格 / 调顺序时文档变了但输入数据没变,派生结果要保持同一个引用,渲染层才不会整段重灌。
const cache = new WeakMap<LinePoint[], WeakMap<LinePoint[], Map<string, unknown>>>();
function memo2<T>(a: LinePoint[], b: LinePoint[], key: string, compute: () => T): T {
  const byA = cache.get(a) ?? new WeakMap<LinePoint[], Map<string, unknown>>();
  cache.set(a, byA);
  const byB = byA.get(b) ?? new Map<string, unknown>();
  byA.set(b, byB);
  if (!byB.has(key)) byB.set(key, compute());

  return byB.get(key) as T;
}

type Fitted = { params: FitParams | null; points: LinePoint[] };

export function computeLayerData(doc: ChartDoc, points: Record<string, LinePoint[]>): Record<string, LayerData> {
  const layers = doc.panes.flatMap((p) => p.layers);
  const seriesById = new Map(layers.filter(isSeriesLayer).map((l) => [l.id, l]));
  const base = (id: string) => {
    const l = seriesById.get(id);
    return (l && points[requestKey(layerRequest(l))]) || EMPTY;
  };
  // 带 fit 的图层换算结果(劈叉格也要用,只算一次)
  const fitted = (l: SeriesLayer): Fitted | undefined => {
    if (!l.fit) return undefined;
    const { target, start, end } = l.fit;
    return memo2(base(target), base(l.id), `fit|${start}|${end}`, () => {
      const params = fitParams(base(target), base(l.id), start, end);
      return { params, points: params ? applyFit(base(l.id), params) : EMPTY };
    });
  };

  return Object.fromEntries(
    layers.map((l): [string, LayerData] => {
      if (isSeriesLayer(l)) {
        const f = fitted(l);
        // 参照期样本不足(params 为 null)就按原线画,别让线消失;卡片上会提示没换算
        const display = f?.params ? f.points : base(l.id);
        return [l.id, f ? { display, raw: base(l.id), fit: f.params } : { display, raw: base(l.id) }];
      }

      const st = l.study;
      if (st.kind === 'corr') {
        const key = `corr|${st.window}|${st.mode}|${st.horizon}`;
        const corr = memo2(base(st.a), base(st.b), key, () =>
          rollingCorr(base(st.a), base(st.b), st.window, st.mode, st.horizon),
        );
        return [l.id, { display: corr, raw: corr }];
      }

      const of = seriesById.get(st.of);
      const f = of && fitted(of);
      const gap =
        of?.fit && f
          ? memo2(base(of.fit.target), f.points, 'gap', () => gapPoints(base(of.fit!.target), f.points))
          : EMPTY;
      return [l.id, { display: gap, raw: gap }];
    }),
  );
}

/** 文档或数据变了才重算;各图层结果内部按输入缓存,未变的图层保持原引用。 */
export function useLayerData(doc: ChartDoc, points: Record<string, LinePoint[]>): Record<string, LayerData> {
  return useMemo(() => computeLayerData(doc, points), [doc, points]);
}

/** 这根轴能不能取对数:挂在上面的图层(画出来的值)全都大于 0。还没数据的图层不算阻碍。 */
export const canLogScale = (pane: Pane, scaleId: string, data: Record<string, LayerData>): boolean =>
  pane.layers.filter((l) => l.scale === scaleId).every((l) => (data[l.id]?.display ?? []).every((p) => p.value > 0));
