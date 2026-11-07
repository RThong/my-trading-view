import { useRef, useState } from 'react';
import type { Interval } from '../../hooks/interval';
import { type ChartDoc, setLayerHidden, setStretches } from './chartDoc';
import { layerLabel } from './layerLabel';
import { allSevenDay, layerRequest, useLayerData } from './layerPoints';
import { Legend } from './Legend';
import { useCrosshairLegend } from './useCrosshairLegend';
import { useDocChart } from './useDocChart';
import { usePercentileBand } from './usePercentileBand';
import { requestKey, useSeriesData } from './useSeriesData';

// 初始窗口从 2018 起(往左拖还有更早的);模块常量 —— 每次渲染新建对象的话,对准 effect 会跟着依赖变化反复把视图拽回去
const FIT = { from: '2018-01-01' };

// 只读看一份 ChartDoc(固定面板的 regime tab):渲染与图表编辑器同一套(useDocChart / Legend / 分位带),只是没有侧栏和编辑。
// 眼睛按钮、拖分隔条只改本页这份副本,不回写内置 doc、也不存档(刷新即复原)。
export function DocChart({ doc: builtin, interval }: { doc: ChartDoc; interval: Interval }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState(builtin);

  const layers = doc.panes.flatMap((p) => p.layers);
  const sevenDay = allSevenDay(doc);
  const requests = layers.map((l) => layerRequest(l, sevenDay));
  const { points, bars, isLoading, error, missing, stale } = useSeriesData(requests, interval);
  const data = useLayerData(doc, points, interval, bars);
  const { chartRef } = useDocChart(containerRef, doc, data, {
    onStretches: (s) => setDoc((d) => setStretches(d, s)),
    interval,
    fit: FIT,
  });
  const { hoverTime, layout } = useCrosshairLegend(containerRef, chartRef, doc);
  usePercentileBand(chartRef, doc, data);

  // 源这次没拉到、服务端拿上一份顶上的:线照画,但要说明不是最新
  const staleNames = layers.filter((_, i) => stale.includes(requestKey(requests[i]))).map((l) => layerLabel(doc, l));
  // 缺数的也按图例名报(missing 是注册表名,与图例、上一条提示对不上)
  const missingNames = missing.length
    ? layers.filter((_, i) => !points[requestKey(requests[i])]?.length).map((l) => layerLabel(doc, l))
    : [];
  const status = [
    isLoading ? '加载中…' : undefined,
    error ? `取数失败:${error.message}` : undefined,
    missingNames.length ? `暂不可用: ${missingNames.join(', ')}` : undefined,
    staleNames.length ? `源暂时拉不到,沿用上次数据: ${staleNames.join(', ')}` : undefined,
  ].filter((s) => s !== undefined);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      <Legend
        doc={doc}
        interval={interval}
        data={data}
        hoverTime={hoverTime}
        layout={layout}
        onHidden={(id, hidden) => setDoc((d) => setLayerHidden(d, id, hidden))}
      />
      {status.length > 0 && (
        <div className="pointer-events-none absolute right-16 top-1 z-10 rounded bg-neutral-950/80 px-2 py-0.5 text-xs text-amber-400">
          {status.join(' · ')}
        </div>
      )}
    </div>
  );
}
