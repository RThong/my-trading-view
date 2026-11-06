// 右侧操作区的收起 / 展开。收起状态记在 localStorage(读写不了就当展开,不影响使用)。
// 收起 / 展开改变图宽时可视区间不被截掉,靠建图时的 lockVisibleTimeRangeOnResize(见 useEditorChart),这里不管图。
import { useState } from 'react';

const STORAGE_KEY = 'mtv:chartEditor:sidebar';

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function saveOpen(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {}
}

/** forceOpen:空图时侧栏是选序列的唯一入口,直接改回展开(只在显示上展开的话,勾上第一条序列侧栏就缩回去了) */
export function useSidebar(forceOpen: boolean) {
  const [open, setOpen] = useState(readOpen);
  // 渲染中按条件调整 state,不用 effect;写 localStorage 是幂等的
  if (forceOpen && !open) {
    setOpen(true);
    saveOpen(true);
  }

  function toggle() {
    setOpen(!open);
    saveOpen(!open);
  }

  return { open, toggle };
}
