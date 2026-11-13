// 编辑器快捷键(同 TradingView):⌘Z / Ctrl+Z 撤销,⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y 重做,
// ⌥⌘S / Ctrl+Alt+S 下载图片,⇧⌘S / Ctrl+Shift+S 复制图片。
// 编辑器访问过就一直挂着(App 的 keep-alive,切走只是藏起来),所以按键时先看编辑器在不在屏幕上:
// 不在就不管,别在别的页面悄悄撤掉编辑器里的图(还拦掉那个页面浏览器自己的撤销)。
import { type RefObject, useEffect, useRef } from 'react';

export type ShortcutAction = 'undo' | 'redo' | 'download' | 'copy';

/** 焦点在输入框里:交给浏览器自己的撤销(撤销刚打的字),不撤图 */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

// 按键帽上的字母(e.key)认,德文 QWERTZ / 法文 AZERTY 上 ⌘Z 照样是撤销;只有带 ⌥ 的按物理键(e.code)认:
// Mac 上按着 ⌥ 时 e.key 是 ß 之类的符号。y 只在 Ctrl 下算重做(Mac 的 ⌘Y 是别的意思)
const KEYS: { key?: string; code?: string; match: (e: KeyboardEvent) => boolean; action: ShortcutAction }[] = [
  { key: 'z', match: (e) => !e.altKey && !e.shiftKey, action: 'undo' },
  { key: 'z', match: (e) => !e.altKey && e.shiftKey, action: 'redo' },
  { key: 'y', match: (e) => e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey, action: 'redo' },
  { code: 'KeyS', match: (e) => e.altKey && !e.shiftKey, action: 'download' },
  { key: 's', match: (e) => e.shiftKey && !e.altKey, action: 'copy' },
];

/** container:编辑器里一直在的元素(图表容器),藏起来时它没有布局框 */
export function useEditorShortcuts(
  container: RefObject<HTMLElement | null>,
  handlers: Record<ShortcutAction, () => void>,
) {
  // 最新回调放 ref:监听只挂一次
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || typing(e.target)) return;
      if (!container.current?.getClientRects().length) return;
      const hit = KEYS.find((k) => (k.key ? k.key === e.key.toLowerCase() : k.code === e.code) && k.match(e));
      if (!hit) return;

      e.preventDefault();
      latest.current[hit.action]();
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [container]);
}
