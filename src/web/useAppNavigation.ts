// 外壳的导航:内置视角(usePerspectiveNavigation)+ 自建视角(pages/custom 的 useCustomTabs)+ 地址栏同步(useHashRoute)。
// 打开 / 刷新时读一次地址定起点;当前位置写回地址;地址栏改了就跳;链接里的视角 / tab 不在了给一条提示。
import { useState } from 'react';
import { PERSPECTIVES } from './perspectives';
import { parseRoute, type Route, routeExists, routeHash } from './hooks/route';
import { useHashRoute } from './hooks/useHashRoute';
import { usePerspectiveNavigation } from './hooks/usePerspectiveNavigation';
import { useCustomTabs } from './pages/custom/useCustomTabs';

export function useAppNavigation() {
  const [initial] = useState(() => parseRoute(location.hash));
  const nav = usePerspectiveNavigation(PERSPECTIVES, initial?.custom ? undefined : (initial ?? undefined));
  const custom = useCustomTabs(initial?.custom ? initial : undefined);

  const here: Route = custom.persp
    ? { custom: true, persp: custom.persp.id, tab: custom.activeTab ?? undefined, edit: custom.editTarget?.blockId }
    : { custom: false, persp: nav.perspId, tab: nav.activeTab };
  const tabsOf = (isCustom: boolean, id: string) =>
    isCustom
      ? custom.store.perspectives.find((p) => p.id === id)?.tabs.map((t) => t.id)
      : PERSPECTIVES.find((p) => p.id === id)?.tabs.map((t) => t.id);
  // 链接里的视角 / tab 不在了(删了、换了浏览器没有自建 tab):打开时退回默认页、页内跳转时不动
  const [missing, setMissing] = useState(() => initial !== null && !routeExists(initial, tabsOf));

  const pickBuiltin = (id: string, tab?: string) => {
    custom.leave();
    nav.open(id, tab);
  };

  useHashRoute(routeHash(here), (r) => {
    if (!routeExists(r, tabsOf)) return setMissing(true);

    setMissing(false);
    if (r.custom) custom.open(r.persp, r.tab, r.edit);
    else pickBuiltin(r.persp, r.tab);
  });

  return { nav, custom, pickBuiltin, missing, dismissMissing: () => setMissing(false) };
}
