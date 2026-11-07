import { useRef } from 'react';
import type { Interval } from '../../hooks/interval';
import { usePaneChartStack } from '../../chart/paneChart.hooks';
import {
  useRegimeData,
  buildRegimeSpecs,
  regimePercentiles,
  derivePaneMeta,
  secFiledNote,
  secLagNote,
  secTrimNote,
  type RegimeView,
} from './regimeChart.hooks';
import { PaneChartView } from '../../chart/PaneChartView';

// 基本面维度(按名单现算 PaneSpec)的多 pane 堆叠图;固定维度是 ChartDoc,由 views/chartDoc/DocChart 画。薄壳:取数 → build specs → 三个通用 hook → 展示壳。
// 实例与维度绑定一辈子(App keep-alive)。配置由页面层查好传进来(pages/regimeDims 的 regimeView),
// 要求引用稳定 —— regimeView 按 dim 缓存,保证了这一点。
export function RegimeChart({ view, interval }: { view: RegimeView; interval: Interval }) {
  const { dim, panes } = view;
  const { paneDefs, seriesName, colors, desc } = derivePaneMeta(panes);
  const paneCount = paneDefs.length;
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, error, isLoading } = useRegimeData();
  const specs = buildRegimeSpecs(data, panes, interval);
  const { order, collapsed, move, toggle, cells, hovering, tops, drawing, toggleDrawing, selection, deleteSelected } =
    usePaneChartStack(containerRef, paneDefs, paneCount, specs, { storageKey: `regime:${dim}` });

  // 右上角提示:序列缺失 + SEC 滞后 + 断档裁剪。三者可同时成立
  // (某格空着、另一家落后一季、还有一格被裁短)。裁剪那条见 secTrimNote:
  // 裁本身是对的,但不说的话「线怎么这么短」无处可查。
  const keys = panes.map((p) => p.key);
  const missing = keys.filter((k) => data.unavailable.includes(k));
  // 源这次没拉到、服务端拿上一份顶上的:线照画,但要说明不是最新(见 server fillFromPrev)。
  const stale = keys.filter((k) => data.fallback?.includes(k));
  const notes = [
    missing.length ? `暂不可用: ${missing.map((k) => seriesName[k]).join(', ')}` : undefined,
    stale.length ? `源暂时拉不到,沿用上次数据: ${stale.map((k) => seriesName[k]).join(', ')}` : undefined,
    secLagNote(data, dim),
    secTrimNote(data, panes),
  ].filter((n) => n !== undefined);
  const note = notes.length ? notes.join(' · ') : undefined;
  const badges = regimePercentiles(data, panes); // 当前分位徽标(仅 percentile pane 非空)

  return (
    <PaneChartView
      containerRef={containerRef}
      paneDefs={paneDefs}
      paneCount={paneCount}
      order={order}
      collapsed={collapsed}
      move={move}
      toggle={toggle}
      cells={cells}
      hovering={hovering}
      tops={tops}
      seriesName={seriesName}
      colors={colors}
      isLoading={isLoading}
      error={error}
      note={note}
      toolbarNote={secFiledNote(data, dim)}
      badges={badges}
      desc={desc}
      drawing={drawing}
      toggleDrawing={toggleDrawing}
      selection={selection}
      deleteSelected={deleteSelected}
    />
  );
}
