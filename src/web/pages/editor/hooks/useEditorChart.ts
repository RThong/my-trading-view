// 编辑器的渲染层:只吃「ChartDoc + 取到的数据」,直接用 lightweight-charts v5 API。
// 图只建一次;之后每次文档变化按图层 id 增量对账(加 / 删 / 换格 / 换轴 / 改色 / 倒轴 / 对数),不重建整张图,
// 所以加格删格时缩放与十字线状态都还在。不依赖旧图表引擎(chart/ 下的 PaneChart*)。
import { type RefObject, useEffect, useRef } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  createChart,
  HistogramSeries,
  LineSeries,
  LineType,
  PriceScaleMode,
  type AutoscaleInfoProvider,
  type CandlestickData,
  type IChartApi,
  type IPaneApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesDataItemTypeMap,
  type SeriesDefinition,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import {
  CHART_OPTIONS,
  FULL_HEIGHT,
  FULL_HEIGHT_AREA,
  REF_LINE,
  boxAutoscaleProvider,
  fullHeightScale,
  type LinePoint,
} from '../../../chart/core';
import { BACKGROUND_ALPHA, SIGNED_DOWN, SIGNED_UP, TRANSPARENT, withAlpha } from '../../../chart/palette';
import type { Interval } from '../../../hooks/interval';
import {
  isMarkLayer,
  liveScaleIds,
  markColor,
  type ChartDoc,
  type Layer,
  type Pane,
} from '../../../views/chartDoc/chartDoc';
import { drawnKind } from '../../../views/chartDoc/registry';
import { canLogScale, layerMarks, type LayerData } from './layerPoints';
import { commonRange } from '../../../views/chartDoc/useSeriesData';

/** 折线是 Line;符号柱、事件竖线是 Histogram;背景色带是 Area。拖线 / 选中高亮只对折线(见 useLineDrag) */
export type LayerSeries = Map<string, ISeriesApi<SeriesType>>;
type Kind = NonNullable<Layer['render']>['kind'];
/**
 * 上次灌给某图层的数据、当时的画法和颜色:画法变了(符号柱 ↔ 事件)同一份点也要重灌,点的颜色 / 值不一样;
 * 标记图层(竖线、背景色带)的颜色逐点写在数据里(会盖过 series 的 color 选项),改色 / 改竖线透明度也得重灌(color = markColor)
 */
type Fed = { src: unknown[]; kind: Kind; color: string };

// 原样自动缩放。轴上去掉范围框时也要显式写回它:lw-charts 合并选项会跳过 undefined,不写就沿用旧框
const PASS_AUTOSCALE: AutoscaleInfoProvider = (base) => base();

type KindDef = {
  def: SeriesDefinition<SeriesType>;
  /** 喂给这种 series 的原料(蜡烛读 K 线,其余读点);引用变了才重灌 */
  input: (d: LayerData) => unknown[] | undefined;
  data: (layer: Layer, d: LayerData) => unknown[];
};

/**
 * 画法表的一项。泛型把「series 种类」和「换出来的点」绑在一起:缺了这种 series 的必填字段、字段类型不对,在这里就编译报错
 * (多写了它不认的字段 TS 查不出 —— 回调返回值不做多余属性检查,比如面积图写成 color 而不是 topColor 要靠浏览器里看)。
 * 出了这一层表里只剩宽类型,建 series 时不用再断言;灌数据那一处(setData)按宽类型断言一次
 */
function kindDef<T extends SeriesType>(
  def: SeriesDefinition<T>,
  data: (layer: Layer, pts: LinePoint[]) => SeriesDataItemTypeMap[T][],
): KindDef {
  return {
    def: def as SeriesDefinition<SeriesType>,
    input: (d) => d.display,
    data: (layer, d) => data(layer, d.display),
  };
}

/**
 * 每种画法:用哪种 lw-charts series、点怎么换。符号柱逐点上色;事件竖线值恒为 1;
 * 背景色带值恒为 1、标记非 0 的日子上色其余透明,用面积图(柱子之间有缝,放大后一段会碎成竖纹,同分位带)
 */
const KINDS: Record<Kind, KindDef> = {
  line: kindDef(LineSeries, (_layer, pts) => pts),
  signed: kindDef(HistogramSeries, (_layer, pts) =>
    pts.map((p) => ({ ...p, color: p.value >= 0 ? SIGNED_UP : SIGNED_DOWN })),
  ),
  events: kindDef(HistogramSeries, (layer, pts) => {
    const color = markColor(layer);
    return pts.map((p) => ({ time: p.time, value: 1, color }));
  }),
  // 蜡烛读 K 线不读点:涨跌颜色由 series 选项定(见 seriesOptions),图层颜色不起作用
  candle: {
    def: CandlestickSeries as SeriesDefinition<SeriesType>,
    input: (d) => d.bars,
    data: (_layer, d): CandlestickData[] => d.bars ?? [],
  },
  background: kindDef(AreaSeries, (layer, pts) => {
    const tint = withAlpha(layer.color, BACKGROUND_ALPHA);
    return pts.map((p) => {
      const fill = p.value !== 0 ? tint : TRANSPARENT;
      return { time: p.time, value: 1, topColor: fill, bottomColor: fill };
    });
  }),
};

/** 各画法的 series 选项。每次对账整份写回,改色 / 换轴 / 显隐 / 范围框都走这里 */
function seriesOptions(layer: Layer, pane: Pane, fitTargets: Set<string>) {
  const hidden = !!layer.hidden;
  // 背景色带的颜色逐点写在数据里(见 KINDS),选项里只关掉线和标记
  if (drawnKind(layer) === 'background')
    return { ...FULL_HEIGHT_AREA, priceScaleId: `mark-${layer.id}`, visible: !hidden };
  if (isMarkLayer(layer))
    return {
      color: layer.color,
      priceScaleId: `mark-${layer.id}`,
      visible: !hidden,
      lastValueVisible: false,
      priceLineVisible: false,
      autoscaleInfoProvider: FULL_HEIGHT,
    };

  const scale = pane.scales.find((sc) => sc.id === layer.scale);
  // 轴的范围框落到这根轴上每条线的自动缩放上,轴取并集(语义见 boxAutoscaleProvider)
  const autoscaleInfoProvider = boxAutoscaleProvider(scale?.clampVisibleTo, scale?.expandVisibleTo) ?? PASS_AUTOSCALE;
  // 蜡烛:涨绿跌红(同符号柱的两色),图层颜色不起作用
  if (drawnKind(layer) === 'candle')
    return {
      priceScaleId: layer.scale,
      visible: !hidden,
      lastValueVisible: !hidden,
      autoscaleInfoProvider,
      upColor: SIGNED_UP,
      downColor: SIGNED_DOWN,
      borderUpColor: SIGNED_UP,
      borderDownColor: SIGNED_DOWN,
      wickUpColor: SIGNED_UP,
      wickDownColor: SIGNED_DOWN,
    };
  if (drawnKind(layer) === 'signed')
    return { priceScaleId: layer.scale, visible: !hidden, lastValueVisible: !hidden, base: 0, autoscaleInfoProvider };

  // 隐藏 = visible: false:不画、不进自动缩放(lw-charts 自带);图例读数取自 layerPoints,不受影响。
  // 例外是被叠加的 A:B 轴每帧按 A 轴的范围换算(useFitSync),A 不进自动缩放的话 A 轴定住、B 也跟着定住 —— 只关线和标签
  const step = layer.render?.kind === 'line' && layer.render.step;
  return {
    color: layer.color,
    // 阶梯线:低频序列(季频 r*)两次发布之间值不变,画成斜坡等于凭空造出中间值。每次都写,关掉时才能改回来
    lineType: step ? LineType.WithSteps : LineType.Simple,
    priceScaleId: layer.scale,
    visible: !hidden || fitTargets.has(layer.id),
    lineVisible: !hidden,
    lastValueVisible: !hidden,
    crosshairMarkerVisible: !hidden,
    autoscaleInfoProvider,
  };
}

function createLayerSeries(chart: IChartApi, layer: Layer, opts: object, paneIndex: number): ISeriesApi<SeriesType> {
  const kind = drawnKind(layer);
  const s = chart.addSeries(
    KINDS[kind].def,
    { ...opts, ...(kind === 'line' && { lineWidth: 2 }), priceLineVisible: false },
    paneIndex,
  );
  if (isMarkLayer(layer)) fullHeightScale(s);
  return s;
}

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
  const fedRef = useRef(new Map<string, Fed>());
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
      const d = data[l.id];
      const kind = drawnKind(l);
      const src = d && KINDS[kind].input(d);
      const prev = fedRef.current.get(l.id);
      // 标记图层的颜色逐点写在数据里:实际画出来的颜色变了(改色 / 改竖线透明度)就得重灌
      const tint = markColor(l);
      const changed = !prev || prev.src !== src || prev.kind !== kind || (isMarkLayer(l) && prev.color !== tint);
      // had:这条之前灌过非空数据(换画法 / 数据刷新),不算「第一次到位」,不去动横轴
      return s && d && src && changed ? [{ l, s, d, src, kind, tint, had: (prev?.src.length ?? 0) > 0 }] : [];
    });
    stale.forEach(({ l, s, d, src, kind, tint }) => {
      s.setData(KINDS[kind].data(l, d) as never);
      fedRef.current.set(l.id, { src, kind, color: tint });
    });
    // 这一轮有没有图层「第一次拿到真数据」(新加的线 / 加载完成)。隐藏的线、标记图层不参与:
    // 看不见的短历史线不该把视图截短;竖线 / 色带是标记,不是一段该对准的数据。
    // 但图上只有标记图层时就按它们对准,不然视图停在默认位置,色带挤在右边一截
    const visible = layers.filter((l) => !l.hidden);
    const lines = visible.filter((l) => !isMarkLayer(l));
    const seriesIds = new Set((lines.length ? lines : visible).map((l) => l.id));
    const arrived = stale.filter(({ l, src, had }) => seriesIds.has(l.id) && src.length > 0 && !had);

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
      const ids = new Set(['right', 'left', ...liveScaleIds(pane)]);
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

  // 水平线(基线、参考线、分位 P5 / P95):文档或数据变了就整套重画。分位线要看数据,所以不放进结构对账。
  // 记下画在哪条 series 上:换画法时 series 被删了重建,旧线跟着旧 series 没了,不能再去删
  const priceLinesRef = useRef(new Map<string, { s: ISeriesApi<SeriesType>; lines: IPriceLine[] }>());
  useEffect(() => {
    const drawn = priceLinesRef.current;
    [...drawn].forEach(([id, { s, lines }]) => {
      if (seriesRef.current.get(id) !== s) return;
      lines.forEach((pl) => {
        s.removePriceLine(pl);
      });
    });
    drawn.clear();

    doc.panes
      .flatMap((p) => p.layers)
      // 隐藏的线不画(被叠加的 A 隐藏时 series 仍 visible,线会留着);标记图层没有值
      .filter((l) => !l.hidden && !isMarkLayer(l))
      .forEach((l) => {
        const s = seriesRef.current.get(l.id);
        if (!s) return;
        const lines = layerMarks(l, data[l.id]?.display ?? []).lines.map((rl) =>
          s.createPriceLine({ ...REF_LINE, ...(rl.color && { color: rl.color }), price: rl.price, title: rl.title }),
        );
        drawn.set(l.id, { s, lines });
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
function reconcile(chart: IChartApi, series: LayerSeries, fed: Map<string, Fed>, doc: ChartDoc) {
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
      const opts = seriesOptions(layer, pane, fitTargets);
      const existing = series.get(layer.id);
      // 折线 ↔ 柱子是两种 series,换画法只能删了重建(数据由数据 effect 重灌)
      const wantType = KINDS[drawnKind(layer)].def.type;
      // fed 不删:画法不同数据 effect 本来就会重灌;删了会被当成「数据第一次到位」,把用户调好的横轴缩放冲掉
      if (existing && existing.seriesType() !== wantType) chart.removeSeries(existing);
      if (!existing || existing.seriesType() !== wantType) {
        series.set(layer.id, createLayerSeries(chart, layer, opts, paneIndex));
        return;
      }
      if (existing.getPane().paneIndex() !== paneIndex) existing.moveToPane(paneIndex);
      existing.applyOptions(opts);
      if (isMarkLayer(layer)) fullHeightScale(existing);
    });

    // 层次同 TradingView:卡片列表最上面那条画在最上层(lw-charts 里序号越大越靠上)。
    // 标记图层(背景色带、竖线)一律压在线下面,不看卡片顺序。从底层往上逐个归位,前面已归位的不会被后面的挪动打乱。
    const marks = pane.layers.filter(isMarkLayer).toReversed();
    const lines = pane.layers.filter((l) => !isMarkLayer(l)).toReversed();
    [...marks, ...lines].forEach((layer, order) => {
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
