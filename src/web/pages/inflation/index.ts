import { curveTab, regimeTab, type Perspective } from '../tabs';

export const INFLATION: Perspective = {
  id: 'inflation',
  label: '通胀',
  tabs: [
    curveTab('bei', '通胀预期', 'bei'),
    regimeTab('bei_history', '通胀走势', 'beiHistory'),
    regimeTab('infl_source', '通胀来源', 'inflSource'),
  ],
};
