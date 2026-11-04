import { curveTab, historyTab, regimeTab, type Perspective } from '../tabs';

export const INFLATION: Perspective = {
  id: 'inflation',
  label: '通胀',
  tabs: [
    curveTab('bei', '通胀预期', 'bei'),
    historyTab('bei_history', '通胀走势', 'bei', [{ long: '10Y', short: '5Y', label: '10Y − 5Y' }]),
    regimeTab('infl_source', '通胀来源', 'inflSource'),
  ],
};
