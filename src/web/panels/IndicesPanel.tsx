import { ChartView } from '../components/ChartView';
import type { SeriesConfig, Interval } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: '^GSPC', label: 'S&P 500', color: '#e5e5e5', pane: 0 },
  { source: 'quotes', symbol: 'QQQ',   label: 'QQQ',     color: '#a78bfa', pane: 1 },
  { source: 'quotes', symbol: 'IWM',   label: 'IWM',     color: '#f472b6', pane: 2 },
];

export function IndicesPanel({ interval }: { interval: Interval }) {
  return <ChartView configs={CONFIGS} interval={interval} />;
}
