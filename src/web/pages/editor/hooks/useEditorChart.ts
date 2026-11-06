// 编辑器的渲染层:只吃「ChartDoc + 取到的数据」,直接用 lightweight-charts v5 API。
// 图只建一次;之后每次文档变化按图层 id 增量对账(加 / 删 / 换格 / 换轴 / 改色 / 倒轴 / 对数),不重建整张图,
// 所以加格删格时缩放与十字线状态都还在。不依赖旧图表引擎(chart/ 下的 PaneChart*)。
import { type RefObject, useEffect, useRef } from 'react';
import {
  createChart,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import { CHART_OPTIONS, type LinePoint } from '../../../chart/core';
import type { Interval } from '../../../hooks/interval';
import type { ChartDoc } from '../../../views/chartDoc/chartDoc';
import { canLogScale, type LayerData } from './layerPoints';
import { commonRange } from '../../../views/chartDoc/useSeriesData';

export type LayerSeries = Map<string, ISeriesApi<'Line'>>;
type SeriesOpts = {
  color: string;
  priceScaleId: string;
  visible: boolean;
  lineVisible: boolean;
  lastValueVisible: boolean;
  crosshairMarkerVisible: boolean;
};

type Options = {
  /** 拖完分隔条后读回的各格高度比例(写回 JSON,保持 JSON 是唯一真源)。 */
  onStretches: (stretches: number[]) => void;
  /** 页头周期:变了就重新对准共同时段(否则整段换数据后柱宽不变,月线会挤在最右边一小条) */
  interval: Interval;
};

const STRETCH_EPS = 1e-3;
// 读回的比例只留 3 位小数:JSON 里不出现 0.6734129… 这种噪音,也不影响观感。
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

export function useEditorChart(
  containerRef: RefObject<HTMLDivElement | null>,
  doc: ChartDoc,
  data: Record<string, LayerData>,
  { onStretches, interval }: Options,
) {
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<LayerSeries>(new Map());
  // 每条图层上次 setData 的数组引用:引用没变就不重设(改色 / 换轴不该触发整段重灌数据)。
  const fedRef = useRef(new Map<string, LinePoint[]>());
  // lw-charts 格对象 → 它上次对应的文档格 id。对应关系变了 = 这块 lw 格装的是「新的格」,要把内置轴设回默认,
  // 见纵轴那个 effect。只认格对象身份不够:lw 会复用旧格对象(最后一格永不删除;移走某格唯一的线后别的线会挪进来)
  const paneOwnerRef = useRef(new Map<IPaneApi<Time>, string>());
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
      // lockVisibleTimeRangeOnResize:图宽一变(收起侧栏、拉窗口)保持可视日期范围,而不是默认的保持右端和每根宽度、
      // 把左边那截切掉 —— 「叠加对比」按的就是可视区间,收起时框好的区间展开后不能悄悄变窄
      timeScale: { ...CHART_OPTIONS.timeScale, minBarSpacing: 0.1, lockVisibleTimeRangeOnResize: true },
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
      const pts = data[l.id]?.display;
      const prev = fedRef.current.get(l.id);
      return s && pts && prev !== pts ? [{ id: l.id, s, pts, prev }] : [];
    });
    stale.forEach(({ id, s, pts }) => {
      s.setData(pts);
      fedRef.current.set(id, pts);
    });
    // 这一轮有没有图层「第一次拿到真数据」(新加的线 / 加载完成)。隐藏的线不参与:看不见的短历史线不该把视图截短
    const seriesIds = new Set(layers.filter((l) => !l.hidden).map((l) => l.id));
    const arrived = stale.filter(({ id, pts, prev }) => seriesIds.has(id) && pts.length > 0 && !prev?.length);

    // 有新线到位、或换了周期,就把横轴对准「所有线都有数据的那一段」:长历史的线不截,往左拖还在,
    // 只是不让短历史的线挤在右边。其余时候缩放归用户,删线 / 改色 / 数据刷新不动视图。
    const intervalChanged = alignedIntervalRef.current !== interval;
    if (arrived.length === 0 && !intervalChanged) return;
    const seriesPts = [...seriesIds].map((id) => data[id]?.display ?? []);
    const range = commonRange(seriesPts);
    // 换周期时数据可能还没到:等有数据的那一轮再对准,别把「已对准」提前记上
    if (!range && !seriesPts.some((p) => p.length)) return;

    alignedIntervalRef.current = interval;
    if (range) chart.timeScale().setVisibleRange(range);
    else chart.timeScale().fitContent();
  }, [doc, data, interval]);

  // 纵轴显示模式(倒轴 / 对数)。放在结构与数据之后:对数要看数据,轴上有 ≤0 的值就按普通坐标画。
  // 内置左右轴每格都在,没声明的也要明确设回默认(轴被回收后再挂上图层,不能沿用旧状态)。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const panes = chart.panes();
    // 文档里已没有的格 / 图里已删掉的 lw 格,对应关系作废(清空后再加线时新格可能复用同一个 id)
    const live = new Set(panes);
    const docIds = new Set(doc.panes.map((p) => p.id));
    [...paneOwnerRef.current].forEach(([api, id]) => {
      if (!live.has(api) || !docIds.has(id)) paneOwnerRef.current.delete(api);
    });

    doc.panes.forEach((pane, i) => {
      const api = panes[i];
      if (!api) return;
      // 新格(或 lw 格换了主人):lw-charts 写某一格内置轴的选项时会顺手 merge 进整张图的全局选项,新格按全局建轴;
      // 旧格对象被复用时还带着上一个主人的手动范围。两种都会让新线落在别处的范围里、整格空白 —— 设回自动
      if (paneOwnerRef.current.get(api) !== pane.id) {
        api.priceScale('right').setAutoScale(true);
        api.priceScale('left').setAutoScale(true);
        paneOwnerRef.current.set(api, pane.id);
      }
      const byId = new Map(pane.scales.map((sc) => [sc.id, sc]));
      const ids = new Set(['right', 'left', ...byId.keys()]);
      ids.forEach((id) => {
        const sc = byId.get(id);
        const ps = api.priceScale(id);
        const cur = ps.options();
        const invertScale = !!sc?.invert;
        const mode = sc?.log && canLogScale(pane, id, data) ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal;
        // 只写真变了的那一项:哪怕写回同样的 mode,lw-charts 也会按数据重算显示范围,
        // 把用户手动拖好的纵轴缩放冲掉(实测:加一格时主图纵轴被重置)
        if (cur.invertScale !== invertScale) ps.applyOptions({ invertScale });
        if (cur.mode !== mode) ps.applyOptions({ mode });
      });
    });
  }, [doc, data]);

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
  const fitTargets = new Set(doc.panes.flatMap((p) => p.layers.flatMap((l) => (l.fit ? [l.fit.target] : []))));

  [...series.entries()]
    .filter(([id]) => !wanted.has(id))
    .forEach(([id, s]) => {
      chart.removeSeries(s);
      series.delete(id);
      fed.delete(id);
    });

  doc.panes.forEach((pane, paneIndex) => {
    pane.layers.forEach((layer) => {
      // 隐藏 = visible: false:不画、不进自动缩放(lw-charts 自带);图例读数取自 layerPoints,不受影响。
      // 例外是被叠加的 A:B 轴每帧按 A 轴的范围换算(useFitSync),A 不进自动缩放的话 A 轴定住、B 也跟着定住 —— 只关线和标签
      const hidden = !!layer.hidden;
      const opts = {
        color: layer.color,
        priceScaleId: layer.scale,
        visible: !hidden || fitTargets.has(layer.id),
        lineVisible: !hidden,
        lastValueVisible: !hidden,
        crosshairMarkerVisible: !hidden,
      };
      const existing = series.get(layer.id);
      if (!existing) {
        series.set(layer.id, createLayerSeries(chart, opts, paneIndex));
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
    if (!api) return;
    if (Math.abs(api.getStretchFactor() - pane.stretch) > STRETCH_EPS) api.setStretchFactor(pane.stretch);
  });
}

function createLayerSeries(chart: IChartApi, opts: SeriesOpts, paneIndex: number): ISeriesApi<'Line'> {
  return chart.addSeries(LineSeries, { ...opts, lineWidth: 2, priceLineVisible: false }, paneIndex);
}
