// 自建 tab 的数据(存 localStorage)+ 导航状态(当前视角、每个视角停在哪个横 tab、keep-alive)。
// 和内置 tab 的 usePerspectiveNavigation 各管各的:perspId 为 null = 当前在内置视角上。
import { useEffect, useState } from 'react';
import type { ChartDoc } from '../../views/chartDoc/chartDoc';
import {
  type CustomStore,
  type CustomTab,
  EMPTY_STORE,
  editPersp,
  editTab,
  parseStore,
  putChart,
  shortId,
} from './customTabs';

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
  return { id: shortId(), label, blocks: [] };
}

/** initial = 打开页面时地址栏里的自建视角(见 useHashRoute);存档里没有就停在内置视角 */
export function useCustomTabs(initial?: { persp: string; tab?: string; edit?: string }) {
  const [store, setStore] = useState(loadStore);
  const [perspId, setPerspId] = useState<string | null>(() =>
    initial && store.perspectives.some((p) => p.id === initial.persp) ? initial.persp : null,
  );
  // 每个视角记住上次停的横 tab,切回来不跳回第一个(记的那个不在了,activeTab 会退到第一个)
  const [tabByPersp, setTabByPersp] = useState<Record<string, string>>(() =>
    initial?.tab ? { [initial.persp]: initial.tab } : {},
  );
  // keep-alive:看过的横 tab 一直挂着(切回来图的缩放等都还在)
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  // 当前横 tab 里正在全屏编辑的图(id 可以是还没存进 tab 的新图)。链接里的视角 / tab 不在了就不进编辑:
  // tab 会退到第一个,不能把这张图编进别的 tab
  const [editing, setEditing] = useState<string | null>(() => {
    const p = store.perspectives.find((x) => x.id === initial?.persp);

    return p?.tabs.some((t) => t.id === initial?.tab) ? (initial?.edit ?? null) : null;
  });
  // 刚编辑完的那张(回到列表时滚过去);每次退出都是新对象,同一张连着编两次也会再滚
  const [lastEdited, setLastEdited] = useState<{ id: string } | null>(null);

  const persp = store.perspectives.find((p) => p.id === perspId) ?? null;
  // 记住的那个被删了就退到第一个
  const tab = persp && (persp.tabs.find((t) => t.id === tabByPersp[persp.id]) ?? persp.tabs[0]);
  const activeTab = tab?.id;
  // 正在全屏编辑的:哪个视角、哪个横 tab、哪张图(saved = tab 里现有的;新建的还没有)
  const editTarget =
    persp && tab && editing
      ? { persp, tab, blockId: editing, saved: tab.blocks.find((b) => b.id === editing)?.doc }
      : null;

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
    selectPersp: (id: string) => {
      setPerspId(id);
      setEditing(null);
    },
    /** 按 id 跳过去(地址栏改了时);视角不在存档里就不动 */
    open: (id: string, tabId?: string, edit?: string) => {
      if (!store.perspectives.some((p) => p.id === id)) return;

      setPerspId(id);
      if (tabId) setTabByPersp((m) => ({ ...m, [id]: tabId }));
      setEditing(edit ?? null);
    },
    selectTab: (tabId: string) => persp && setTabByPersp((m) => ({ ...m, [persp.id]: tabId })),
    /** 回到内置视角 */
    leave: () => {
      setPerspId(null);
      setEditing(null);
    },

    editTarget,
    lastEdited,
    startEdit: setEditing,
    /** 编辑页点完成 / 选保存:写回 tab(空图删掉,见 putChart) */
    commitEdit: (doc: ChartDoc) =>
      editTarget &&
      setStore((s) =>
        editTab(s, editTarget.persp.id, editTarget.tab.id, (t) => ({
          ...t,
          blocks: putChart(t.blocks, editTarget.blockId, doc),
        })),
      ),
    endEdit: () => {
      if (editing) setLastEdited({ id: editing });
      setEditing(null);
    },

    /** 新建视角(带一个横 tab)并切过去,返回它的 id(调用方接着进改名) */
    addPersp: () => {
      const id = shortId();

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
