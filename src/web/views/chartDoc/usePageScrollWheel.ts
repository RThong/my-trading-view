// 一列图的页面(自建 tab)里:滚轮 / 两指上下滑滚页面,不缩放图;⌘ + 滚轮、触摸板捏合(浏览器发的是带 ctrlKey 的 wheel)
// 照旧交给图表缩放,两指左右滑照旧平移。同网页里嵌的地图。
// 做法:在图表容器上捕获阶段截下「没按修饰键、以竖向为主」的 wheel,不让它传到 lw-charts 自己的元素上 ——
// 不 preventDefault,浏览器照常滚页面;别的 wheel 原样放行,缩放 / 平移仍是 lw 自己的手感。
import { type RefObject, useEffect, useRef, useState } from 'react';

// 一次会话只提示一次:列表里全是图,每划过一张都提示会很吵
let hinted = false;
const HINT_MS = 2500;

/** 返回要不要显示「⌘ + 滚轮缩放」的提示 */
export function usePageScrollWheel(containerRef: RefObject<HTMLDivElement | null>, enabled: boolean): boolean {
  const [hint, setHint] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      e.stopPropagation();
      if (hinted) return;

      hinted = true;
      setHint(true);
      timer.current = setTimeout(() => setHint(false), HINT_MS);
    };

    el.addEventListener('wheel', onWheel, { capture: true });

    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true });
      clearTimeout(timer.current);
    };
  }, [containerRef, enabled]);

  return hint;
}
