import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: '^GSPC', label: 'S&P 500', color: '#e5e5e5' },
  { source: 'quotes', symbol: 'QQQ',   label: 'QQQ',     color: '#a78bfa' },
  { source: 'quotes', symbol: 'IWM',   label: 'IWM',     color: '#f472b6' },
];

export function IndicesPanel({ days }: { days: number }) {
  return <ChartPanel title="Indices" configs={CONFIGS} days={days} />;
}
