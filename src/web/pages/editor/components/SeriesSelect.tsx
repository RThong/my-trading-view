import { useState } from 'react';
import { Combobox, ComboboxChipsInput, ComboboxTrigger, useComboboxAnchor } from '@web/components/ui/combobox';
import { seriesDef } from '../../../views/chartDoc/registry';
import { type Group, labelOf, SeriesOptionList, useSeriesSearch } from './seriesSearch';

type Props = {
  value: string | undefined;
  onChange: (seriesId: string) => void;
  placeholder: string;
  disabled?: boolean;
  title?: string;
};

// 单选的序列搜索框(图层卡片里选「第二条序列」用)。搜出来的东西与顶部多选框一样;
// 输入框只放关键字,没在打字时用占位文字显示当前选中的那条(选中后关键字清空)。
export function SeriesSelect({ value, onChange, placeholder, disabled, title }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const anchor = useComboboxAnchor();
  const search = useSeriesSearch(query);
  // 只用来选计算的第二条腿:事件日期(发布日)的值无意义,不列
  const groups = search.groups.map((g) => ({ ...g, items: g.items.filter((o) => !seriesDef(o.id)?.events) }));

  // 只认用户打字 / 清空:单选模式下组件库会在选中、收起时把输入框回填成所选序列的名称,
  // 照收的话下次展开就按那个名称过滤,下拉几乎只剩它自己(名称还会被拿去搜 Yahoo)
  function onInputValueChange(value: string, { reason }: { reason: string }) {
    if (reason === 'input-change' || reason === 'input-clear') setQuery(value);
  }

  // 收起时丢掉没选完的关键字:选中的那条靠占位文字显示,输入框里留着半截字会把它挡住,下次展开还按它过滤
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery('');
  }

  function onValueChange(id: string | null) {
    if (id) {
      search.remember(id);
      onChange(id);
    }
    setQuery('');
    setOpen(false);
  }

  return (
    <Combobox<string, false, Group>
      autoHighlight
      items={groups}
      filter={null}
      value={value ?? null}
      onValueChange={onValueChange}
      inputValue={query}
      onInputValueChange={onInputValueChange}
      open={open}
      onOpenChange={onOpenChange}
      itemToStringLabel={labelOf}
      disabled={disabled}
    >
      <div
        ref={anchor}
        title={title ?? (value ? labelOf(value) : undefined)}
        className="flex h-6 min-w-0 flex-1 items-center rounded border border-neutral-800 bg-neutral-900 pl-1.5"
      >
        <ComboboxChipsInput
          placeholder={value ? labelOf(value) : placeholder}
          className={`h-5 min-w-0 text-xs ${value ? 'placeholder:text-neutral-200' : ''}`}
        />
        <ComboboxTrigger title={open ? '收起' : '展开'} />
      </div>
      <SeriesOptionList
        status={search.status}
        yahooLoading={search.yahooLoading}
        anchor={anchor}
        checked={(id) => id === value}
      />
    </Combobox>
  );
}
