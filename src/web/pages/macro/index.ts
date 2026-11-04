import { regimeTab, type Perspective } from '../tabs';

export const MACRO: Perspective = {
  id: 'macro',
  label: '宏观',
  tabs: [regimeTab('macro', '美元', 'macro'), regimeTab('ism', 'ISM 景气', 'ism')],
};
