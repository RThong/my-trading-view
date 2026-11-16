import { lazy } from 'react';
import { LazyBoundary } from '../../components/LazyBoundary';
import type { Perspective } from '../tabs';

// 数据健康页懒加载:点到这个竖 tab 才拉(一开就取全部序列,不该跟首屏一起走)。
const DataHealthPage = lazy(() => import('./DataHealthPage').then((m) => ({ default: m.DataHealthPage })));

// 每条序列的新鲜度体检。单视图,无横 tab。
export const HEALTH: Perspective = {
  id: 'health',
  label: '数据健康',
  tabs: [
    {
      id: 'health',
      label: '数据健康',
      render: () => (
        <LazyBoundary fallback={<p className="text-sm text-neutral-500">加载中…</p>}>
          <DataHealthPage />
        </LazyBoundary>
      ),
    },
  ],
};
