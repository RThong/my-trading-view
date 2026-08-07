import { useState } from 'react';

// 小信息浮层:ⓘ 图标,hover/focus 显示说明文本块。无依赖,复用于各 pane 标题。
// focus/blur 一并处理 → 键盘可达、触屏点得开(纯 hover 在无鼠标设备上打不开)。
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    // 悬停区是**包裹层**而不是按钮:浮层是它的绝对定位子元素,挂在按钮上则鼠标一移进浮层
    // 就触发按钮的 mouseleave → 浮层消失 → 长文案永远滚不动。键盘那条仍走按钮的 focus/blur。
    <span
      className="relative ml-1.5 inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="指标说明"
        className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] font-serif font-bold italic leading-none text-neutral-900 shadow-sm hover:bg-amber-300"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {/* pre-wrap 而非 pre-line:后者会折叠行首空白,文案里的 '  · ' 层级缩进会全部失效。 */}
      {/* 限高 + 自滚:这些文案是这条线的**口径文档**(逐期 tag 裁决、重叠期实测值、判据影响都写在里面),
          有的上千字。不限高就整页盖满并溢出视口,连图都看不见了。 */}
      {open && (
        <span className="absolute left-0 top-5 z-30 block max-h-[70vh] w-96 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-700 bg-neutral-900 p-3 text-[13px] font-normal not-italic leading-relaxed text-neutral-300 shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}
