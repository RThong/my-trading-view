// 通用多 pane 图表栈:图表引擎(建图/series 同步)+ 布局(换位/折叠)+ 图例(crosshair)。
// 与数据源无关——AssetChart / RegimeChart / AttackDefensePanel 三方复用,故从 assetChart.hooks 抽出。
import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  HistogramSeries,
  LineType,
  type IChartApi,
  type AutoscaleInfo,
} from 'lightweight-charts';
import { useStable } from '../../hooks/useStable';
import {
  CHART_OPTIONS,
  changeStats,
  needsLogScale,
  clampAutoscaleProvider,
  expandAutoscaleProvider,
} from '../../lib/chart';
import type { PaneDef, Spec, LegendCell, AnySeries } from './paneChart.types';
import { useTrendlines } from './trendlines.hooks';
import { BandFillPrimitive } from './bandFill';

/**
 * 蜡烛价格轴切对数(PriceScaleMode.Logarithmic = 1,不引枚举:这层已经在用字面量配色/配轴了)。
 * 顺手收紧 scaleMargins:默认 0.2 的留白是在**对数空间**里取的,跨 4.5 个数量级时
 * = 上边界超出实际最高价近一个数量级(轴顶会标到 $2,000,000),刻度也因此只剩一条。
 *
 * **只单向切、且每次同步都判**:数据是异步到的,series 建的那一刻可能还空着
 * (AssetChart 的现货 spec 就是先发出、后到数),只在建线时判会让那格永久停在线性轴。
 * 单向 = 不用在这里硬编码 lightweight-charts 的线性默认 margins —— 同一格的标的不会变,
 * 数据只会从空变全,不存在要切回去的情形。
 */
const applyLogScale = (s: AnySeries) =>
  s.priceScale().applyOptions({ mode: 1, scaleMargins: { top: 0.05, bottom: 0.05 } });

// 按 kind 建对应 series,并挂上各自的参考线/背景带。
function addSeries(chart: IChartApi, spec: Spec): AnySeries {
  if (spec.kind === 'candle') {
    const candles = chart.addSeries(
      CandlestickSeries,
      {
        title: spec.title,
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
        priceLineVisible: false,
      },
      spec.pane,
    );
    return candles;
  }

  if (spec.kind === 'histogram') {
    const s = chart.addSeries(
      HistogramSeries,
      {
        title: spec.title,
        base: 0,
        priceLineVisible: false,
        ...(spec.priceScaleId ? { priceScaleId: spec.priceScaleId, lastValueVisible: false } : {}),
      },
      spec.pane,
    );
    // overlay 背景带:独立轴去掉上下留白 → 柱子满 pane 高;给 scaleTop 则只占底部一条。
    if (spec.priceScaleId) s.priceScale().applyOptions({ scaleMargins: { top: spec.scaleTop ?? 0, bottom: 0 } });
    if (spec.baseline !== undefined) {
      s.createPriceLine({
        price: spec.baseline,
        color: '#71717a',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: '0',
      });
    }
    return s;
  }

  const s = chart.addSeries(
    LineSeries,
    {
      color: spec.color,
      // 叠加线不给 title:lightweight-charts 会把 title 单独画成右轴标签(关了 lastValueVisible 也照画);图例读 seriesName 不受影响。
      title: spec.overlay ? '' : spec.title,
      lineWidth: spec.overlay ? 1 : 2,
      ...(spec.overlay ? { priceLineVisible: false, lastValueVisible: false } : {}),
      // 阶梯线:低频序列(季频)不该在两次发布之间画出斜坡,那是凭空造出来的中间值。
      ...(spec.step ? { lineType: LineType.WithSteps } : {}),
    },
    spec.pane,
  );
  // 轴的上限框。lightweight-charts 只开 autoscaleInfoProvider 这一个口子,故回调在这里就地收掉 ——
  // spec 层只声明 [lo, hi];语义(求交 / 倒挂退回 / null 守卫)在 lib/chart 的纯函数里,那边有变异检验覆盖。
  if (spec.clampVisibleTo)
    s.applyOptions({ autoscaleInfoProvider: clampAutoscaleProvider<AutoscaleInfo>(spec.clampVisibleTo) });
  if (spec.expandVisibleTo)
    s.applyOptions({ autoscaleInfoProvider: expandAutoscaleProvider<AutoscaleInfo>(spec.expandVisibleTo) });
  if (spec.baseline !== undefined) {
    s.createPriceLine({
      price: spec.baseline,
      color: '#71717a',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      // 标题跟着基线值走:扩散指数的分界线是 50、比值类是 1,写死 '0' 会在那几格上标错。
      title: String(spec.baseline),
    });
  }
  // 参考线(如情绪指标的 P10/P90 分位带);期权侧不传 refLines 即无。
  if (spec.refLines) {
    for (const rl of spec.refLines) {
      s.createPriceLine({
        price: rl.price,
        color: rl.color ?? '#71717a',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: rl.title,
      });
    }
  }
  return s;
}

/** 时间轴签名:逐条非叠加 series 的 key + 首尾时间 + 点数。叠加指标线(overlay)不计入 ——
 *  它们由蜡烛派生、增删不该把视野弹回全景;任何一条底层序列的数据变了(换周期 / 新数据到)签名就变。 */
function timeSpan(specs: Spec[]): string {
  return specs
    .filter((s) => !(s.kind === 'line' && s.overlay))
    .map((s) => `${s.key}:${s.data[0]?.time ?? ''}:${s.data[s.data.length - 1]?.time ?? ''}:${s.data.length}`)
    .join('|');
}

// ── 图表引擎维度:持有 chart + series 句柄,负责建图与 series 同步 ──────────────
export function usePaneChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paneCount: number,
  rawSpecs: Spec[],
) {
  const specs = useStable(rawSpecs);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, AnySeries>>(new Map());
  const [seriesVersion, setSeriesVersion] = useState(0); // series 建/删后自增,供画线 hook 感知 series 就绪
  const spanRef = useRef(''); // 上次 fitContent 时的时间轴签名
  const fillRef = useRef<Map<string, BandFillPrimitive>>(new Map()); // 线间填色图元,按挂载的 series key

  // 建图 + 加 pane。paneCount 每实例固定,等价于挂载建一次、卸载销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    const seriesMap = seriesRef.current; // 同一 Map(useRef 只建一次),捕获供 cleanup 用
    const fillMap = fillRef.current;
    for (let i = 1; i < paneCount; i++) chart.addPane(); // pane 0 默认已存在
    chart.panes().forEach((p) => {
      p.setStretchFactor(1);
    }); // 等高,可拖分隔条调整
    return () => {
      chart.remove();
      seriesMap.clear();
      fillMap.clear(); // 图元随 chart.remove() 一起销毁
      chartRef.current = null;
      spanRef.current = ''; // 重建后的新图要重新 fit
    };
  }, [containerRef, paneCount]);

  // 数据/聚合变化时同步 series:缺的删、没有的建、有的 setData。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // specs 里已消失的 series:删掉。
    const keysNow = new Set(specs.map((s) => s.key));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) {
        chart.removeSeries(s);
        seriesRef.current.delete(k);
        fillRef.current.delete(k); // 挂在它身上的填色图元随 series 一起没了
      }
    }

    // 缺的建,已有的直接 setData。
    for (const spec of specs) {
      let s = seriesRef.current.get(spec.key);
      if (!s) {
        s = addSeries(chart, spec);
        seriesRef.current.set(spec.key, s);
      } else if (spec.kind === 'line') {
        // 复用的 series 不会重读 spec 颜色;同 key 换了配色(如改均线周期)要显式同步,否则线色与图例对不上。
        s.applyOptions({ color: spec.color });
      }
      s.setData(spec.data as Parameters<AnySeries['setData']>[0]);
      if (spec.kind === 'candle' && needsLogScale(spec.data)) applyLogScale(s);
    }

    // 线间填色:挂在声明 fillTo 的那条线上,按时间与对端线配对。
    const byKey = new Map(specs.map((sp) => [sp.key, sp]));
    for (const spec of specs) {
      if (spec.kind !== 'line' || !spec.fillTo) continue;
      const other = byKey.get(spec.fillTo.key);
      const s = seriesRef.current.get(spec.key);
      if (other?.kind !== 'line' || !s) continue;
      let prim = fillRef.current.get(spec.key);
      if (!prim) {
        prim = new BandFillPrimitive();
        s.attachPrimitive(prim);
        fillRef.current.set(spec.key, prim);
      }
      const lower = new Map(other.data.map((p) => [p.time, p.value]));
      const points = spec.data.flatMap((p) => {
        const l = lower.get(p.time);
        return l === undefined ? [] : [{ time: p.time, upper: p.value, lower: l }];
      });
      prim.setData(points, spec.fillTo.color);
    }

    // 只在时间轴真变了(换周期 / 新数据到)才 fitContent;勾一条叠加指标不该把用户缩放好的视野弹回全景。
    const span = timeSpan(specs);
    if (span !== spanRef.current) {
      spanRef.current = span;
      chart.timeScale().fitContent();
    }
    setSeriesVersion((v) => v + 1); // series 已就绪/变更,通知依赖方(趋势线挂载)
  }, [specs]);

  return { chartRef, seriesRef, seriesVersion };
}

// ── 布局维度:pane 上下换位(order)+ 折叠显隐(collapsed)──────────────────────
export function usePaneLayout(
  rawPaneDefs: PaneDef[],
  paneCount: number,
  chartRef: React.RefObject<IChartApi | null>,
  seriesRef: React.RefObject<Map<string, AnySeries>>,
) {
  const paneDefs = useStable(rawPaneDefs);
  const [order, setOrder] = useState<string[]>(() => paneDefs.map((d) => d.key));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // 折叠应用:收起的 pane 给极小 stretch(near-0)+ 隐藏其线(否则薄条里仍画线)。
  // 按显示顺序 order[i] 对应 chart.panes()[i]。初次 collapsed 为空时是无害的全展开,
  // 真正的隐藏发生在用户点击后(此时 series 已建好)。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.panes().forEach((p, i) => {
      p.setStretchFactor(collapsed.has(order[i]) ? 0.0001 : 1);
    });
    for (const d of paneDefs) {
      const visible = !collapsed.has(d.key);
      d.series.forEach((sk) => {
        seriesRef.current.get(sk)?.applyOptions({ visible });
      });
    }
  }, [collapsed, order, paneDefs, chartRef, seriesRef]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(key)) {
        n.delete(key);
      } else if (n.size + 1 >= paneCount) {
        return prev; // 至少留一个展开:全收起时权重都=0.0001 会被均分,等于没收起
      } else {
        n.add(key);
      }
      return n;
    });

  // 上下换位:移动整个 pane(连同纵轴),不合并。chart 与 order 同步交换。
  const move = (key: string, dir: -1 | 1) => {
    const chart = chartRef.current;
    if (!chart) return;
    const i = order.indexOf(key);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    chart.panes()[i].moveTo(j);
    setOrder((prev) => {
      const n = [...prev];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };

  // 单独看某一格(收起其余);再按一次按进入前的折叠状态恢复。
  // 进入前的状态只在点击时读写、渲染不读 → 放 ref。「是否在单独看」由 collapsed 派生,
  // 手动展开任一格就自然退出,不会出现按钮状态与实际布局不符。
  const beforeSoloRef = useRef<Set<string> | null>(null);
  const solo = (key: string) => {
    const isSolo = paneDefs.every((d) => d.key === key || collapsed.has(d.key));
    if (isSolo) {
      setCollapsed(beforeSoloRef.current ?? new Set());
      beforeSoloRef.current = null;
    } else {
      beforeSoloRef.current = collapsed;
      setCollapsed(new Set(paneDefs.map((d) => d.key).filter((k) => k !== key)));
    }
  };

  return { order, collapsed, move, toggle, solo };
}

// ── 图例维度:crosshair 取值 + 各 pane 顶部偏移(定位图例)──────────────────────
export function useCrosshairLegend(
  chartRef: React.RefObject<IChartApi | null>,
  seriesRef: React.RefObject<Map<string, AnySeries>>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  order: string[],
  collapsed: Set<string>,
) {
  const [cells, setCells] = useState<Record<string, LegendCell>>({}); // 竖线处各 series 的图例格
  const [tops, setTops] = useState<number[]>([]); // 各 pane 顶部像素偏移

  // 竖线滑动:读各 series 当前点(蜡烛 OHLC / 线 value)+ 用 logical-1 取前值算 Δ/Δ%。不悬停 → 空。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: { seriesData: Map<unknown, unknown>; logical?: number }) => {
      const next: Record<string, LegendCell> = {};
      const prevIdx = param.logical == null ? undefined : param.logical - 1;
      for (const [key, s] of seriesRef.current) {
        const d = param.seriesData.get(s) as
          | { value?: number; open?: number; high?: number; low?: number; close?: number }
          | undefined;
        if (!d) continue;
        const prev =
          prevIdx == null ? undefined : (s.dataByIndex(prevIdx) as { value?: number; close?: number } | null);
        if (typeof d.open === 'number' && typeof d.close === 'number') {
          const st = changeStats(d.close, typeof prev?.close === 'number' ? prev.close : undefined);
          next[key] = {
            kind: 'candle',
            open: d.open,
            high: d.high!,
            low: d.low!,
            close: d.close,
            delta: st?.delta ?? null,
            pct: st?.pct ?? null,
          };
        } else if (typeof d.value === 'number') {
          const st = changeStats(d.value, typeof prev?.value === 'number' ? prev.value : undefined);
          next[key] = { kind: 'line', value: d.value, delta: st?.delta ?? null, pct: st?.pct ?? null };
        }
      }
      setCells(next);
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [chartRef, seriesRef]);

  // pane 顶部偏移随布局(order/collapsed)和容器尺寸变化;rAF 读取重排后的高度。
  useEffect(() => {
    const recompute = () =>
      requestAnimationFrame(() => {
        const chart = chartRef.current;
        if (!chart) return;
        const t: number[] = [];
        let acc = 0;
        for (const p of chart.panes()) {
          t.push(acc);
          acc += p.getHeight() + 1;
        }
        setTops(t);
      });
    recompute();
    const ro = new ResizeObserver(recompute);
    const el = containerRef.current;
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [order, collapsed, chartRef, containerRef]);

  const hovering = Object.keys(cells).length > 0; // 鼠标在图内、crosshair 有值
  return { cells, hovering, tops };
}

// ── 组合:引擎 + 布局 + 图例 一处接线,供 AssetChart / RegimeChart 共用(避免两处接线漂移)。
// drawable 传入 → 额外接入趋势线画线能力(opt-in;纯折线曲线图不传即零影响)。
export function usePaneChartStack(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paneDefs: PaneDef[],
  paneCount: number,
  specs: Spec[],
  drawable?: { storageKey: string },
) {
  const { chartRef, seriesRef, seriesVersion } = usePaneChart(containerRef, paneCount, specs);
  const { order, collapsed, move, toggle, solo } = usePaneLayout(paneDefs, paneCount, chartRef, seriesRef);
  const { cells, hovering, tops } = useCrosshairLegend(chartRef, seriesRef, containerRef, order, collapsed);
  const { drawing, toggleDrawing, selection, deleteSelected } = useTrendlines({
    chartRef,
    seriesRef,
    containerRef,
    paneDefs,
    order,
    storageKey: drawable?.storageKey ?? '',
    enabled: drawable != null,
    seriesVersion,
  });
  return {
    order,
    collapsed,
    move,
    toggle,
    cells,
    hovering,
    tops,
    drawing,
    toggleDrawing,
    selection,
    deleteSelected,
    solo,
    chartRef, // 供主图外的同步方(如下方副图)订阅可视范围 / 十字线
  };
}
