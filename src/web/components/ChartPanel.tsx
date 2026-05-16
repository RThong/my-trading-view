import { useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useChartData, type SeriesConfig } from '../hooks/useChartData';

type Props = {
  title: string;
  configs: SeriesConfig[];
  days: number;
};

const CHART_OPTIONS = {
  layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
  grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
  rightPriceScale: { borderColor: '#262626' },
  timeScale: { borderColor: '#262626', timeVisible: false },
  autoSize: true,
};

export function ChartPanel({ title, configs, days }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const { series, loading, error } = useChartData(configs, days);

  useEffect(() => {
    if (!containerRef.current) return;
    chartRef.current = createChart(containerRef.current, CHART_OPTIONS);
    return () => {
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const [label, s] of seriesRef.current) {
      if (!series.find(x => x.label === label)) {
        chart.removeSeries(s);
        seriesRef.current.delete(label);
      }
    }
    for (const s of series) {
      let line = seriesRef.current.get(s.label);
      if (!line) {
        line = chart.addSeries(LineSeries, { color: s.color, title: s.label, lineWidth: 2 });
        seriesRef.current.set(s.label, line);
      }
      line.setData(s.data);
    }
    chart.timeScale().fitContent();
  }, [series]);

  return (
    <section className="flex h-80 flex-col rounded border border-neutral-800 p-3">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-wider text-neutral-400">{title}</h2>
        <div className="flex gap-2 text-xs">
          {configs.map(c => {
            const label = c.label;
            const color = c.color;
            return <span key={label} style={{ color }}>● {label}</span>;
          })}
        </div>
      </header>
      <div ref={containerRef} className="flex-1" />
      {loading && <p className="text-xs text-neutral-500">Loading…</p>}
      {error && <p className="text-xs text-red-400">Error: {error}</p>}
    </section>
  );
}
