import { lazy, Suspense } from 'react';
import type { Perspective } from '../tabs';

// 图表编辑器懒加载:不进首屏包,点到这个竖 tab 才拉。
const ChartEditorPage = lazy(() => import('./ChartEditorPage').then((m) => ({ default: m.ChartEditorPage })));

// 自由组图:空白图上挑现有序列、分格叠放。单视图,无横 tab。
export const EDITOR: Perspective = {
  id: 'editor',
  label: '图表编辑',
  tabs: [
    {
      id: 'editor',
      label: '图表编辑',
      render: (interval) => (
        <Suspense fallback={<p className="text-sm text-neutral-500">加载中…</p>}>
          <ChartEditorPage interval={interval} />
        </Suspense>
      ),
    },
  ],
};
