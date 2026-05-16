import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: '^VIX',   label: 'VIX',   color: '#f87171' },
  { source: 'quotes', symbol: '^VIX9D', label: 'VIX9D', color: '#fb923c' },
  { source: 'quotes', symbol: '^VIX3M', label: 'VIX3M', color: '#fbbf24' },
  { source: 'quotes', symbol: '^VVIX',  label: 'VVIX',  color: '#a78bfa' },
  { source: 'quotes', symbol: '^SKEW',  label: 'SKEW',  color: '#60a5fa' },
];

export function VolatilityPanel({ days }: { days: number }) {
  return <ChartPanel title="Volatility" configs={CONFIGS} days={days} />;
}
