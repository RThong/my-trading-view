// 通用多 pane 图表栈:图表引擎(建图/series 同步)+ 布局(换位/折叠)+ 图例(crosshair)。
// 与数据源无关——AssetChart / RegimeChart / AttackDefensePanel 三方复用,故从 assetChart.hooks 抽出。
import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries, CandlestickSeries, HistogramSeries, type IChartApi } from 'lightweight-charts';
import { useStable } from '../hooks/useStable';
import { CHART_OPTIONS, changeStats } from '../lib/chart';
import type { PaneDef, Spec, LegendCell, AnySeries } from './paneChart.types';

// 按 kind 建对应 series,并挂上各自的参考线/背景带。
function addSeries(chart: IChartApi, spec: Spec): AnySeries {
  if (spec.kind === 'candle') {
    return chart.addSeries(
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
    // overlay 背景带:独立轴去掉上下留白 → 柱子满 pane 高。
    if (spec.priceScaleId) s.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
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

  const s = chart.addSeries(LineSeries, { color: spec.color, title: spec.title, lineWidth: 2 }, spec.pane);
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
  // 参考线(如情绪指标的 P10/P90 分位带);期权侧不传 refLines 即无。
  if (spec.refLines) {
    for (const rl of spec.refLines) {
      s.createPriceLine({
        price: rl.price,
        color: '#71717a',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: rl.title,
      });
    }
  }
  return s;
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

  // 建图 + 加 pane。paneCount 每实例固定,等价于挂载建一次、卸载销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    const seriesMap = seriesRef.current; // 同一 Map(useRef 只建一次),捕获供 cleanup 用
    for (let i = 1; i < paneCount; i++) chart.addPane(); // pane 0 默认已存在
    chart.panes().forEach((p) => {
      p.setStretchFactor(1);
    }); // 等高,可拖分隔条调整
    return () => {
      chart.remove();
      seriesMap.clear();
      chartRef.current = null;
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
      }
    }

    // 缺的建,已有的直接 setData。
    for (const spec of specs) {
      let s = seriesRef.current.get(spec.key);
      if (!s) {
        s = addSeries(chart, spec);
        seriesRef.current.set(spec.key, s);
      }
      s.setData(spec.data as Parameters<AnySeries['setData']>[0]);
    }

    chart.timeScale().fitContent();
  }, [specs]);

  return { chartRef, seriesRef };
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

  return { order, collapsed, move, toggle };
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
export function usePaneChartStack(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paneDefs: PaneDef[],
  paneCount: number,
  specs: Spec[],
) {
  const { chartRef, seriesRef } = usePaneChart(containerRef, paneCount, specs);
  const { order, collapsed, move, toggle } = usePaneLayout(paneDefs, paneCount, chartRef, seriesRef);
  const { cells, hovering, tops } = useCrosshairLegend(chartRef, seriesRef, containerRef, order, collapsed);
  return { order, collapsed, move, toggle, cells, hovering, tops };
}
