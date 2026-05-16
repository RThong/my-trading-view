import { ChartView } from '../components/ChartView';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'macro', seriesId: 'DGS10',    label: 'UST 10Y',   color: '#34d399', axis: 'left' },
  { source: 'macro', seriesId: 'DGS2',     label: 'UST 2Y',    color: '#22d3ee', axis: 'left' },
  { source: 'macro', seriesId: 'DGS3MO',   label: 'UST 3M',    color: '#a3e635', axis: 'left' },
  { source: 'macro', seriesId: 'DTWEXBGS', label: 'USD Index', color: '#f59e0b', axis: 'right' },
];

export function MacroPanel({ days }: { days: number }) {
  return <ChartView configs={CONFIGS} days={days} />;
}
