import { regimeTab, type Perspective } from '../tabs';

export const FEATURED: Perspective = {
  id: 'featured',
  label: '特色指标',
  tabs: [regimeTab('attack_defense', '攻防', 'attackDefense'), regimeTab('concentration', '集中度', 'concentration')],
};
