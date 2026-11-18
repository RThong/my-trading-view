// 出图页(/render#doc=…):只画一张图、不带侧栏和工具栏,数据到齐后用编辑器「导出图片」同一套代码(docSnapshot)拼出 PNG,
// 挂到 window.__render 上交给命令行(scripts/render-chart.ts 用无界面浏览器打开这一页、等它、写成文件)。
// 渲染与编辑器同一套:useDocChart + 画线 + 叠加对齐 + 基准段 + 分位带,所以命令行出的图和编辑器里点导出的一模一样
import { useEffect, useMemo, useRef } from 'react';
import type { Interval } from '../../hooks/interval';
import { CHART_CHROME, useTheme } from '../../hooks/theme';
import type { ChartDoc } from '../../views/chartDoc/chartDoc';
import { readRenderHash } from '../../views/chartDoc/docLink';
import { latestTime } from '../../views/chartDoc/Legend';
import { allSevenDay, layerRequest, useLayerData } from '../../views/chartDoc/layerPoints';
import { useCrosshairLegend } from '../../views/chartDoc/useCrosshairLegend';
import { useDocChart } from '../../views/chartDoc/useDocChart';
import { useAxisDecor } from '../../views/chartDoc/useAxisDecor';
import { usePercentileBand } from '../../views/chartDoc/usePercentileBand';
import { useSeriesData } from '../../views/chartDoc/useSeriesData';
import { useBaseBand } from './hooks/useBaseBand';
import { type DrawingActions, useDrawings } from './hooks/useDrawings';
import { useFitSync } from './hooks/useFitSync';
import { docSnapshot } from './snapshot';

/** 交给命令行的结果:png 是 data URL;missing = 没取到数的序列(图照出,命令行打警告) */
export type RenderResult = { png: string; missing: string[] } | { error: string };

declare global {
  interface Window {
    __render?: RenderResult;
  }
}

// 只看不改:画线照画,点击 / 拖动都不会写回(本页没人操作)
const READ_ONLY: DrawingActions = { addDrawing: () => {}, updateDrawing: () => {}, removeDrawing: () => {} };
const NO_SELECTION = { current: null };
function identity<T>(p: T) {
  return p;
}
// 数据到齐后再等这么久才截:图例位置在下一帧量、叠加的轴范围每帧对齐、字体可能还在加载
const SETTLE_MS = 300;

/** 出图链接里的主题先设到页面上(不存 localStorage,不影响平时看板的主题);main.tsx 在渲染前调用 */
export function applyRenderTheme() {
  const parsed = readRenderHash(location.hash);
  if ('theme' in parsed) document.documentElement.dataset.theme = parsed.theme;
}

export function RenderPage() {
  const parsed = readRenderHash(location.hash);
  useEffect(() => {
    if ('error' in parsed) window.__render = { error: parsed.error };
  });

  return 'error' in parsed ? (
    <p className="p-4 text-sm text-amber-500">{parsed.error}</p>
  ) : (
    <RenderChart doc={parsed.doc} interval={parsed.interval} from={parsed.from} />
  );
}

function RenderChart({ doc, interval, from }: { doc: ChartDoc; interval: Interval; from?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 同一个对象:每次渲染新建的话,useDocChart 的对准 effect 会跟着依赖变化反复把视图拽回去
  const fit = useMemo(() => (from ? { from } : ('common' as const)), [from]);
  const theme = useTheme();

  const sevenDay = allSevenDay(doc);
  const requests = doc.panes.flatMap((p) => p.layers.map((l) => layerRequest(l, sevenDay)));
  const { points, bars, isLoading, error, missing } = useSeriesData(requests, interval);
  const data = useLayerData(doc, points, interval, bars);
  const { chartRef, seriesRef } = useDocChart(containerRef, doc, data, {
    onStretches: () => {},
    interval,
    fit,
  });
  useAxisDecor(containerRef, chartRef, seriesRef, doc, data);
  const { layout } = useCrosshairLegend(containerRef, chartRef, doc);
  useDrawings(containerRef, chartRef, seriesRef, NO_SELECTION, doc, data, READ_ONLY, identity);
  useFitSync(chartRef, seriesRef, doc);
  useBaseBand(chartRef, doc, data);
  usePercentileBand(chartRef, doc, data);

  // 截图要用最新的布局 / 数据:放 ref,定时器回调里读
  const latest = useRef({ data, layout, missing });
  useEffect(() => {
    latest.current = { data, layout, missing };
  });
  useEffect(() => {
    if (isLoading) return;
    if (error) {
      window.__render = { error: `取数失败:${error.message}` };
      return;
    }
    const t = setTimeout(async () => {
      await document.fonts.ready;
      const chart = chartRef.current;
      const origin = containerRef.current;
      if (!chart || !origin) {
        window.__render = { error: '图表没建出来' };
        return;
      }
      const { data: d, layout: l, missing: m } = latest.current;
      // 起始日晚于数据最后一天:lw 会把可视区压成最后一根拉满全宽,图看着像坏了却「成功」—— 直接报错
      const last = latestTime(doc, d);
      if (from && last && from > last) {
        window.__render = { error: `--from ${from} 晚于数据最后一天 ${last}` };
        return;
      }
      const canvas = docSnapshot(chart, origin, doc, d, l, interval, CHART_CHROME[theme].ink);
      window.__render = { png: canvas.toDataURL('image/png'), missing: m };
    }, SETTLE_MS);

    return () => clearTimeout(t);
  }, [isLoading, error, chartRef, doc, interval, theme, from]);

  return (
    <div className="relative h-screen w-screen bg-neutral-950">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
