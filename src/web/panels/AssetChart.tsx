import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Interval } from '../hooks/interval';
import { CHART_OPTIONS, aggregate, type LinePoint } from '../lib/chart';

// 一个资产的全部期权指标,放进同一个 chart 的多个 pane(共享时间轴):
//   pane0 25Δ call/put IV · pane1 skew · pane2 隐含vs已实现RV · pane3 VRP
// VRP 仅 SPY/BTC 有(vrpUnderlying 给定时);VIX 只有前两个 pane。
type OptRow = { date: string; callIv: number; putIv: number; skew: number };
type VrpRow = { date: string; iv: number; rv: number; vrp: number };

const COLORS = {
  call: '#22c55e', put: '#ec4899', skew: '#3b82f6',
  iv: '#3b82f6', rv: '#f59e0b', vrp: '#22c55e',
};
const HISTORY_DAYS = 3650;

// 稳定空引用:data 未就绪时避免每次 render 都新建 [] 触发图表 effect。
const NO_OPT: OptRow[] = [];
const NO_VRP: VrpRow[] = [];

// EOD 数据一会话内视为不变:关掉全部自动重验。模块级常量,引用稳定。
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

export function AssetChart({
  interval,
  underlying,
  vrpUnderlying,
}: {
  interval: Interval;
  underlying: string;
  vrpUnderlying?: string;
}) {
  const label = underlying.replace(/^\./, '');
  // series 短名:既作右轴 tag 的 title,也作左上图例的名字(单一命名源)。
  const ivName = vrpUnderlying === 'BTC' ? 'DVOL' : 'VIX';
  const SERIES_NAME: Record<string, string> = {
    call: 'Call IV', put: 'Put IV', skew: 'Skew',
    iv: `隐含 (${ivName})`, rv: '已实现 RV', vrp: 'VRP',
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  // SWR:按 url 缓存,切 tab 回来命中缓存不重复请求(重验开关见 SWR_OPTS)。
  // vrpUrl 为 null 时 SWR 原生跳过该请求(SOXX/IGV/VIX 无 VRP)。
  const optUrl = `/api/options/25delta/${encodeURIComponent(underlying)}?days=${HISTORY_DAYS}`;
  const vrpUrl = vrpUnderlying ? `/api/vrp/${encodeURIComponent(vrpUnderlying)}` : null;
  const { data: opt = NO_OPT, error: oe, isLoading: optLoading } = useSWR(optUrl, getJson<OptRow[]>, SWR_OPTS);
  const { data: vrp = NO_VRP, error: ve, isLoading: vrpLoading } = useSWR(vrpUrl, getJson<VrpRow[]>, SWR_OPTS);
  const error = oe ?? ve;
  // VRP key 为 null 时 vrpLoading 恒为 false;有 VRP 时须等两个请求都完成才算加载好。
  const isLoading = optLoading || vrpLoading;
  // pane 用稳定 key 标识(换位后下标会变,折叠/标签必须按 key 而非下标)。
  // PANE_DEFS 的顺序 = series 创建时的 pane 下标;order 为当前显示顺序。
  const PANE_DEFS = vrpUnderlying
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
  const [order, setOrder] = useState<string[]>(() => PANE_DEFS.map((d) => d.key));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [vals, setVals] = useState<Record<string, number>>({}); // 竖线(crosshair)处各 series 值
  const [tops, setTops] = useState<number[]>([]); // 各显示 pane 顶部像素偏移,用于定位图例

  // 标的变化(pane 集合可能 2↔4)时把顺序/折叠归位,避免残留旧 tab 的 key
  // 导致 order.indexOf 得 -1、panes()[-1].moveTo 崩溃。其余 effect 也都按 props 变化响应。
  useEffect(() => {
    setOrder(PANE_DEFS.map((d) => d.key));
    setCollapsed(new Set());
  }, [underlying, vrpUnderlying]);

  const paneCount = vrpUnderlying ? 4 : 2;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    for (let i = 1; i < paneCount; i++) chart.addPane(); // pane 0 默认已存在
    chart.panes().forEach((p) => p.setStretchFactor(1)); // 等高,可拖分隔条调整
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
    // 依赖 underlying/vrpUnderlying:标的一变就重建 chart,物理 pane 回到规范顺序,
    // 与 order/collapsed 归位对齐(否则同 paneCount 切标的时物理 pane 顺序会残留)。
  }, [paneCount, underlying, vrpUnderlying]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const toLine = (rows: Array<Record<string, unknown>>, key: string): LinePoint[] =>
      rows.map((r) => ({ time: r.date as string, value: r[key] as number }));

    const specs = [
      { key: 'call', pane: 0, color: COLORS.call, title: SERIES_NAME.call, data: aggregate(toLine(opt, 'callIv'), interval) },
      { key: 'put',  pane: 0, color: COLORS.put,  title: SERIES_NAME.put,  data: aggregate(toLine(opt, 'putIv'),  interval) },
      { key: 'skew', pane: 1, color: COLORS.skew, title: SERIES_NAME.skew, data: aggregate(toLine(opt, 'skew'),   interval) },
      ...(vrpUnderlying ? [
        { key: 'iv',  pane: 2, color: COLORS.iv,  title: SERIES_NAME.iv,  data: aggregate(toLine(vrp, 'iv'),  interval) },
        { key: 'rv',  pane: 2, color: COLORS.rv,  title: SERIES_NAME.rv,  data: aggregate(toLine(vrp, 'rv'),  interval) },
        { key: 'vrp', pane: 3, color: COLORS.vrp, title: SERIES_NAME.vrp, data: aggregate(toLine(vrp, 'vrp'), interval) },
      ] : []),
    ];

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
  }, [opt, vrp, interval, underlying, vrpUnderlying, label]);

  // 折叠:收起的 pane 给极小 stretch(near-0),其余为 1,布局按权重重分配高度。
  // 按显示顺序 order[i] 对应 chart.panes()[i],换位后仍一致。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.panes().forEach((p, i) => p.setStretchFactor(collapsed.has(order[i]) ? 0.0001 : 1));
    // 同时隐藏收起 pane 的线,否则薄条里仍会画线。
    for (const d of PANE_DEFS) {
      const visible = !collapsed.has(d.key);
      d.series.forEach((sk) => seriesRef.current.get(sk)?.applyOptions({ visible }));
    }
  }, [collapsed, order, paneCount, opt, vrp]);

  // 竖线滑动:从 crosshair 读各 series 在该时间点的值;不悬停时 vals 清空,图例回落到末值。
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
  }, [paneCount, underlying, vrpUnderlying]);

  // 各 pane 顶部偏移(用于把图例定位到对应 pane);布局变化后用 rAF 读取已重排的高度。
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
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [order, collapsed, opt, vrp, paneCount, underlying, vrpUnderlying]);

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

  // 上下换位:移动整个 pane(连同其纵轴),不合并。chart 与 order 同步交换。
  const move = (key: string, dir: -1 | 1) => {
    const chart = chartRef.current;
    if (!chart) return;
    const i = order.indexOf(key);
    if (i < 0) return; // key 不在当前 order 里(理论上不会),别让 panes()[-1] 崩
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    chart.panes()[i].moveTo(j);
    setOrder((prev) => {
      const n = [...prev];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };

  const hovering = Object.keys(vals).length > 0; // 鼠标在图内、crosshair 有值

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* 工具条按固定顺序排列(便于查找);↑↓ 只改 chart 里 pane 的显示位置,不改本行顺序。 */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {PANE_DEFS.map(({ key, label: pl }) => {
          const pos = order.indexOf(key); // 该 pane 当前在图中的位置
          const isCollapsed = collapsed.has(key);
          // 唯一展开的那个不能再收(收了全员等权=没收起)。
          const lastExpanded = !isCollapsed && collapsed.size === paneCount - 1;
          const btn = 'px-1 text-neutral-300 disabled:cursor-not-allowed disabled:text-neutral-700';
          return (
            <div key={key} className="flex items-center gap-0.5 rounded border border-neutral-700 px-1 py-0.5 text-xs">
              <button onClick={() => move(key, -1)} disabled={pos === 0} title="上移" className={btn}>↑</button>
              <button onClick={() => move(key, 1)} disabled={pos === order.length - 1} title="下移" className={btn}>↓</button>
              <button onClick={() => toggle(key)} disabled={lastExpanded} title={lastExpanded ? '至少保留一个' : isCollapsed ? '展开' : '收起'} className={btn}>
                {isCollapsed ? '▸' : '▾'}
              </button>
              <span className={isCollapsed ? 'text-neutral-600' : 'text-neutral-300'}>{pl}</span>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {/* 每个 pane 顶部图例:指标名 + 竖线对应值。仅悬停时显示,不悬停不挡线
            (最新值看右轴原生 tag)。 */}
        {hovering && order.map((key, i) => {
          if (collapsed.has(key)) return null;
          const def = PANE_DEFS.find((d) => d.key === key);
          if (!def) return null;
          return (
            <div key={key} className="pointer-events-none absolute left-2 z-10 text-xs leading-tight" style={{ top: (tops[i] ?? 0) + 2 }}>
              {def.series.map((sk) => {
                const v = vals[sk];
                return (
                  <div key={sk} style={{ color: COLORS[sk as keyof typeof COLORS] }}>
                    {SERIES_NAME[sk]} {v == null ? '—' : v.toFixed(2)}
                  </div>
                );
              })}
            </div>
          );
        })}
        {isLoading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
        {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {label} {(error as Error).message}</p>}
      </div>
    </div>
  );
}
