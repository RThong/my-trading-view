import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Interval } from '../hooks/interval';

type RawPoint = { date: string; callIv: number; putIv: number; skew: number };
type LinePoint = { time: string; value: number };
type MetricKey = 'callIv' | 'putIv' | 'skew';

const COLORS = {
  call: '#22c55e',
  put:  '#ec4899',
  skew: '#3b82f6',
};

const CHART_OPTIONS = {
  layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
  grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
  rightPriceScale: { borderColor: '#262626' },
  timeScale: { borderColor: '#262626', timeVisible: false },
  autoSize: true,
};

const HISTORY_DAYS = 3650;

function periodKey(dateStr: string, interval: Interval): string {
  if (interval === '1D') return dateStr;

  const d = new Date(dateStr + 'T00:00:00Z');
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  if (interval === '1Y') return `${year}-01-01`;
  if (interval === '1Q') {
    const qStartMonth = Math.floor(month / 3) * 3;
    return `${year}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
  }
  if (interval === '1M') return `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(Date.UTC(year, month, day + diff));
  return monday.toISOString().slice(0, 10);
}

function aggregate(points: LinePoint[], interval: Interval): LinePoint[] {
  if (interval === '1D') return points;
  // 同一周期内多个点取最后一个(Map 重复 key 保留后写入的),再按时间升序。
  const byKey = new Map(
    points.map((p) => {
      const key = periodKey(p.time, interval);
      return [key, { time: key, value: p.value }] as const;
    }),
  );
  return Array.from(byKey.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function toLinePoints(raw: RawPoint[], metric: MetricKey): LinePoint[] {
  return raw.map(r => ({ time: r.date, value: r[metric] }));
}

export function OptionsPanel({ interval, underlying }: { interval: Interval; underlying: string }) {
  const label = underlying.replace(/^\./, ''); // ".VIX" → "VIX"
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const [rows, setRows] = useState<RawPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/options/25delta/${encodeURIComponent(underlying)}?days=${HISTORY_DAYS}`)
      // 非 2xx(如未知 underlying 返回 400 {error})要抛错走 catch,
      // 否则会把错误对象塞进 rows,后续 toLinePoints 的 .map 直接崩。
      .then(async r => {
        if (!r.ok) throw new Error(`加载 ${label} 期权数据失败 (${r.status})`);
        return r.json() as Promise<RawPoint[]>;
      })
      .then(s => { if (!cancelled) setRows(s); })
      .catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [underlying]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    chart.addPane(); // pane 1 用于展示 skew
    chart.panes().forEach(p => p.setStretchFactor(1));

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const specs = [
      // Pane 0:call + put IV 放一起
      { key: 'call', pane: 0, color: COLORS.call, title: `${label} 25Δ Call IV`, data: aggregate(toLinePoints(rows, 'callIv'), interval) },
      { key: 'put',  pane: 0, color: COLORS.put,  title: `${label} 25Δ Put IV`,  data: aggregate(toLinePoints(rows, 'putIv'),  interval) },
      // Pane 1:25Δ skew(put IV − call IV)单独一格
      { key: 'skew', pane: 1, color: COLORS.skew, title: `${label} 25Δ Skew`,    data: aggregate(toLinePoints(rows, 'skew'),   interval) },
    ];

    const keysNow = new Set(specs.map(s => s.key));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) {
        chart.removeSeries(s);
        seriesRef.current.delete(k);
      }
    }

    for (const spec of specs) {
      let line = seriesRef.current.get(spec.key);
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color: spec.color,
          title: spec.title,
          lineWidth: 2,
        }, spec.pane);
        seriesRef.current.set(spec.key, line);
      }
      line.setData(spec.data);
    }

    chart.timeScale().fitContent();
  }, [rows, interval, label]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
      {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {error}</p>}
    </div>
  );
}
