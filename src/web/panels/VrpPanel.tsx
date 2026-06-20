import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Interval } from '../hooks/interval';
import { CHART_OPTIONS, aggregate, type LinePoint } from '../lib/chart';

// 后端 /api/vrp/:underlying 返回 { date, iv, rv, vrp }(均为百分点)。
type VrpPoint = { date: string; iv: number; rv: number; vrp: number };
type MetricKey = 'iv' | 'rv' | 'vrp';

const COLORS = {
  iv:  '#3b82f6', // 隐含(VIX / DVOL)
  rv:  '#f59e0b', // 已实现
  vrp: '#22c55e', // 价差
};

function toLinePoints(raw: VrpPoint[], metric: MetricKey): LinePoint[] {
  return raw.map((r) => ({ time: r.date, value: r[metric] }));
}

export function VrpPanel({ interval, underlying }: { interval: Interval; underlying: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const [rows, setRows] = useState<VrpPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/vrp/${encodeURIComponent(underlying)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`加载 ${underlying} VRP 失败 (${r.status})`);
        return r.json() as Promise<VrpPoint[]>;
      })
      .then((s) => { if (!cancelled) setRows(s); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [underlying]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    chart.addPane(); // pane 1 用于展示 VRP
    chart.panes().forEach((p) => p.setStretchFactor(1));
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const ivLabel = underlying === 'SPY' ? 'VIX' : underlying === 'BTC' ? 'DVOL' : 'IV';
    const specs = [
      // Pane 0:隐含波动(VIX/DVOL)vs 已实现波动(RV)
      { key: 'iv',  pane: 0, color: COLORS.iv,  title: `${underlying} 隐含 (${ivLabel})`, data: aggregate(toLinePoints(rows, 'iv'),  interval) },
      { key: 'rv',  pane: 0, color: COLORS.rv,  title: `${underlying} 已实现 RV`,         data: aggregate(toLinePoints(rows, 'rv'),  interval) },
      // Pane 1:VRP = 隐含 − 已实现(>0 期权偏贵,<0 偏便宜)
      { key: 'vrp', pane: 1, color: COLORS.vrp, title: `${underlying} VRP (IV−RV)`,       data: aggregate(toLinePoints(rows, 'vrp'), interval) },
    ];

    const keysNow = new Set(specs.map((s) => s.key));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) {
        chart.removeSeries(s);
        seriesRef.current.delete(k);
      }
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
  }, [rows, interval, underlying]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
      {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {error}</p>}
    </div>
  );
}
