import { useState } from 'react';
import type { Perspective } from '../perspectives';

type Spot = { persp: string; tab?: string };

/** 视角 / tab 按 id 找,找不到的退回第一个(链接里的视角被删了、tab 改了 id) */
function resolve(perspectives: Perspective[], at: Spot | undefined, remembered: Record<string, string> = {}) {
  const p = perspectives.find((x) => x.id === at?.persp) ?? perspectives[0];
  const want = at?.tab ?? remembered[p.id];
  const tab = p.tabs.find((t) => t.id === want)?.id ?? p.tabs[0].id;

  return { persp: p.id, tab };
}

// 视角/横 tab 导航状态:活动视角 + 每视角记住上次停的横 tab + keep-alive 的 seen 集合。
// 从 App 抽出,App 只负责组装外壳。initial = 打开页面时地址栏里的位置(见 useHashRoute)
export function usePerspectiveNavigation(perspectives: Perspective[], initial?: Spot) {
  const [start] = useState(() => resolve(perspectives, initial));
  const [perspId, setPerspId] = useState(start.persp);
  // 每个视角记住自己上次停在的横 tab,切回来不跳回第一个。
  const [tabByPersp, setTabByPersp] = useState<Record<string, string>>({ [start.persp]: start.tab });
  // keep-alive:访问过的 `${视角}:${tab}` 各挂一个实例不再卸载,切回来保留显隐/缩放等内存状态。
  const [seen, setSeen] = useState<Set<string>>(() => new Set([`${start.persp}:${start.tab}`]));

  const persp = perspectives.find((p) => p.id === perspId)!;
  const activeTab = tabByPersp[perspId] ?? persp.tabs[0].id;

  /** 跳到某个视角的某个 tab(tab 省略 = 这个视角上次停的) */
  const open = (id: string, tabId?: string) => {
    const to = resolve(perspectives, { persp: id, tab: tabId }, tabByPersp);
    const key = `${to.persp}:${to.tab}`;

    setPerspId(to.persp);
    setTabByPersp((m) => ({ ...m, [to.persp]: to.tab }));
    setSeen((s) => (s.has(key) ? s : new Set(s).add(key)));
  };

  return {
    perspId,
    persp,
    activeTab,
    seen,
    open,
    selectPersp: (id: string) => open(id),
    selectTab: (tab: string) => open(perspId, tab),
  };
}
