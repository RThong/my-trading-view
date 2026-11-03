import { useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import type { Interval } from '../../hooks/interval';
import { AnalysisPanel, pairRequests, resolvePair } from './AnalysisPanel';
import { EMPTY_DOC } from './chartDoc';
import { EmptyState } from './EmptyState';
import { layerRequest, useLayerData } from './layerPoints';
import { LayerList } from './LayerList';
import { Legend } from './Legend';
import { SeriesPicker } from './SeriesPicker';
import { seriesDef } from './registry';
import { useChartDoc } from './useChartDoc';
import { useCrosshairLegend } from './useCrosshairLegend';
import { useEditorChart } from './useEditorChart';
import { useEditorSeriesData } from './useEditorSeriesData';
import { useBaseBand } from './useBaseBand';
import { useFitSync } from './useFitSync';
import { useLineDrag } from './useLineDrag';
import { useVisibleRange } from './useVisibleRange';

// 图表编辑页:空白图上自己挑序列、分格叠放、把一条线叠到另一条上看劈叉。只负责组装 ——
// 状态见 useChartDoc,取数见 useEditorSeriesData,各图层最终数据见 layerPoints,渲染见 useEditorChart。
// 全部编辑状态就是 doc 这一份 JSON(右下角可查看)。
export function ChartEditorPage({ interval }: { interval: Interval }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const actions = useChartDoc();
  const { doc, load, toggleSeries, setStretches } = actions;
  const [showJson, setShowJson] = useState(false);
  // 分析区选中的 A / B(页面持有:扫描要额外取它们未平移的原序列)
  const [pair, setPair] = useState<{ a?: string; b?: string }>({});

  const seriesLayers = doc.panes.flatMap((p) => p.layers);
  const requests = [...seriesLayers.map(layerRequest), ...pairRequests(resolvePair(doc, pair))];
  const { points, isLoading, error, missing } = useEditorSeriesData(requests, interval);
  const data = useLayerData(doc, points);
  const { chartRef, seriesRef } = useEditorChart(containerRef, doc, data, { onStretches: setStretches, interval });
  const { hoverTime, layout } = useCrosshairLegend(containerRef, chartRef, doc);
  const visibleRange = useVisibleRange(chartRef);
  useLineDrag(containerRef, chartRef, seriesRef, doc);
  useFitSync(chartRef, seriesRef, doc);
  useBaseBand(chartRef, doc, data);

  const empty = doc.panes.length === 0;
  const status = [
    isLoading && !empty ? '加载中…' : undefined,
    error ? `取数失败:${error.message}` : undefined,
    missing.length ? `暂无数据:${missing.map((id) => seriesDef(id)?.label ?? id).join(', ')}` : undefined,
  ].filter((s) => s !== undefined);

  return (
    <div className="flex h-full gap-3">
      <div className="relative min-w-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {empty ? (
          <EmptyState onLoad={load} />
        ) : (
          <Legend doc={doc} interval={interval} data={data} hoverTime={hoverTime} layout={layout} />
        )}
        {status.length > 0 && (
          <div className="pointer-events-none absolute right-16 top-1 z-10 rounded bg-neutral-950/80 px-2 py-0.5 text-xs text-amber-400">
            {status.join(' · ')}
          </div>
        )}
      </div>

      {/* 侧栏本身不滚:下拉框要能盖住下面的图层区;只有图层区自己滚 */}
      <aside className="flex w-80 shrink-0 flex-col gap-3 border-l border-neutral-800 pl-3">
        <SeriesPicker
          used={new Set(seriesLayers.map((l) => l.series))}
          onToggle={toggleSeries}
          onClear={() => load(EMPTY_DOC)}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <LayerList doc={doc} data={data} actions={actions} />
          <AnalysisPanel
            doc={doc}
            points={points}
            visibleRange={visibleRange}
            pair={pair}
            onPair={setPair}
            actions={actions}
          />
        </div>
        <div className="border-t border-neutral-800 pt-2">
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="flex items-center gap-1 px-1 text-xs text-neutral-500 hover:text-neutral-300"
          >
            {showJson ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            查看 JSON
          </button>
          {showJson && <JsonView json={JSON.stringify(doc, null, 2)} />}
        </div>
      </aside>
    </div>
  );
}

// JSON 原文 + 右上角复制按钮(复制后对勾停留 1.5 秒)
function JsonView({ json }: { json: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  return (
    <div className="relative mt-1">
      <button
        type="button"
        onClick={copy}
        className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? '已复制' : '复制'}
      </button>
      <pre className="max-h-72 overflow-auto rounded bg-neutral-900 p-2 text-[11px] leading-snug text-neutral-400">
        {json}
      </pre>
    </div>
  );
}
