import { useMemo, useRef } from 'react';
import type { Interval } from '../../hooks/interval';
import { usePaneChartStack } from '../chart/paneChart.hooks';
import {
  useRegimeData,
  buildRegimeSpecs,
  regimePercentiles,
  derivePaneMeta,
  dimPanes,
  secLagNote,
  type RegimeDim,
} from './regimeChart.hooks';
import { PaneChartView } from '../chart/PaneChartView';

// 一个 regime 维度(信用/流动性/情绪)的多 pane 堆叠图。薄壳:取数 → build specs → 三个通用 hook → 展示壳。
// 实例与维度绑定一辈子(App keep-alive)。固定维度的 panes 是模块常量;基本面维度按名单现算,见下。
export function RegimeChart({ dim, interval }: { dim: RegimeDim; interval: Interval }) {
  // 基本面维度的 panes 按名单现算(每次渲染新引用)。usePaneChart 内部有 useStable 深比较兜底,
  // 所以这层 useMemo 只为省掉每帧的重建与深比较;dim 一辈子不变,deps 只需 dim。
  const panes = useMemo(() => dimPanes(dim), [dim]);
  const { paneDefs, seriesName, colors, desc } = derivePaneMeta(panes);
  const paneCount = paneDefs.length;
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, error, isLoading } = useRegimeData();
  const specs = buildRegimeSpecs(data, dim, interval);
  const { order, collapsed, move, toggle, cells, hovering, tops, drawing, toggleDrawing, selection, deleteSelected } =
    usePaneChartStack(containerRef, paneDefs, paneCount, specs, { storageKey: `regime:${dim}` });

  // 右上角提示:序列缺失 + SEC 滞后。两者可同时成立(某格空着、另一家又落后一季)。
  const missing = panes.map((p) => p.key).filter((k) => data.unavailable.includes(k));
  const notes = [
    missing.length ? `暂不可用: ${missing.map((k) => seriesName[k]).join(', ')}` : undefined,
    secLagNote(data, dim),
  ].filter((n) => n !== undefined);
  const note = notes.length ? notes.join(' · ') : undefined;
  const badges = regimePercentiles(data, dim); // 当前分位徽标(仅 percentile pane 非空)

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
      badges={badges}
      desc={desc}
      drawing={drawing}
      toggleDrawing={toggleDrawing}
      selection={selection}
      deleteSelected={deleteSelected}
    />
  );
}
