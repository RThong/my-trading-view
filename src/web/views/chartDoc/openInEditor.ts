// 「在编辑器中打开」:把一张固定面板的 ChartDoc 交给图表编辑器(改的是副本,原 tab 不受影响)。
// 两条路都走:先写进编辑器的存档(编辑器还没挂载时,挂载时读到它),再广播事件(已挂载的编辑器直接换图、外壳跳到编辑页)。
import { useEffect, useRef } from 'react';
import { type ChartDoc, parseChartDoc } from './chartDoc';

/** 编辑器自动保存当前图的 localStorage 键(编辑器与这里共用一处,见 pages/editor/hooks/useChartDoc) */
export const EDITOR_STORAGE_KEY = 'mtv:chartEditor:doc';
const EVENT = 'mtv:open-in-editor';

// 最近一次交过去的那份:存档写不进(隐私模式 / 配额满)时,还没挂载的编辑器靠它拿到图。只活在本页内存里。
// 不在读取时清掉:编辑器的初始图在 useState 初始化函数里读,开发模式(StrictMode)会调两次;
// 编辑器挂载后一直不卸载(keep-alive),之后只会被下一次交过去的覆盖,刷新页面即没
let pending: ChartDoc | null = null;

/** 最近一次交给编辑器的图;没交过就是 null,照常读存档 */
export function pendingDoc(): ChartDoc | null {
  return pending;
}

function savedPaneCount(): number {
  try {
    const raw = localStorage.getItem(EDITOR_STORAGE_KEY);
    return (raw && parseChartDoc(JSON.parse(raw))?.panes.length) || 0;
  } catch {
    return 0;
  }
}

/**
 * 交给编辑器。编辑器里已有一张图时先问一句:那张图只在编辑器的自动保存里,被替换就没了。
 * 返回是否真的打开了(用户取消 = false)
 */
export function openInEditor(doc: ChartDoc): boolean {
  if (savedPaneCount() > 0 && !window.confirm('编辑器里现有的图会被替换,继续?')) return false;

  pending = doc;
  try {
    localStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(doc));
  } catch {
    /* 隐私模式 / 配额满时存不上:已挂载的编辑器从事件拿,还没挂载的从 pending 拿 */
  }
  window.dispatchEvent(new CustomEvent<ChartDoc>(EVENT, { detail: doc }));
  return true;
}

/** 订阅「在编辑器中打开」:编辑器用它换图,外壳用它跳页。回调用最新的一份,监听器只挂一次 */
export function useOpenInEditor(onOpen: (doc: ChartDoc) => void) {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });

  useEffect(() => {
    const handler = (e: Event) => latest.current((e as CustomEvent<ChartDoc>).detail);
    window.addEventListener(EVENT, handler);

    return () => window.removeEventListener(EVENT, handler);
  }, []);
}
