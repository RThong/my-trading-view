import { useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, PanelRightClose, PanelRightOpen, Upload } from 'lucide-react';
import type { Interval } from '../../hooks/interval';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { AnalysisPanel, pairRequests, resolvePair } from './components/AnalysisPanel';
import { type ChartDoc, EMPTY_DOC, parseChartDoc } from '../../views/chartDoc/chartDoc';
import { EmptyState } from './components/EmptyState';
import { layerRequest, useLayerData } from './hooks/layerPoints';
import { LayerList } from './components/LayerList';
import { Legend } from './components/Legend';
import { SeriesPicker } from './components/SeriesPicker';
import { useChartDoc } from './hooks/useChartDoc';
import { useCrosshairLegend } from './hooks/useCrosshairLegend';
import { useEditorChart } from './hooks/useEditorChart';
import { useSeriesData } from '../../views/chartDoc/useSeriesData';
import { useBaseBand } from './hooks/useBaseBand';
import { useFitSync } from './hooks/useFitSync';
import { useLineDrag } from './hooks/useLineDrag';
import { useSidebar } from './hooks/useSidebar';
import { useVisibleRange } from './hooks/useVisibleRange';

// 图表编辑页:空白图上自己挑序列、分格叠放、把一条线叠到另一条上看劈叉。只负责组装 ——
// 状态见 useChartDoc,取数见 views/chartDoc/useSeriesData,各图层最终数据见 layerPoints,渲染见 useEditorChart。
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
  const { points, isLoading, error, missing } = useSeriesData(requests, interval);
  const data = useLayerData(doc, points);
  const { chartRef, seriesRef } = useEditorChart(containerRef, doc, data, { onStretches: setStretches, interval });
  const { hoverTime, layout } = useCrosshairLegend(containerRef, chartRef, doc);
  const visibleRange = useVisibleRange(chartRef);
  useLineDrag(containerRef, chartRef, seriesRef, doc);
  useFitSync(chartRef, seriesRef, doc);
  useBaseBand(chartRef, doc, data);

  const empty = doc.panes.length === 0;
  // 空图时不给收起按钮,侧栏强制展开(见 useSidebar)
  const sidebar = useSidebar(empty);
  const status = [
    isLoading && !empty ? '加载中…' : undefined,
    error ? `取数失败:${error.message}` : undefined,
    missing.length ? `暂无数据:${missing.join(', ')}` : undefined,
  ].filter((s) => s !== undefined);

  return (
    <div className="flex h-full gap-3">
      <div className="relative min-w-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {empty ? (
          <EmptyState onLoad={load} />
        ) : (
          <Legend
            doc={doc}
            interval={interval}
            data={data}
            hoverTime={hoverTime}
            layout={layout}
            onHidden={actions.setHidden}
          />
        )}
        {status.length > 0 && (
          <div className="pointer-events-none absolute right-16 top-1 z-10 rounded bg-neutral-950/80 px-2 py-0.5 text-xs text-amber-400">
            {status.join(' · ')}
          </div>
        )}
        {/* 放在价格轴与时间轴交汇的右下角小方格里(lw-charts 那里不画东西),不另占一列宽度;
            放右上角会压住价格轴最上面的刻度。展开 / 收起都在同一个位置 */}
        {!empty && (
          <Button
            variant="ghost"
            // 方格高 = 时间轴高 28px,按钮取同高
            size="icon-sm"
            onClick={sidebar.toggle}
            className="absolute right-1 bottom-0 z-10 text-neutral-500 hover:text-neutral-200"
            title={sidebar.open ? '收起操作区' : '展开操作区'}
          >
            {sidebar.open ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        )}
      </div>

      {/* 侧栏本身不滚:下拉框要能盖住下面的图层区;只有图层区自己滚。
          收起用 hidden 而不卸载:导入 JSON 写了一半、卡片上选了一半的计算都还在 */}
      <aside
        className={`${sidebar.open ? 'flex' : 'hidden'} w-80 shrink-0 flex-col gap-3 border-l border-neutral-800 pl-3`}
      >
        <SeriesPicker
          // 计算图层(A − B)不进标签:标签代表「这条序列在图上」,勾掉 A 不该连带删掉 A − B
          selected={seriesLayers.filter((l) => !l.calc).map((l) => ({ series: l.series, color: l.color }))}
          canClear={seriesLayers.length > 0}
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
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowJson((v) => !v)}
            className="text-neutral-500 hover:text-neutral-300"
          >
            {showJson ? <ChevronDown /> : <ChevronRight />}
            查看 JSON
          </Button>
          {showJson && <JsonView json={JSON.stringify(doc, null, 2)} onLoad={load} />}
        </div>
      </aside>
    </div>
  );
}

// 「复制 / 导入」浮在 JSON 原文上:实心底色,不然下面的字透上来
const JSON_BTN = 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800';

// JSON 原文 + 右上角「复制 / 导入」。导入 = 粘贴一份 JSON 整张图换成它;校验不过就报原因、当前的图不动。
function JsonView({ json, onLoad }: { json: string; onLoad: (doc: ChartDoc) => void }) {
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = () =>
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const cancel = () => {
    setDraft(null);
    setError(null);
  };
  const load = () => {
    let raw: unknown;
    try {
      raw = JSON.parse(draft ?? '');
    } catch {
      return setError('不是合法的 JSON(多半是没复制完整)');
    }
    const doc = parseChartDoc(raw);
    if (!doc) return setError('JSON 结构不对:不是图表编辑器复制出来的,或字段不合法(旧版本复制的叠加信息也认不了)');
    onLoad(doc);
    cancel();
  };

  if (draft !== null) {
    return (
      <div className="mt-1 flex flex-col gap-1.5">
        <Textarea
          // 点「导入」就是要马上粘贴,直接聚焦
          autoFocus
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder="把复制的图表 JSON 粘贴到这里"
          className="h-56 resize-none rounded bg-neutral-900 p-2 font-mono text-[11px] leading-snug text-neutral-300"
        />
        {error && <p className="text-xs text-amber-500">{error}</p>}
        <div className="flex justify-end gap-1.5">
          <Button variant="outline" size="2xs" className={JSON_BTN} onClick={cancel}>
            取消
          </Button>
          <Button variant="outline" size="2xs" className={JSON_BTN} onClick={load} disabled={!draft.trim()}>
            <Upload />
            载入
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative mt-1">
      <div className="absolute right-1.5 top-1.5 flex gap-1">
        <Button
          variant="outline"
          size="2xs"
          className={JSON_BTN}
          onClick={() => setDraft('')}
          title="粘贴一份 JSON,整张图换成它"
        >
          <Upload />
          导入
        </Button>
        <Button variant="outline" size="2xs" className={JSON_BTN} onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-neutral-900 p-2 text-[11px] leading-snug text-neutral-400">
        {json}
      </pre>
    </div>
  );
}
