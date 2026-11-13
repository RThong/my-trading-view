// 编辑器的撤销 / 重做快捷键(同 TradingView):⌘Z / Ctrl+Z 撤销,⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y 重做。
// 编辑器访问过就一直挂着(App 的 keep-alive,切走只是藏起来),所以按键时先看编辑器在不在屏幕上:
// 不在就不管,别在别的页面悄悄撤掉编辑器里的图(还拦掉那个页面浏览器自己的撤销)。
import { type RefObject, useEffect, useRef } from 'react';

/** 焦点在输入框里:交给浏览器自己的撤销(撤销刚打的字),不撤图 */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

// 按键 → 动作:z 看 Shift 分撤销 / 重做,y 只在 Ctrl 下算重做(Mac 的 ⌘Y 是别的意思)
const KEYS: Record<string, (e: KeyboardEvent) => 'undo' | 'redo' | null> = {
  z: (e) => (e.shiftKey ? 'redo' : 'undo'),
  y: (e) => (e.ctrlKey && !e.metaKey ? 'redo' : null),
};

/** container:编辑器里一直在的元素(图表容器),藏起来时它没有布局框 */
export function useUndoShortcuts(container: RefObject<HTMLElement | null>, undo: () => void, redo: () => void) {
  // 最新回调放 ref:监听只挂一次
  const latest = useRef({ undo, redo });
  useEffect(() => {
    latest.current = { undo, redo };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || typing(e.target)) return;
      if (!container.current?.getClientRects().length) return;
      const action = KEYS[e.key.toLowerCase()]?.(e);
      if (!action) return;

      e.preventDefault();
      latest.current[action]();
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [container]);
}
