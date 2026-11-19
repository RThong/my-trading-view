// 地址栏 hash ↔ 停在哪个 tab:#/<视角>/<tab>(内置,id 写在 pages/<视角>/index)、#/c/<视角>/<tab>(自建,id 见 pages/custom);
// 自建 tab 里正在全屏编辑某张图时再多一段:#/c/<视角>/<tab>/<图 id>。
// 用 hash 不用路径:服务端不用认这些地址,刷新 / 新标签页打开都还是同一个 index.html。
export type Route = { custom: boolean; persp: string; tab?: string /** 自建 tab 里正在编辑的图 */; edit?: string };

/** 地址 → 路由;空的、写坏的(% 转义不完整)都是 null(交给调用方回默认页) */
export function parseRoute(hash: string): Route | null {
  try {
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const custom = parts[0] === 'c';
    const [persp, tab, edit] = custom ? parts.slice(1) : parts;

    return persp ? { custom, persp, ...(tab && { tab }), ...(custom && tab && edit && { edit }) } : null;
  } catch {
    return null;
  }
}

/** 路由指的视角 / tab 还在不在。tabsOf:视角 → 它的 tab id 列表,没有这个视角给 undefined */
export function routeExists(r: Route, tabsOf: (custom: boolean, persp: string) => string[] | undefined): boolean {
  const tabs = tabsOf(r.custom, r.persp);

  return !!tabs && (!r.tab || tabs.includes(r.tab));
}

export function routeHash({ custom, persp, tab, edit }: Route): string {
  const parts = [...(custom ? ['c'] : []), persp, ...(tab ? [tab] : []), ...(custom && tab && edit ? [edit] : [])];

  return `#/${parts.map(encodeURIComponent).join('/')}`;
}
