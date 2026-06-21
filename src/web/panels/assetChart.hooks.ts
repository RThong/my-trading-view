// AssetChart 的横向功能维度,每块一个 hook,组件只负责拼装 + JSX。
// 前提:每个 AssetChart 实例与一个标的绑定一辈子(App 用 keep-alive 渲染,
// 切 tab 不卸载),所以这里所有 effect 都是「挂载建/卸载销」,不再按标的 reset。
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Interval } from '../hooks/interval';
import { CHART_OPTIONS, aggregate, type LinePoint } from '../lib/chart';

export type OptRow = { date: string; callIv: number; putIv: number; skew: number };
export type VrpRow = { date: string; iv: number; rv: number; vrp: number };
export type PaneDef = { key: string; label: string; series: string[] };
export type Spec = { key: string; pane: number; color: string; title: string; data: LinePoint[] };

export const COLORS = {
  call: '#22c55e', put: '#ec4899', skew: '#3b82f6',
  iv: '#3b82f6', rv: '#f59e0b', vrp: '#22c55e',
};
const HISTORY_DAYS = 3650;

// 稳定空引用:data 未就绪时避免每次 render 新建 [] 触发图表 effect。
const NO_OPT: OptRow[] = [];
const NO_VRP: VrpRow[] = [];
// EOD 数据一会话内视为不变:关掉全部自动重验。模块级常量,引用稳定。
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

/** pane 元数据 + series 短名(右轴 tag / 左上图例同一命名源)。按 vrpUnderlying 决定 2 或 4 个 pane。 */
// 各标的 VRP 隐含腿用的波动率指数名(图例显示「隐含 (VXN)」等)。
// ponytail: 与 server/routes/vrp.ts 的 RECIPE.iv 是同一份映射,改一处必同步另一处
// (跨 client/server,5 条目不值得抽 shared/ 常量,但别只改一边——否则图例名和数据腿对不上)。
const IV_INDEX: Record<string, string> = { SPY: 'VIX', QQQ: 'VXN', GLD: 'GVZ', USO: 'OVX', BTC: 'DVOL' };

export function paneConfig(vrpUnderlying?: string) {
  const ivName = vrpUnderlying ? (IV_INDEX[vrpUnderlying] ?? 'IV') : 'IV';
  const seriesName: Record<string, string> = {
    call: 'Call IV', put: 'Put IV', skew: 'Skew',
    iv: `隐含 (${ivName})`, rv: '已实现 RV', vrp: 'VRP',
  };
  const paneDefs: PaneDef[] = vrpUnderlying
    ? [
        { key: 'iv', label: 'IV', series: ['call', 'put'] },
        { key: 'skew', label: 'Skew', series: ['skew'] },
        { key: 'ivrv', label: '隐含/RV', series: ['iv', 'rv'] },
        { key: 'vrp', label: 'VRP', series: ['vrp'] },
      ]
    : [
        { key: 'iv', label: 'IV', series: ['call', 'put'] },
        { key: 'skew', label: 'Skew', series: ['skew'] },
      ];
  return { seriesName, paneDefs, paneCount: paneDefs.length === 4 ? 4 : 2 };
}

const toLine = (rows: Array<Record<string, unknown>>, key: string): LinePoint[] =>
  rows.map((r) => ({ time: r.date as string, value: r[key] as number }));

/** 把数据按 interval 聚合成各 series 的 LinePoint;pane 下标 = series 创建顺序。 */
export function buildSpecs(
  opt: OptRow[], vrp: VrpRow[], interval: Interval,
  vrpUnderlying: string | undefined, seriesName: Record<string, string>,
): Spec[] {
  return [
    { key: 'call', pane: 0, color: COLORS.call, title: seriesName.call, data: aggregate(toLine(opt, 'callIv'), interval) },
    { key: 'put',  pane: 0, color: COLORS.put,  title: seriesName.put,  data: aggregate(toLine(opt, 'putIv'),  interval) },
    { key: 'skew', pane: 1, color: COLORS.skew, title: seriesName.skew, data: aggregate(toLine(opt, 'skew'),   interval) },
    ...(vrpUnderlying ? [
      { key: 'iv',  pane: 2, color: COLORS.iv,  title: seriesName.iv,  data: aggregate(toLine(vrp, 'iv'),  interval) },
      { key: 'rv',  pane: 2, color: COLORS.rv,  title: seriesName.rv,  data: aggregate(toLine(vrp, 'rv'),  interval) },
      { key: 'vrp', pane: 3, color: COLORS.vrp, title: seriesName.vrp, data: aggregate(toLine(vrp, 'vrp'), interval) },
    ] : []),
  ];
}

// ── 数据维度 ──────────────────────────────────────────────────────────────
export function useAssetData(underlying: string, vrpUnderlying?: string) {
  // vrpUrl 为 null 时 SWR 原生跳过请求(.VIX 无 VRP)。
  const optUrl = `/api/options/25delta/${encodeURIComponent(underlying)}?days=${HISTORY_DAYS}`;
  const vrpUrl = vrpUnderlying ? `/api/vrp/${encodeURIComponent(vrpUnderlying)}` : null;
  const { data: opt = NO_OPT, error: oe, isLoading: optLoading } = useSWR(optUrl, getJson<OptRow[]>, SWR_OPTS);
  const { data: vrp = NO_VRP, error: ve, isLoading: vrpLoading } = useSWR(vrpUrl, getJson<VrpRow[]>, SWR_OPTS);
  return { opt, vrp, error: (oe ?? ve) as Error | undefined, isLoading: optLoading || vrpLoading };
}

// ── 图表引擎维度:持有 chart + series 句柄,负责建图与 series 同步 ──────────────
export function usePaneChart(
  containerRef: React.RefObject<HTMLDivElement | null>, paneCount: number, specs: Spec[],
) {
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  // 建图 + 加 pane。paneCount 每实例固定,等价于挂载建一次、卸载销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    for (let i = 1; i < paneCount; i++) chart.addPane(); // pane 0 默认已存在
    chart.panes().forEach((p) => p.setStretchFactor(1)); // 等高,可拖分隔条调整
    return () => { chart.remove(); chartRef.current = null; seriesRef.current.clear(); };
  }, [containerRef, paneCount]);

  // 数据/聚合变化时同步 series:缺的删、没有的建、有的 setData。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const keysNow = new Set(specs.map((s) => s.key));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) { chart.removeSeries(s); seriesRef.current.delete(k); }
    }
    for (const spec of specs) {
      let line = seriesRef.current.get(spec.key);
      if (!line) {
        line = chart.addSeries(LineSeries, { color: spec.color, title: spec.title, lineWidth: 2 }, spec.pane);
        seriesRef.current.set(spec.key, line);
      }
      line.setData(spec.data);
    }
    chart.timeScale().fitContent();
  }, [specs]);

  return { chartRef, seriesRef };
}

// ── 布局维度:pane 上下换位(order)+ 折叠显隐(collapsed)──────────────────────
export function usePaneLayout(
  paneDefs: PaneDef[], paneCount: number,
  chartRef: React.RefObject<IChartApi | null>,
  seriesRef: React.RefObject<Map<string, ISeriesApi<'Line'>>>,
) {
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
  seriesRef: React.RefObject<Map<string, ISeriesApi<'Line'>>>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  order: string[], collapsed: Set<string>,
) {
  const [vals, setVals] = useState<Record<string, number>>({}); // 竖线处各 series 值
  const [tops, setTops] = useState<number[]>([]);                // 各 pane 顶部像素偏移

  // 竖线滑动:从 crosshair 读各 series 在该时间点的值;不悬停时清空,图例回落末值。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: { seriesData: Map<unknown, unknown> }) => {
      const next: Record<string, number> = {};
      for (const [key, s] of seriesRef.current) {
        const d = param.seriesData.get(s) as { value?: number } | undefined;
        if (d && typeof d.value === 'number') next[key] = d.value;
      }
      setVals(next);
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

  const hovering = Object.keys(vals).length > 0; // 鼠标在图内、crosshair 有值
  return { vals, hovering, tops };
}
