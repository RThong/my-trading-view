import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
} from '@web/components/ui/combobox';
import { YAHOO_PREFIX } from '../../../views/chartDoc/registry';
import { type Group, labelOf, SeriesOptionList, useSeriesSearch } from './seriesSearch';

type Props = {
  /** 已在图上的序列(按图层顺序),每条带图上的颜色 —— 输入区里一条一个标签 */
  selected: { series: string; color: string }[];
  /** 勾选 = 加到第 1 格;取消勾选 = 从图上拿掉 */
  onToggle: (seriesId: string) => void;
  /** 图上有没有线(含不在标签里的计算线):有就显示清空按钮 */
  canClear: boolean;
  /** 一键清空整张图 */
  onClear: () => void;
};

// 右侧顶部:标签式多选框(shadcn Combobox)。输入区里一条序列一个标签(带图上的颜色,× 删这一条),最右是清空全部和展开;
// 下拉里先列内置序列(按分类),再列 Yahoo 搜索结果(任意代码)。勾一条就收起、清空关键字,接着打字搜下一条;
// 输入框为空时按退格删掉最后一个标签。搜索 / 分组都自己算好再交给组件(filter=null),组件内置的过滤不用。
export function SeriesPicker({ selected, canClear, onToggle, onClear }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const anchor = useComboboxAnchor();

  const used = new Set(selected.map((s) => s.series));
  const colorOf = new Map(selected.map((s) => [s.series, s.color]));
  // 没关键字时 Yahoo 组列图上已有的代码,方便取消勾选
  const search = useSeriesSearch(
    query,
    [...used].filter((id) => id.startsWith(YAHOO_PREFIX)),
  );

  // 选中值的增减翻译成逐条勾选 / 取消(标签上的 × 与退格都只动一条)。
  // Esc 引起的不算:Base UI 在下拉已收起时按 Esc 会清空选中值,这里 Esc 只该收起下拉,照这个处理会清空整张图
  function onValueChange(next: string[], { reason }: { reason: string }) {
    if (reason === 'escape-key') return;
    next
      .filter((id) => !used.has(id))
      .forEach((id) => {
        search.remember(id);
        onToggle(id);
      });
    [...used].filter((id) => !next.includes(id)).forEach(onToggle);
    // 勾完收起、清空关键字(焦点组件自己留在输入框):接着打字就重新展开搜下一条
    setQuery('');
    setOpen(false);
  }

  return (
    <Combobox<string, true, Group>
      multiple
      autoHighlight
      items={search.groups}
      filter={null}
      value={[...used]}
      onValueChange={onValueChange}
      inputValue={query}
      onInputValueChange={setQuery}
      open={open}
      onOpenChange={setOpen}
      itemToStringLabel={labelOf}
    >
      {/* 标签 + 输入框在左边自动换行;清空 / 展开固定在最右,不跟着标签折到第二行 */}
      <ComboboxChips
        ref={anchor}
        className="flex-nowrap items-start gap-1.5 border-neutral-800 bg-neutral-900 px-2 py-1"
      >
        <Search size={14} className="mt-1 shrink-0 text-neutral-500" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <ComboboxValue>
            {(values: string[]) => (
              <>
                {values.map((id) => (
                  <ComboboxChip key={id} title={labelOf(id)}>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf.get(id) }} />
                    <span className="max-w-28 truncate">{labelOf(id)}</span>
                  </ComboboxChip>
                ))}
                <ComboboxChipsInput
                  placeholder={values.length ? '' : '搜索并勾选序列'}
                  className="h-5.5 text-sm text-neutral-200"
                />
              </>
            )}
          </ComboboxValue>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          {/* 不用组件自带的清空(它只清标签):计算线(A − B)不在标签里,清不掉;图上只剩计算线时它还不显示 */}
          {canClear && (
            <Button variant="ghost" size="icon-xs" className="text-neutral-500" onClick={onClear} title="清空整张图">
              <X />
            </Button>
          )}
          <ComboboxTrigger title={open ? '收起' : '展开'} />
        </div>
      </ComboboxChips>

      <SeriesOptionList
        status={search.status}
        yahooLoading={search.yahooLoading}
        anchor={anchor}
        checked={(id) => used.has(id)}
      />
    </Combobox>
  );
}
