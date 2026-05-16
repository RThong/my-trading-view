import { useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useChartData, type SeriesConfig } from '../hooks/useChartData';

type Props = {
  configs: SeriesConfig[];
  days: number;
  /** Number of panes to create. Defaults to max(config.pane) + 1. */
  paneCount?: number;
};

const CHART_OPTIONS = {
  layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
  grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
  rightPriceScale: { borderColor: '#262626', visible: true },
  leftPriceScale: { borderColor: '#262626', visible: true },
  timeScale: { borderColor: '#262626', timeVisible: false },
  autoSize: true,
};

export function ChartView({ configs, days, paneCount }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const { series, loading, error } = useChartData(configs, days);

  const paneIndexFor = (label: string) => {
    const cfg = configs.find(c => c.label === label);
    return cfg?.pane ?? 0;
  };
  const axisFor = (label: string): 'left' | 'right' => {
    const cfg = configs.find(c => c.label === label);
    return cfg?.axis ?? 'right';
  };

  // create chart + extra panes once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;

    const wantedPanes = paneCount ?? (Math.max(0, ...configs.map(c => c.pane ?? 0)) + 1);
    for (let i = 1; i < wantedPanes; i++) {
      chart.addPane();
    }
    // equal stretch
    chart.panes().forEach((p) => p.setStretchFactor(1));

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // remove dropped series
    for (const [label, s] of seriesRef.current) {
      if (!series.find(x => x.label === label)) {
        chart.removeSeries(s);
        seriesRef.current.delete(label);
      }
    }
    // add/update remaining
    for (const s of series) {
      let line = seriesRef.current.get(s.label);
      if (!line) {
        line = chart.addSeries(
          LineSeries,
          {
            color: s.color,
            title: s.label,
            lineWidth: 2,
            priceScaleId: axisFor(s.label),
          },
          paneIndexFor(s.label),
        );
        seriesRef.current.set(s.label, line);
      }
      line.setData(s.data);
    }
    chart.timeScale().fitContent();
  }, [series]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
      {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {error}</p>}
    </div>
  );
}
