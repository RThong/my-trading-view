import { regimeTab, type Perspective } from '../tabs';

export const SENTIMENT: Perspective = {
  id: 'sentiment',
  label: '情绪',
  tabs: [regimeTab('vol', '波动率', 'vol'), regimeTab('sentiment', '情绪', 'sentiment')],
};
