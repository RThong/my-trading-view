import { useState } from 'react';
import type { Perspective } from '../perspectives';

// 视角/横 tab 导航状态:活动视角 + 每视角记住上次停的横 tab + keep-alive 的 seen 集合。
// 从 App 抽出,App 只负责组装外壳。
export function usePerspectiveNavigation(perspectives: Perspective[]) {
  const first = perspectives[0];
  const [perspId, setPerspId] = useState(first.id);
  // 每个视角记住自己上次停在的横 tab,切回来不跳回第一个。
  const [tabByPersp, setTabByPersp] = useState<Record<string, string>>(() => ({ [first.id]: first.tabs[0].id }));
  // keep-alive:访问过的 `${视角}:${tab}` 各挂一个实例不再卸载,切回来保留显隐/缩放等内存状态。
  const [seen, setSeen] = useState<Set<string>>(() => new Set([`${first.id}:${first.tabs[0].id}`]));

  const persp = perspectives.find((p) => p.id === perspId)!;
  const activeTab = tabByPersp[perspId] ?? persp.tabs[0].id;

  const selectPersp = (id: string) => {
    const p = perspectives.find((x) => x.id === id)!;
    const tab = tabByPersp[id] ?? p.tabs[0].id;
    setPerspId(id);
    setSeen((s) => (s.has(`${id}:${tab}`) ? s : new Set(s).add(`${id}:${tab}`)));
  };
  const selectTab = (tab: string) => {
    setTabByPersp((m) => ({ ...m, [perspId]: tab }));
    setSeen((s) => (s.has(`${perspId}:${tab}`) ? s : new Set(s).add(`${perspId}:${tab}`)));
  };

  return { perspId, persp, activeTab, seen, selectPersp, selectTab };
}
