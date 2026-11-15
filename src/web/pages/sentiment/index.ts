import { regimeTab, type Perspective } from '../tabs';

export const SENTIMENT: Perspective = {
  id: 'sentiment',
  label: '情绪',
  tabs: [
    regimeTab('vol', '波动率', 'vol'),
    regimeTab('sentiment', '情绪', 'sentiment'),
    // 做市商 gamma(Squeezemetrics GEX):期权仓位压住还是放大波动,「伽马挤压」发生在负值那一侧
    regimeTab('gamma', 'Gamma', 'gamma'),
  ],
};
