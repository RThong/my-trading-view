import { ChartView } from '../components/ChartView';
import type { SeriesConfig, Interval } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: 'BTC-USD', label: 'BTC', color: '#fb923c', pane: 0 },
  { source: 'quotes', symbol: 'GLD',     label: 'GLD', color: '#fbbf24', pane: 1 },
  { source: 'quotes', symbol: 'TLT',     label: 'TLT', color: '#60a5fa', pane: 2 },
];

export function AssetsPanel({ interval }: { interval: Interval }) {
  return <ChartView configs={CONFIGS} interval={interval} />;
}
