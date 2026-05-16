import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'macro', seriesId: 'DGS10',    label: 'UST 10Y',   color: '#34d399' },
  { source: 'macro', seriesId: 'DGS2',     label: 'UST 2Y',    color: '#22d3ee' },
  { source: 'macro', seriesId: 'DGS3MO',   label: 'UST 3M',    color: '#a3e635' },
  { source: 'macro', seriesId: 'DTWEXBGS', label: 'USD Index', color: '#f59e0b' },
];

export function MacroPanel({ days }: { days: number }) {
  return <ChartPanel title="Macro / Rates" configs={CONFIGS} days={days} />;
}
