import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Interval } from '../../hooks/interval';
import { EmptyState } from './EmptyState';
import { LayerList } from './LayerList';
import { Legend } from './Legend';
import { SeriesPicker } from './SeriesPicker';
import { seriesDef } from './registry';
import { useChartDoc } from './useChartDoc';
import { useCrosshairLegend } from './useCrosshairLegend';
import { useEditorChart } from './useEditorChart';
import { useEditorSeriesData } from './useEditorSeriesData';

// 图表编辑页:空白图上自己挑序列、分格叠放。只负责组装 —— 状态见 useChartDoc,取数见 useEditorSeriesData,
// 渲染见 useEditorChart。全部编辑状态就是 doc 这一份 JSON(右下角可查看)。
export function ChartEditorPage({ interval }: { interval: Interval }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { doc, load, toggleSeries, remove, move, setScale, setColor, setStretches } = useChartDoc();
  const [showJson, setShowJson] = useState(false);

  const seriesIds = doc.panes.flatMap((p) => p.layers.map((l) => l.series));
  const { points, isLoading, error, missing } = useEditorSeriesData(seriesIds, interval);
  const { chartRef } = useEditorChart(containerRef, doc, points, { onStretches: setStretches, interval });
  const { hoverTime, layout } = useCrosshairLegend(containerRef, chartRef, doc);

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
          <Legend doc={doc} points={points} hoverTime={hoverTime} layout={layout} />
        )}
        {status.length > 0 && (
          <div className="pointer-events-none absolute right-16 top-1 z-10 rounded bg-neutral-950/80 px-2 py-0.5 text-xs text-amber-400">
            {status.join(' · ')}
          </div>
        )}
      </div>

      {/* 侧栏本身不滚:下拉框要能盖住下面的图层区;只有图层区自己滚 */}
      <aside className="flex w-80 shrink-0 flex-col gap-3 border-l border-neutral-800 pl-3">
        <SeriesPicker used={new Set(seriesIds)} onToggle={toggleSeries} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <LayerList doc={doc} onMove={move} onScale={setScale} onColor={setColor} onRemove={remove} />
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
          {showJson && (
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-neutral-900 p-2 text-[11px] leading-snug text-neutral-400">
              {JSON.stringify(doc, null, 2)}
            </pre>
          )}
        </div>
      </aside>
    </div>
  );
}
