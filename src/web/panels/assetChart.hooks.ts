// AssetChart 的横向功能维度,每块一个 hook,组件只负责拼装 + JSX。
// 前提:每个 AssetChart 实例与一个标的绑定一辈子(App 用 keep-alive 渲染,
// 切 tab 不卸载),所以这里所有 effect 都是「挂载建/卸载销」,不再按标的 reset。
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { createChart, LineSeries, CandlestickSeries, HistogramSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Interval } from '../hooks/interval';
import { useStable } from '../hooks/useStable';
import { CHART_OPTIONS, aggregate, aggregateBars, changeStats, type LinePoint, type Bar } from '../lib/chart';

export type OptRow = { date: string; callIv: number; putIv: number; skew: number };
export type VrpRow = { date: string; iv: number; rv: number; vrp: number };
export type PriceBar = { date: string; open: number | null; high: number | null; low: number | null; close: number };
export type PaneDef = { key: string; label: string; series: string[] };
export type LineSpec = { key: string; pane: number; kind: 'line'; color: string; title: string; data: LinePoint[]; baseline?: number; refLines?: { price: number; title: string }[] };
export type CandleSpec = { key: string; pane: number; kind: 'candle'; title: string; data: Bar[] };
export type HistoPoint = { time: string; value: number; color: string };
// priceScaleId 给定 → 挂独立 overlay 轴(自身 0–1 自缩放),用来画满高度背景带(极端期着色)。
export type HistoSpec = { key: string; pane: number; kind: 'histogram'; title: string; data: HistoPoint[]; baseline?: number; priceScaleId?: string };
export type Spec = LineSpec | CandleSpec | HistoSpec;
export type LegendCell =
  | { kind: 'candle'; open: number; high: number; low: number; close: number; delta: number | null; pct: number | null }
  | { kind: 'line'; value: number; delta: number | null; pct: number | null };
type AnySeries = ISeriesApi<'Line' | 'Candlestick' | 'Histogram'>;

export const COLORS = {
  price: '#d4d4d8', // 现货图例文字(蜡烛本身用涨绿跌红)
  call: '#22c55e', put: '#ec4899', skew: '#3b82f6',
  iv: '#3b82f6', rv: '#f59e0b', vrp: '#22c55e',
};
const HISTORY_DAYS = 3650;

// 稳定空引用:data 未就绪时避免每次 render 新建 [] 触发图表 effect。
const NO_OPT: OptRow[] = [];
const NO_VRP: VrpRow[] = [];
const NO_PRICE: PriceBar[] = [];
// EOD 数据一会话内视为不变:关掉全部自动重验。模块级常量,引用稳定。
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

/** pane 元数据 + series 短名(右轴 tag / 左上图例同一命名源)。所有 tab 顶部都有现货 pane;
 *  有 vrpUnderlying 的再加 隐含/RV + VRP 两个 pane。 */
// 各标的 VRP 隐含腿用的波动率指数名(图例显示「隐含 (VXN)」等)。
// ponytail: 与 server/routes/vrp.ts 的 RECIPE.iv 是同一份映射,改一处必同步另一处
// (跨 client/server,5 条目不值得抽 shared/ 常量,但别只改一边——否则图例名和数据腿对不上)。
const IV_INDEX: Record<string, string> = { SPY: 'VIX', QQQ: 'VXN', GLD: 'GVZ', USO: 'OVX', BTC: 'DVOL' };

export function paneConfig(vrpUnderlying?: string) {
  const ivName = vrpUnderlying ? (IV_INDEX[vrpUnderlying] ?? 'IV') : 'IV';
  const seriesName: Record<string, string> = {
    price: '现货', call: 'Call IV', put: 'Put IV', skew: 'Skew',
    iv: `隐含 (${ivName})`, rv: '已实现 RV', vrp: 'VRP',
  };
  const paneDefs: PaneDef[] = [
    { key: 'price', label: '现货', series: ['price'] },
    { key: 'iv', label: 'IV', series: ['call', 'put'] },
    { key: 'skew', label: 'Skew', series: ['skew'] },
    ...(vrpUnderlying ? [
      { key: 'ivrv', label: '隐含/RV', series: ['iv', 'rv'] },
      { key: 'vrp', label: 'VRP', series: ['vrp'] },
    ] : []),
    // VX1−V3 期限结构已搬到情绪视角(见 regimeChart.hooks);.VIX 只到 skew。
  ];
  const desc: Record<string, string> = {
    price: '定义:标的现货价(蜡烛)。\n期权指标的锚;和下面 IV / skew / VRP 对照看价格与波动的关系。',
    iv: '定义:25Δ 看涨 / 看跌期权隐含波动率。\n市场对该标的未来波动的定价。\nCall vs Put 的高低差就是 skew 的来源。',
    skew: '定义:25Δ 风险逆转(put IV − call IV)。\n符号:高 = 25Δ put 比 call 贵;低 / 负 = call 比 put 贵。\n情绪含义按标的分:普通权益(SPY/QQQ/GLD 等)高 = 抢下行保护 / 避险;但 VIX 等波动率标的 call 常被抢(赌波动上冲),负值不等于自满。\n注意:高 IV 标的采样点被推出活跃区,skew 偏噪声。',
    ivrv: '定义:隐含波动率(IV)vs 截至当日的历史已实现波动率(RV)。\nIV 持续高于近期 RV = 期权偏贵;能否变成卖方收益还要看随后实现的波动 + 成本。',
    vrp: '定义:当日 IV − 近期历史 RV 的价差(不是前瞻可实现收益)。\n正 = IV 高于近期 RV(通常卖方占优,但要与随后实现波动比才算数);负 = IV 低于近期 RV / 应激。',
  };
  return { seriesName, paneDefs, desc, paneCount: paneDefs.length };
}

const toLine = (rows: Array<Record<string, unknown>>, key: string): LinePoint[] =>
  rows.map((r) => ({ time: r.date as string, value: r[key] as number }));
// OHLC 缺失(个别源)时退化成 close 的一字蜡烛,避免 setData 报错。
const toBars = (rows: PriceBar[]): Bar[] =>
  rows.map((r) => ({ time: r.date, open: r.open ?? r.close, high: r.high ?? r.close, low: r.low ?? r.close, close: r.close }));

/** 把数据按 interval 聚合成各 series 的 spec;pane 下标从 paneDefs 派生(谁含此 series)。 */
export function buildSpecs(
  opt: OptRow[], vrp: VrpRow[], price: PriceBar[], interval: Interval,
  vrpUnderlying: string | undefined, paneDefs: PaneDef[], seriesName: Record<string, string>,
): Spec[] {
  const paneOf = (key: string) => paneDefs.findIndex((d) => d.series.includes(key));
  const line = (key: string, rows: Array<Record<string, unknown>>, field: string, color: string): LineSpec =>
    ({ key, pane: paneOf(key), kind: 'line', color, title: seriesName[key], data: aggregate(toLine(rows, field), interval) });
  return [
    { key: 'price', pane: paneOf('price'), kind: 'candle', title: seriesName.price, data: aggregateBars(toBars(price), interval) },
    line('call', opt, 'callIv', COLORS.call),
    line('put', opt, 'putIv', COLORS.put),
    line('skew', opt, 'skew', COLORS.skew),
    ...(vrpUnderlying ? [
      line('iv', vrp, 'iv', COLORS.iv),
      line('rv', vrp, 'rv', COLORS.rv),
      line('vrp', vrp, 'vrp', COLORS.vrp),
    ] : []),
  ];
}

// ── 数据维度 ──────────────────────────────────────────────────────────────
export function useAssetData(underlying: string, vrpUnderlying?: string) {
  // vrpUrl 为 null 时 SWR 原生跳过请求(.VIX 无 VRP)。
  const optUrl = `/api/options/25delta/${encodeURIComponent(underlying)}?days=${HISTORY_DAYS}`;
  const vrpUrl = vrpUnderlying ? `/api/vrp/${encodeURIComponent(vrpUnderlying)}` : null;
  const priceUrl = `/api/price/${encodeURIComponent(underlying)}`;
  const { data: opt = NO_OPT, error: oe, isLoading: optLoading } = useSWR(optUrl, getJson<OptRow[]>, SWR_OPTS);
  const { data: vrp = NO_VRP, error: ve, isLoading: vrpLoading } = useSWR(vrpUrl, getJson<VrpRow[]>, SWR_OPTS);
  const { data: price = NO_PRICE, error: pe, isLoading: priceLoading } = useSWR(priceUrl, getJson<PriceBar[]>, SWR_OPTS);
  return {
    opt, vrp, price,
    error: (oe ?? ve ?? pe) as Error | undefined,
    isLoading: optLoading || vrpLoading || priceLoading,
  };
}

// 按 kind 建对应 series,并挂上各自的参考线/背景带。
function addSeries(chart: IChartApi, spec: Spec): AnySeries {
  if (spec.kind === 'candle') {
    return chart.addSeries(CandlestickSeries, {
      title: spec.title, upColor: '#22c55e', downColor: '#ef4444', borderVisible: false,
      wickUpColor: '#22c55e', wickDownColor: '#ef4444', priceLineVisible: false,
    }, spec.pane);
  }

  if (spec.kind === 'histogram') {
    const s = chart.addSeries(HistogramSeries, {
      title: spec.title, base: 0, priceLineVisible: false,
      ...(spec.priceScaleId ? { priceScaleId: spec.priceScaleId, lastValueVisible: false } : {}),
    }, spec.pane);
    // overlay 背景带:独立轴去掉上下留白 → 柱子满 pane 高。
    if (spec.priceScaleId) s.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
    if (spec.baseline !== undefined) {
      s.createPriceLine({ price: spec.baseline, color: '#71717a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '0' });
    }
    return s;
  }

  const s = chart.addSeries(LineSeries, { color: spec.color, title: spec.title, lineWidth: 2 }, spec.pane);
  if (spec.baseline !== undefined) {
    s.createPriceLine({ price: spec.baseline, color: '#71717a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '0' });
  }
  // 参考线(如情绪指标的 P10/P90 分位带);期权侧不传 refLines 即无。
  if (spec.refLines) {
    for (const rl of spec.refLines) {
      s.createPriceLine({ price: rl.price, color: '#71717a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: rl.title });
    }
  }
  return s;
}

// ── 图表引擎维度:持有 chart + series 句柄,负责建图与 series 同步 ──────────────
export function usePaneChart(
  containerRef: React.RefObject<HTMLDivElement | null>, paneCount: number, rawSpecs: Spec[],
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
    chart.panes().forEach((p) => p.setStretchFactor(1)); // 等高,可拖分隔条调整
    return () => { chart.remove(); seriesMap.clear(); chartRef.current = null; };
  }, [containerRef, paneCount]);

  // 数据/聚合变化时同步 series:缺的删、没有的建、有的 setData。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // specs 里已消失的 series:删掉。
    const keysNow = new Set(specs.map((s) => s.key));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) { chart.removeSeries(s); seriesRef.current.delete(k); }
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
  rawPaneDefs: PaneDef[], paneCount: number,
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
    chart.panes().forEach((p, i) => p.setStretchFactor(collapsed.has(order[i]) ? 0.0001 : 1));
    for (const d of paneDefs) {
      const visible = !collapsed.has(d.key);
      d.series.forEach((sk) => seriesRef.current.get(sk)?.applyOptions({ visible }));
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
  order: string[], collapsed: Set<string>,
) {
  const [cells, setCells] = useState<Record<string, LegendCell>>({}); // 竖线处各 series 的图例格
  const [tops, setTops] = useState<number[]>([]);                      // 各 pane 顶部像素偏移

  // 竖线滑动:读各 series 当前点(蜡烛 OHLC / 线 value)+ 用 logical-1 取前值算 Δ/Δ%。不悬停 → 空。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: { seriesData: Map<unknown, unknown>; logical?: number }) => {
      const next: Record<string, LegendCell> = {};
      const prevIdx = param.logical == null ? undefined : param.logical - 1;
      for (const [key, s] of seriesRef.current) {
        const d = param.seriesData.get(s) as
          { value?: number; open?: number; high?: number; low?: number; close?: number } | undefined;
        if (!d) continue;
        const prev = prevIdx == null ? undefined
          : (s.dataByIndex(prevIdx) as { value?: number; close?: number } | null);
        if (typeof d.open === 'number' && typeof d.close === 'number') {
          const st = changeStats(d.close, typeof prev?.close === 'number' ? prev.close : undefined);
          next[key] = { kind: 'candle', open: d.open, high: d.high!, low: d.low!, close: d.close, delta: st?.delta ?? null, pct: st?.pct ?? null };
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
        for (const p of chart.panes()) { t.push(acc); acc += p.getHeight() + 1; }
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
  containerRef: React.RefObject<HTMLDivElement | null>, paneDefs: PaneDef[], paneCount: number, specs: Spec[],
) {
  const { chartRef, seriesRef } = usePaneChart(containerRef, paneCount, specs);
  const { order, collapsed, move, toggle } = usePaneLayout(paneDefs, paneCount, chartRef, seriesRef);
  const { cells, hovering, tops } = useCrosshairLegend(chartRef, seriesRef, containerRef, order, collapsed);
  return { order, collapsed, move, toggle, cells, hovering, tops };
}
