import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Interval } from '../hooks/useChartData';

type RawPoint = { date: string; callIv: number; putIv: number; skew: number };
type LinePoint = { time: string; value: number };
type MetricKey = 'callIv' | 'putIv' | 'skew';

const COLORS = {
  spyCall: '#22c55e',
  spyPut:  '#ec4899',
  spySkew: '#be123c',
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
  const byKey = new Map<string, LinePoint>();
  for (const p of points) {
    byKey.set(periodKey(p.time, interval), { time: periodKey(p.time, interval), value: p.value });
  }
  return Array.from(byKey.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function toLinePoints(raw: RawPoint[], metric: MetricKey): LinePoint[] {
  return raw.map(r => ({ time: r.date, value: r[metric] }));
}

export function OptionsPanel({ interval }: { interval: Interval }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const [spy, setSpy] = useState<RawPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/options/25delta/SPY?days=${HISTORY_DAYS}`)
      .then(r => r.json() as Promise<RawPoint[]>)
      .then(s => { if (!cancelled) setSpy(s); })
      .catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

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
      // Pane 0:SPY 25Δ 的 call + put IV
      { key: 'spy-call', pane: 0, color: COLORS.spyCall, title: 'SPY 25Δ Call IV', data: aggregate(toLinePoints(spy, 'callIv'), interval) },
      { key: 'spy-put',  pane: 0, color: COLORS.spyPut,  title: 'SPY 25Δ Put IV',  data: aggregate(toLinePoints(spy, 'putIv'),  interval) },
      // Pane 1:SPY 25Δ skew(put IV − call IV)
      { key: 'spy-skew', pane: 1, color: COLORS.spySkew, title: 'SPY 25Δ Skew',    data: aggregate(toLinePoints(spy, 'skew'),   interval) },
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
  }, [spy, interval]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
      {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {error}</p>}
    </div>
  );
}
