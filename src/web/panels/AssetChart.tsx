import { useEffect, useRef, useState } from 'react';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const [opt, setOpt] = useState<OptRow[]>([]);
  const [vrp, setVrp] = useState<VrpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  // 每个 pane 一个折叠开关;下标即 pane 序号。
  const paneLabels = vrpUnderlying ? ['IV', 'Skew', '隐含/RV', 'VRP'] : ['IV', 'Skew'];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const optP = fetch(`/api/options/25delta/${encodeURIComponent(underlying)}?days=${HISTORY_DAYS}`)
      .then((r) => { if (!r.ok) throw new Error(`${label} 期权数据 ${r.status}`); return r.json() as Promise<OptRow[]>; });
    const vrpP = vrpUnderlying
      ? fetch(`/api/vrp/${encodeURIComponent(vrpUnderlying)}`)
          .then((r) => { if (!r.ok) throw new Error(`${label} VRP ${r.status}`); return r.json() as Promise<VrpRow[]>; })
      : Promise.resolve<VrpRow[]>([]);
    Promise.all([optP, vrpP])
      .then(([o, v]) => { if (!cancelled) { setOpt(o); setVrp(v); } })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [underlying, vrpUnderlying, label]);

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
  }, [paneCount]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const toLine = (rows: Array<Record<string, unknown>>, key: string): LinePoint[] =>
      rows.map((r) => ({ time: r.date as string, value: r[key] as number }));

    const ivLabel = vrpUnderlying === 'BTC' ? 'DVOL' : 'VIX';
    const specs = [
      { key: 'call', pane: 0, color: COLORS.call, title: `${label} 25Δ Call IV`, data: aggregate(toLine(opt, 'callIv'), interval) },
      { key: 'put',  pane: 0, color: COLORS.put,  title: `${label} 25Δ Put IV`,  data: aggregate(toLine(opt, 'putIv'),  interval) },
      { key: 'skew', pane: 1, color: COLORS.skew, title: `${label} 25Δ Skew`,    data: aggregate(toLine(opt, 'skew'),   interval) },
      ...(vrpUnderlying ? [
        { key: 'iv',  pane: 2, color: COLORS.iv,  title: `隐含 (${ivLabel})`, data: aggregate(toLine(vrp, 'iv'),  interval) },
        { key: 'rv',  pane: 2, color: COLORS.rv,  title: `已实现 RV`,         data: aggregate(toLine(vrp, 'rv'),  interval) },
        { key: 'vrp', pane: 3, color: COLORS.vrp, title: `VRP (IV−RV)`,       data: aggregate(toLine(vrp, 'vrp'), interval) },
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
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.panes().forEach((p, i) => p.setStretchFactor(collapsed.has(i) ? 0.0001 : 1));
  }, [collapsed, paneCount]);

  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(i)) {
        n.delete(i);
      } else if (n.size + 1 >= paneCount) {
        return prev; // 至少留一个展开:全收起时权重都=0.0001 会被均分,等于没收起
      } else {
        n.add(i);
      }
      return n;
    });

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="mb-2 flex gap-1.5">
        {paneLabels.map((pl, i) => {
          const isCollapsed = collapsed.has(i);
          // 唯一展开的那个不能再收(收了全员等权=没收起),按钮置灰禁用。
          const lastExpanded = !isCollapsed && collapsed.size === paneCount - 1;
          return (
            <button
              key={i}
              onClick={() => toggle(i)}
              disabled={lastExpanded}
              title={lastExpanded ? '至少保留一个' : isCollapsed ? '展开' : '收起'}
              className={`rounded border px-2 py-0.5 text-xs ${
                lastExpanded
                  ? 'cursor-not-allowed border-neutral-800 text-neutral-700'
                  : isCollapsed
                    ? 'border-neutral-700 text-neutral-600'
                    : 'border-neutral-600 text-neutral-300'
              }`}
            >
              {isCollapsed ? '▸' : '▾'} {pl}
            </button>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {loading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
        {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {error}</p>}
      </div>
    </div>
  );
}
