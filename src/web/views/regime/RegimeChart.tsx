import { useMemo, useRef } from 'react';
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
  type PaneSpec,
  type RegimeData,
  type RegimeView,
} from './regimeChart.hooks';
import { requestKey, type SeriesData, type SeriesRequest, useSeriesData } from '../chartDoc/useSeriesData';
import { PaneChartView } from '../../chart/PaneChartView';

// 一个 regime 维度(信用/流动性/情绪)的多 pane 堆叠图。薄壳:取数 → build specs → 三个通用 hook → 展示壳。
// 实例与维度绑定一辈子(App keep-alive)。配置由页面层查好传进来(pages/regimeDims 的 regimeView),
// 要求引用稳定 —— regimeView 按 dim 缓存,保证了这一点。
export function RegimeChart({ view, interval }: { view: RegimeView; interval: Interval }) {
  const { dim, panes } = view;
  const { paneDefs, seriesName, colors, desc } = derivePaneMeta(panes);
  const paneCount = paneDefs.length;
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: regime, error, isLoading: regimeLoading } = useRegimeData();
  // 计算格(PaneSpec.from):按注册表取两条腿、日线现算,填回这格的 key;下游(规格、分位、缺失提示)照旧按 key 读
  const calcPanes = useMemo(() => panes.filter((p) => p.from), [panes]);
  const calc = useSeriesData(calcPanes.map(calcRequest), '1D');
  const data = useMemo(
    () => withCalc(regime, calcPanes, calc.points, calc.isLoading, calc.stale),
    // 依赖 calc 里的三个字段(各自引用稳定),不依赖 calc 整个对象:它每次渲染都是新的
    [regime, calcPanes, calc.points, calc.isLoading, calc.stale],
  );
  const isLoading = regimeLoading || calc.isLoading;
  const specs = buildRegimeSpecs(data, panes, interval);
  const { order, collapsed, move, toggle, cells, hovering, tops, drawing, toggleDrawing, selection, deleteSelected } =
    usePaneChartStack(containerRef, paneDefs, paneCount, specs, { storageKey: `regime:${dim}` });

  // 右上角提示:序列缺失 + SEC 滞后 + 断档裁剪。三者可同时成立
  // (某格空着、另一家落后一季、还有一格被裁短)。裁剪那条见 secTrimNote:
  // 裁本身是对的,但不说的话「线怎么这么短」无处可查。
  // overlay 也要算进来:它在 seriesName/colors 里有名有色,缺了却不提示,那格会静默少一条线。
  const keys = panes.flatMap((p) => [
    p.key,
    ...(p.overlays ?? []).map((o) => o.key),
    ...(p.events ?? []).map((e) => e.key),
  ]);
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

export function calcRequest(p: PaneSpec): SeriesRequest {
  const { series, calc } = p.from!;
  return { series, calc, shift: 0, daily: true };
}

/**
 * 计算格的结果填回 data(键是「A|运算|B」,服务端不发这种键):有数就填上,算完仍没数就记缺失;
 * 任一条腿是服务端「沿用上次数据」的,这格也记进 fallback(提示里照样说明不是最新)。
 */
export function withCalc(
  data: RegimeData,
  calcPanes: PaneSpec[],
  points: SeriesData['points'],
  loading: boolean,
  staleKeys: string[],
): RegimeData {
  if (calcPanes.length === 0) return data;

  const keyOf = (p: PaneSpec) => requestKey(calcRequest(p));
  const computed = calcPanes.map((p) => [p.key, points[keyOf(p)] ?? []] as const);
  const filled = computed
    .filter(([, pts]) => pts.length > 0)
    .map(([k, pts]) => [k, pts.map((pt) => ({ date: pt.time, value: pt.value }))]);
  // 取数中先不判缺,免得一闪「暂不可用」
  const empty = loading ? [] : computed.filter(([, pts]) => pts.length === 0).map(([k]) => k);
  const stale = calcPanes.filter((p) => staleKeys.includes(keyOf(p))).map((p) => p.key);

  return {
    ...data,
    series: { ...data.series, ...Object.fromEntries(filled) },
    unavailable: [...data.unavailable, ...empty],
    fallback: [...(data.fallback ?? []), ...stale],
  };
}
