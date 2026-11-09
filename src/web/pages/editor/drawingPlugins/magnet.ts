// 磁吸插件:锚点吸到光标所在那一根的值上(计算见 chart/magnet)
import { Magnet } from 'lucide-react';
import { snapTime, snapToBar } from '../../../chart/magnet';
import type { PointPlugin } from './types';

export const magnet: PointPlugin = {
  id: 'magnet',
  name: '磁吸',
  icon: Magnet,
  modes: [
    { id: 'weak', name: '弱磁吸', hint: '光标靠近时才吸到这一天的值(线 = 收盘,蜡烛 = 开高低收)' },
    { id: 'strong', name: '强磁吸', hint: '总是吸到这一天离光标最近的值' },
  ],
  apply: (p, c, mode) => (c.onlyTime ? snapTime(p, c.bar) : snapToBar(p, c.y, c.bar, c.toY, mode === 'strong')),
};
