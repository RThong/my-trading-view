import { useMemo, useRef } from 'react';
import type { Interval } from '../hooks/interval';
import { usePaneChartStack } from './assetChart.hooks';
import { useRegimeData, buildRegimeSpecs, REGIME_DIMS, type RegimeDim } from './regimeChart.hooks';
import { PaneChartView } from './PaneChartView';

// 一个 regime 维度(信用/流动性/情绪)的多 pane 堆叠图。薄壳:取数 → build specs → 三个通用 hook → 展示壳。
// 实例与维度绑定一辈子(App keep-alive),故 paneDefs 取模块常量即引用稳定。
export function RegimeChart({ dim, interval }: { dim: RegimeDim; interval: Interval }) {
  const cfg = REGIME_DIMS[dim];
  const { paneDefs } = cfg;
  const paneCount = paneDefs.length;
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, error, isLoading } = useRegimeData();
  const specs = useMemo(() => buildRegimeSpecs(data, dim, interval), [data, dim, interval]);
  const { order, collapsed, move, toggle, cells, hovering, tops } = usePaneChartStack(containerRef, paneDefs, paneCount, specs);

  // 本维度里在 unavailable 中的序列 → 右上角提示。
  const missing = paneDefs.map((d) => d.series[0]).filter((k) => data.unavailable.includes(k));
  const note = missing.length ? `暂不可用: ${missing.map((k) => cfg.seriesName[k]).join(', ')}` : undefined;

  return (
    <PaneChartView
      containerRef={containerRef} paneDefs={paneDefs} paneCount={paneCount}
      order={order} collapsed={collapsed} move={move} toggle={toggle}
      cells={cells} hovering={hovering} tops={tops}
      seriesName={cfg.seriesName} colors={cfg.colors} isLoading={isLoading} error={error} note={note}
    />
  );
}
