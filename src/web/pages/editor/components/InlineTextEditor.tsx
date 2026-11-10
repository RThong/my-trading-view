// 画线工具「文字」的就地编辑框(同 TradingView:点一下就在图上打字,不弹窗)。
// 盖在锚点处的多行输入框,字体 / 行高 / 内边距与画布上画的文字同一套,看上去就是在图上打字;
// 宽高随内容(CSS field-sizing)。回车换行;Esc、点到框外、滚轮缩放图表都算写完,统一走失焦保存。
// 用原生 textarea、不用 ui/Textarea:要和画布上的字逐像素对齐,组件库的边框 / 内边距 / 圆角都得去掉
import { useEffect, useRef } from 'react';
import { TEXT_FONT, TEXT_LINE, TEXT_PAD } from '../../../chart/drawings';
import { cn } from '../../../lib/utils';
import type { TextEditing } from '../hooks/useDrawings';

type Props = { editing: TextEditing | null; onCommit: (text: string) => void };

/** 没在编辑就不挂载:每次打开都是新的一个输入框,初始文字用 defaultValue 就行 */
export function InlineTextEditor({ editing, onCommit }: Props) {
  return editing ? <OpenEditor editing={editing} onCommit={onCommit} /> : null;
}

function OpenEditor({ editing, onCommit }: Props & { editing: TextEditing }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // 打开就聚焦并全选(同 TradingView:双击已有文字,打字直接替换)
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // 按在框外 / 滚轮:先让它失焦,由 onBlur 统一保存。
  // 不能只靠浏览器自己挪焦点:按在画线上时画线手势会 preventDefault,焦点就留在框里
  useEffect(() => {
    const leave = (e: Event) => {
      // 窗口没焦点(切到别的应用时滚了图表):不动,否则焦点被挪走却不提交,切回来框就卡住收不掉
      if (!document.hasFocus()) return;
      if (e.target !== ref.current) ref.current?.blur();
    };
    window.addEventListener('pointerdown', leave, true);
    window.addEventListener('wheel', leave, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', leave, true);
      window.removeEventListener('wheel', leave, true);
    };
  }, []);

  return (
    <textarea
      ref={ref}
      defaultValue={editing.text}
      rows={1}
      spellCheck={false}
      placeholder="输入文字"
      onBlur={(e) => {
        // 切到别的窗口 / 应用也会失焦,那不算写完:切回来焦点自动回到框里接着写
        if (document.hasFocus()) onCommit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.currentTarget.blur();
      }}
      style={{
        left: editing.x,
        top: editing.y,
        font: TEXT_FONT,
        lineHeight: `${TEXT_LINE}px`,
        padding: `${TEXT_PAD / 2}px ${TEXT_PAD}px`,
      }}
      // 颜色同画布:neutral-200 / 950 就是 CHART_CHROME 的 ink / bg(浅色主题一起翻);黄框同选中的画线
      className={cn(
        'absolute z-20 min-w-16 resize-none overflow-hidden whitespace-pre text-neutral-200 outline-1 outline-yellow-500 [field-sizing:content] placeholder:text-neutral-500',
        editing.box ? 'bg-neutral-950/85 outline-solid' : 'bg-transparent outline-dashed',
      )}
    />
  );
}
