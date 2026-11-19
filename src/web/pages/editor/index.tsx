import { lazy } from 'react';
import { LazyBoundary } from '../../components/LazyBoundary';
import type { Interval } from '../../hooks/interval';
import type { Perspective } from '../tabs';
import type { DocStore } from './hooks/useChartDoc';

// 图表编辑器懒加载:不进首屏包,用到才拉。
const ChartEditorPage = lazy(() => import('./ChartEditorPage').then((m) => ({ default: m.ChartEditorPage })));

/** 懒加载的编辑器;store 见 useChartDoc(自建 tab 编辑自己的图时传) */
export function ChartEditor({ interval, store }: { interval: Interval; store?: DocStore }) {
  return (
    <LazyBoundary fallback={<p className="text-sm text-neutral-500">加载中…</p>}>
      <ChartEditorPage interval={interval} store={store} />
    </LazyBoundary>
  );
}

// 自由组图:空白图上挑现有序列、分格叠放。单视图,无横 tab。
export const EDITOR: Perspective = {
  id: 'editor',
  label: '图表编辑',
  tabs: [{ id: 'editor', label: '图表编辑', render: (interval) => <ChartEditor interval={interval} /> }],
};
