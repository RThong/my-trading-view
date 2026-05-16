import { ChartView } from '../components/ChartView';
import type { SeriesConfig, Interval } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: '^VIX',   label: 'VIX',         color: '#f87171', axis: 'left' },
  { source: 'quotes', symbol: 'VX1',    label: 'VX1 (1M fut)', color: '#ef4444', axis: 'left' },
  { source: 'quotes', symbol: '^VIX9D', label: 'VIX9D',       color: '#fb923c', axis: 'left' },
  { source: 'quotes', symbol: '^VIX3M', label: 'VIX3M',       color: '#fbbf24', axis: 'left' },
  { source: 'quotes', symbol: '^VVIX',  label: 'VVIX',        color: '#a78bfa', axis: 'right' },
  { source: 'quotes', symbol: '^SKEW',  label: 'SKEW',        color: '#60a5fa', axis: 'right' },
];

export function VolatilityPanel({ interval }: { interval: Interval }) {
  return <ChartView configs={CONFIGS} interval={interval} />;
}
