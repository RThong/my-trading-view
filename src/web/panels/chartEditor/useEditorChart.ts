// 编辑器的渲染层:只吃「ChartDoc + 取到的数据」,直接用 lightweight-charts v5 API。
// 图只建一次;之后每次文档变化按图层 id 增量对账(加 / 删 / 换格 / 换轴 / 改色),不重建整张图,
// 所以加格删格时缩放与十字线状态都还在。不依赖旧图表引擎(panels/chart/)。
import { type RefObject, useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { CHART_OPTIONS, type LinePoint } from '../../lib/chart';
import type { Interval } from '../../hooks/interval';
import type { ChartDoc } from './chartDoc';
import { commonRange } from './useEditorSeriesData';

export type LayerSeries = Map<string, ISeriesApi<'Line'>>;

type Options = {
  /** 拖完分隔条后读回的各格高度比例(写回 JSON,保持 JSON 是唯一真源)。 */
  onStretches: (stretches: number[]) => void;
  /** 页头周期:变了就重新对准共同时段(否则整段换数据后柱宽不变,月线会挤在最右边一小条) */
  interval: Interval;
};

const STRETCH_EPS = 1e-3;
// 读回的比例只留 3 位小数:JSON 里不出现 0.6734129… 这种噪音,也不影响观感。
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function useEditorChart(
  containerRef: RefObject<HTMLDivElement | null>,
  doc: ChartDoc,
  points: Record<string, LinePoint[]>,
  { onStretches, interval }: Options,
) {
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<LayerSeries>(new Map());
  // 每条图层上次 setData 的数组引用:引用没变就不重设(改色 / 换轴不该触发整段重灌数据)。
  const fedRef = useRef(new Map<string, LinePoint[]>());
  // 上次对准视图时的周期:只在 effect 里读写,不参与渲染
  const alignedIntervalRef = useRef(interval);
  // 最新回调放 ref:监听器只挂一次,不随调用方每次渲染的新函数引用重挂
  const onStretchesRef = useRef(onStretches);
  useEffect(() => {
    onStretchesRef.current = onStretches;
  });

  // 建图 / 销毁
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      ...CHART_OPTIONS,
      crosshair: { mode: 0 }, // Normal:十字线跟鼠标走,不吸附到某条线
      layout: { ...CHART_OPTIONS.layout, panes: { separatorColor: '#262626', enableResize: true } },
      // 默认最窄 0.5px/根:2018 起的日线约 2200 根,常见屏宽下放不下,「对准共同时段」会落到 2019 年中
      timeScale: { ...CHART_OPTIONS.timeScale, minBarSpacing: 0.1 },
    });
    chartRef.current = chart;
    const series = seriesRef.current;
    const fed = fedRef.current;

    return () => {
      chart.remove();
      chartRef.current = null;
      series.clear();
      fed.clear();
    };
  }, [containerRef]);

  // 结构对账:文档 → series 集合(数据由下一个 effect 管)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    reconcile(chart, seriesRef.current, fedRef.current, doc);
  }, [doc]);

  // 数据:只给新建的、或数据引用变了的图层 setData
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const layers = doc.panes.flatMap((p) => p.layers);
    // 要重灌的:新建的、或数据引用变了的图层(改色、换格都不会换数据引用)
    const stale = layers.flatMap((l) => {
      const s = seriesRef.current.get(l.id);
      const data = points[l.series];
      const prev = fedRef.current.get(l.id);
      return s && data && prev !== data ? [{ id: l.id, s, data, prev }] : [];
    });
    stale.forEach(({ id, s, data }) => {
      s.setData(data);
      fedRef.current.set(id, data);
    });
    // 这一轮有没有图层「第一次拿到真数据」(新加的线 / 加载完成)
    const arrived = stale.filter(({ data, prev }) => data.length > 0 && !prev?.length);

    // 有新线到位、或换了周期,就把横轴对准「所有线都有数据的那一段」:长历史的线不截,往左拖还在,
    // 只是不让短历史的线挤在右边。其余时候缩放归用户,删线 / 改色 / 数据刷新不动视图。
    const intervalChanged = alignedIntervalRef.current !== interval;
    if (arrived.length === 0 && !intervalChanged) return;
    const range = commonRange(layers.map((l) => points[l.series] ?? []));
    // 换周期时数据可能还没到:等有数据的那一轮再对准,别把「已对准」提前记上
    if (!range && !layers.some((l) => points[l.series]?.length)) return;

    alignedIntervalRef.current = interval;
    if (range) chart.timeScale().setVisibleRange(range);
    else chart.timeScale().fitContent();
  }, [doc, points, interval]);

  // 分隔条拖完:读回各格比例。原生拖拽改的是图内状态,不读回的话下次结构变化会被 JSON 里的旧值盖掉。
  // 挂在 window 上:lw-charts 允许拖出图外再松手(它自己在 documentElement 上听 mouseup),
  // 只听容器会漏掉这种松手。比例没变时 setStretches 返回原文档,不触发重渲染。
  useEffect(() => {
    const onUp = () => {
      const chart = chartRef.current;
      if (!chart) return;
      onStretchesRef.current(chart.panes().map((p) => round3(p.getStretchFactor())));
    };
    window.addEventListener('pointerup', onUp);

    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  return { chartRef, seriesRef };
}

/**
 * 按文档顺序(第 0 格起、格内按图层顺序)逐条落位。按格升序处理可保证下标不乱:
 * 已处理的格都装着自己的目标图层,不会因为有图层被移走而变空被 lw-charts 自动删掉;
 * 被移空自动删掉的只可能是后面的格,不影响已落位的下标。目标格不存在时 lw-charts 会新建。
 */
function reconcile(chart: IChartApi, series: LayerSeries, fed: Map<string, LinePoint[]>, doc: ChartDoc) {
  const wanted = new Set(doc.panes.flatMap((p) => p.layers.map((l) => l.id)));

  [...series.entries()]
    .filter(([id]) => !wanted.has(id))
    .forEach(([id, s]) => {
      chart.removeSeries(s);
      series.delete(id);
      fed.delete(id);
    });

  doc.panes.forEach((pane, paneIndex) => {
    pane.layers.forEach((layer) => {
      const opts = { color: layer.color, priceScaleId: layer.scale };
      const existing = series.get(layer.id);
      if (!existing) {
        series.set(
          layer.id,
          chart.addSeries(LineSeries, { ...opts, lineWidth: 2, priceLineVisible: false }, paneIndex),
        );
        return;
      }
      if (existing.getPane().paneIndex() !== paneIndex) existing.moveToPane(paneIndex);
      existing.applyOptions(opts);
    });

    // 层次同 TradingView:卡片列表最上面那条画在最上层(lw-charts 里序号越大越靠上)。
    // 从底层往上逐个归位,前面已归位的不会被后面的挪动打乱。
    pane.layers.toReversed().forEach((layer, order) => {
      const s = series.get(layer.id);
      if (s && s.seriesOrder() !== order) s.setSeriesOrder(order);
    });
  });

  // 左轴只能整图开关:只要有一格挂左轴就打开,没用左轴的格会留一条空的左轴。
  // 试过逐格 pane.priceScale('left').applyOptions({ visible }):轴宽会被算成 0、刻度画不出来(lw-charts 5.2 实测)。
  const anyLeft = doc.panes.some((p) => p.scales.some((s) => s.side === 'left'));
  chart.applyOptions({ leftPriceScale: { visible: anyLeft, borderColor: CHART_OPTIONS.rightPriceScale.borderColor } });

  const panes = chart.panes();
  doc.panes.forEach((pane, i) => {
    const api = panes[i];
    if (api && Math.abs(api.getStretchFactor() - pane.stretch) > STRETCH_EPS) api.setStretchFactor(pane.stretch);
  });
}
