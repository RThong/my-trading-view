import { regimeTab, type Perspective } from '../tabs';
import { AttackDefensePanel } from './AttackDefensePanel';

export const FEATURED: Perspective = {
  id: 'featured',
  label: '特色指标',
  tabs: [
    { id: 'attack_defense', label: '攻防', render: () => <AttackDefensePanel /> },
    regimeTab('concentration', '集中度', 'concentration'),
  ],
};
