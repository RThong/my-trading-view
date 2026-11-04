import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

// 小信息浮层:ⓘ 图标,悬停 / 点击都能打开说明文本块,复用于各 pane 标题。
// 用 Popover(openOnHover)而不是 Tooltip:文案是这条线的**口径文档**,有的上千字,要能把鼠标移进去滚动;
// Tooltip 的语义是一句话提示、触屏上也不打开。Popover 悬停开、点击 / 触屏点按也开,鼠标移进浮层不会关。
export function InfoTip({ text }: { text: string }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        aria-label="指标说明"
        className="ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-400 text-[10px] font-serif font-bold italic leading-none text-neutral-900 shadow-sm hover:bg-amber-300"
      >
        i
      </PopoverTrigger>
      {/* pre-wrap 而非 pre-line:后者会折叠行首空白,文案里的 '  · ' 层级缩进会全部失效。
          限高 + 自滚:不限高就整页盖满并溢出视口,连图都看不见了。 */}
      <PopoverContent
        align="start"
        sideOffset={2}
        className="block max-h-[70vh] w-96 overflow-y-auto whitespace-pre-wrap p-3 text-[13px] leading-relaxed text-neutral-300"
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}
