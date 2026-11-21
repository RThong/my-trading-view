import type { Perspective } from '../tabs';
import { StampedePage } from './StampedePage';

// 期权结构 / 踩踏监控:单视图,无横 tab
export const STAMPEDE: Perspective = {
  id: 'stampede',
  label: '踩踏监控',
  tabs: [{ id: 'stampede', label: '踩踏监控', render: (interval) => <StampedePage interval={interval} /> }],
};
