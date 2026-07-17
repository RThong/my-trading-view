import { useState } from 'react';

// 小信息浮层:ⓘ 图标,hover/focus 显示说明文本块。无依赖,复用于各 pane 标题。
// focus/blur 一并处理 → 键盘可达、触屏点得开(纯 hover 在无鼠标设备上打不开)。
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative ml-1.5 inline-flex">
      <button
        type="button"
        aria-label="指标说明"
        className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] font-serif font-bold italic leading-none text-neutral-900 shadow-sm hover:bg-amber-300"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open && (
        <span className="absolute left-0 top-5 z-30 block w-96 whitespace-pre-line rounded border border-neutral-700 bg-neutral-900 p-3 text-[13px] font-normal not-italic leading-relaxed text-neutral-300 shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}
