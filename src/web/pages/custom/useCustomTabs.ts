// 自建 tab 的数据(存 localStorage)+ 导航状态(当前视角、每个视角停在哪个横 tab、keep-alive)。
// 和内置 tab 的 usePerspectiveNavigation 各管各的:perspId 为 null = 当前在内置视角上。
import { useEffect, useState } from 'react';
import { type CustomStore, type CustomTab, EMPTY_STORE, editPersp, editTab, parseStore } from './customTabs';

const STORAGE_KEY = 'mtv:customTabs';

function loadStore(): CustomStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    return raw ? parseStore(JSON.parse(raw)) : EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}

function newTab(label: string): CustomTab {
  return { id: crypto.randomUUID(), label, blocks: [] };
}

export function useCustomTabs() {
  const [store, setStore] = useState(loadStore);
  const [perspId, setPerspId] = useState<string | null>(null);
  // 每个视角记住上次停的横 tab,切回来不跳回第一个
  const [tabByPersp, setTabByPersp] = useState<Record<string, string>>({});
  // keep-alive:看过的横 tab 一直挂着(切回来图的缩放等都还在)
  const [seen, setSeen] = useState<Set<string>>(() => new Set());

  const persp = store.perspectives.find((p) => p.id === perspId) ?? null;
  // 记住的那个被删了就退到第一个
  const activeTab = persp && (persp.tabs.find((t) => t.id === tabByPersp[persp.id]) ?? persp.tabs[0])?.id;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* 隐私模式 / 配额满时存不上:本次照常用,刷新就没 */
    }
  }, [store]);

  useEffect(() => {
    if (activeTab) setSeen((s) => (s.has(activeTab) ? s : new Set(s).add(activeTab)));
  }, [activeTab]);

  return {
    store,
    persp,
    activeTab,
    /** 这个横 tab 要不要挂着(看过的,或当前这个) */
    mounted: (tabId: string) => seen.has(tabId) || tabId === activeTab,
    selectPersp: setPerspId,
    selectTab: (tabId: string) => persp && setTabByPersp((m) => ({ ...m, [persp.id]: tabId })),
    /** 回到内置视角 */
    leave: () => setPerspId(null),

    /** 新建视角(带一个横 tab)并切过去,返回它的 id(调用方接着进改名) */
    addPersp: () => {
      const id = crypto.randomUUID();

      setStore((s) => ({ ...s, perspectives: [...s.perspectives, { id, label: '新视角', tabs: [newTab('新标签')] }] }));
      setPerspId(id);

      return id;
    },
    renamePersp: (id: string, label: string) => setStore((s) => editPersp(s, id, (p) => ({ ...p, label }))),
    removePersp: (id: string) => {
      setStore((s) => ({ ...s, perspectives: s.perspectives.filter((p) => p.id !== id) }));
      if (id === perspId) setPerspId(null);
    },

    /** 在当前视角下新建横 tab 并切过去,返回它的 id */
    addTab: () => {
      if (!persp) return '';

      const tab = newTab('新标签');

      setStore((s) => editPersp(s, persp.id, (p) => ({ ...p, tabs: [...p.tabs, tab] })));
      setTabByPersp((m) => ({ ...m, [persp.id]: tab.id }));

      return tab.id;
    },
    renameTab: (tabId: string, label: string) =>
      persp && setStore((s) => editTab(s, persp.id, tabId, (t) => ({ ...t, label }))),
    removeTab: (tabId: string) =>
      persp && setStore((s) => editPersp(s, persp.id, (p) => ({ ...p, tabs: p.tabs.filter((t) => t.id !== tabId) }))),

    /** 改某个横 tab 的内容(tab 页自己用) */
    editTab: (perspId: string, tabId: string, fn: (t: CustomTab) => CustomTab) =>
      setStore((s) => editTab(s, perspId, tabId, fn)),
  };
}
