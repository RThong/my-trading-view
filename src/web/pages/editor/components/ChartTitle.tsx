// 图表标题:点一下就能改,回车 / 失焦提交(改一次算一步撤销,不是每个字一步),Esc 放弃。导出图片时写在顶上。
// 不受控输入:撤销 / 载入换了标题时,调用方用 key={title} 让它按新标题重来
export function ChartTitle({ title, onChange }: { title?: string; onChange: (title: string) => void }) {
  return (
    <input
      defaultValue={title ?? ''}
      maxLength={80}
      placeholder="未命名图表(点这里加标题,导出图片时写在顶上)"
      onBlur={(e) => onChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        // 中文输入法选字时的回车是确认候选词,不是提交
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') e.currentTarget.value = title ?? '';
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
      }}
      className="w-full rounded bg-transparent px-1 py-0.5 text-sm font-medium text-neutral-200 outline-none placeholder:font-normal placeholder:text-neutral-600 hover:bg-neutral-900 focus:bg-neutral-900"
    />
  );
}
