import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: 'GLD',     label: 'GLD', color: '#fbbf24' },
  { source: 'quotes', symbol: 'TLT',     label: 'TLT', color: '#60a5fa' },
  { source: 'quotes', symbol: 'BTC-USD', label: 'BTC', color: '#fb923c' },
];

export function AssetsPanel({ days }: { days: number }) {
  return <ChartPanel title="Other Assets" configs={CONFIGS} days={days} />;
}
