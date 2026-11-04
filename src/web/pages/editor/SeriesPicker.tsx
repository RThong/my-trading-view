import { type ReactNode, useState } from 'react';
import { Check, Search } from 'lucide-react';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxClear,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
} from '@web/components/ui/combobox';
import {
  CATEGORIES,
  REGISTRY,
  YAHOO_PREFIX,
  libraryIdForYahoo,
  rememberYahooName,
  searchSeries,
  seriesDef,
  yahooId,
} from '../../views/chartDoc/registry';
import { useVxContracts } from './useVxContracts';
import { searchable, type YahooHit, useYahooSearch } from './useYahooSearch';

type Props = {
  /** 已在图上的序列(按图层顺序),每条带图上的颜色 —— 输入区里一条一个标签 */
  selected: { series: string; color: string }[];
  /** 勾选 = 加到第 1 格;取消勾选 = 从图上拿掉 */
  onToggle: (seriesId: string) => void;
  /** 一键清空图上所有序列 */
  onClear: () => void;
};

/** 下拉里的一行:id 是选中值,其余只管显示 */
type Option = { id: string; label: ReactNode; meta: string; title?: string };
type Group = { value: string; items: Option[] };

const TYPE_LABEL: Record<string, string> = {
  EQUITY: '股票',
  ETF: 'ETF',
  INDEX: '指数',
  FUTURE: '期货',
  CURRENCY: '汇率',
  CRYPTOCURRENCY: '加密',
  MUTUALFUND: '基金',
};

function yahooOption(h: YahooHit): Option {
  return {
    id: yahooId(h.symbol),
    label: (
      <>
        <span className="font-medium text-neutral-200">{h.symbol}</span>{' '}
        <span className="text-neutral-400">{h.name}</span>
      </>
    ),
    meta: TYPE_LABEL[h.type] ?? h.type,
    title: [h.symbol, h.name, h.exchange].filter(Boolean).join(' · '),
  };
}

function labelOf(id: string) {
  return seriesDef(id)?.label ?? id;
}

// 右侧顶部:标签式多选框(shadcn Combobox)。输入区里一条序列一个标签(带图上的颜色,× 删这一条),最右是清空全部和展开;
// 下拉里先列内置序列(按分类),再列 Yahoo 搜索结果(任意代码)。勾一条就收起、清空关键字,接着打字搜下一条;
// 输入框为空时按退格删掉最后一个标签。搜索 / 分组都自己算好再交给组件(filter=null),组件内置的过滤不用。
export function SeriesPicker({ selected, onToggle, onClear }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const anchor = useComboboxAnchor();

  const q = query.trim();
  const yahoo = useYahooSearch(query);
  const used = new Set(selected.map((s) => s.series));
  const colorOf = new Map(selected.map((s) => [s.series, s.color]));
  // 库里已有的 Yahoo 代码(SPY、^VIX…)归到库里那条:并进内置结果,不在 Yahoo 组里再列一条
  const yahooOnly = yahoo.hits.filter((h) => !libraryIdForYahoo(h.symbol));
  const vxContracts = useVxContracts();
  const hitIds = new Set([
    ...searchSeries(query, vxContracts).map((d) => d.id),
    ...(q ? yahoo.hits.map((h) => libraryIdForYahoo(h.symbol)) : []),
  ]);
  const hits = [...REGISTRY, ...vxContracts].filter((d) => hitIds.has(d.id));
  const builtin: Group[] = CATEGORIES.map((c) => ({
    value: c,
    items: hits.filter((d) => d.category === c).map((d) => ({ id: d.id, label: d.label, meta: d.freq })),
  }));
  // Yahoo:有关键字时列搜索结果;没关键字时列图上已有的,方便取消勾选
  const yahooItems: Option[] = q
    ? yahooOnly.map(yahooOption)
    : [...used].filter((id) => id.startsWith(YAHOO_PREFIX)).map((id) => ({ id, label: labelOf(id), meta: '日' }));
  const groups = [...builtin, { value: 'Yahoo', items: yahooItems }].filter((g) => g.items.length > 0);
  const yahooStatus = !q
    ? yahooItems.length === 0
      ? '输入代码或英文名搜索 Yahoo 上的任意品种'
      : null
    : !searchable(q)
      ? 'Yahoo 只能用英文名或代码搜'
      : yahoo.isLoading
        ? 'Yahoo · 搜索中…'
        : yahoo.hits.length > 0
          ? null
          : yahoo.error
            ? 'Yahoo · 搜索失败,稍后再试'
            : 'Yahoo 上没搜到(用英文名或代码搜,如 gold、GC=F、^N225)';

  // 选中值的增减翻译成逐条勾选 / 取消;清空走 onClear(一次清掉,不逐条删)。
  // Esc 引起的不算:Base UI 在下拉已收起时按 Esc 会清空选中值,这里 Esc 只该收起下拉,照这个处理会清空整张图
  const onValueChange = (next: string[], { reason }: { reason: string }) => {
    if (reason === 'escape-key') return;
    if (next.length === 0 && used.size > 1) onClear();
    else {
      next
        .filter((id) => !used.has(id))
        .forEach((id) => {
          const hit = yahoo.hits.find((h) => yahooId(h.symbol) === id);
          if (hit) rememberYahooName(hit.symbol, hit.name);
          onToggle(id);
        });
      [...used].filter((id) => !next.includes(id)).forEach(onToggle);
    }
    // 勾完收起、清空关键字(焦点组件自己留在输入框):接着打字就重新展开搜下一条
    setQuery('');
    setOpen(false);
  };

  return (
    <Combobox<string, true, Group>
      multiple
      autoHighlight
      items={groups}
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
          {used.size > 0 && <ComboboxClear title="清空图上所有序列" />}
          <ComboboxTrigger title={open ? '收起' : '展开'} />
        </div>
      </ComboboxChips>

      <ComboboxContent anchor={anchor} className="ring-neutral-700">
        {/* Yahoo 还在搜时先不说「没有匹配」,免得和下面的「搜索中」打架 */}
        {!yahoo.isLoading && <ComboboxEmpty>没有匹配的序列</ComboboxEmpty>}
        {/* 最高 28rem,窗口矮时按可用高度收(留出下面那行 Yahoo 提示),否则列表底部被裁掉、滚不到 */}
        <ComboboxList className="max-h-[min(28rem,calc(var(--available-height)-2.5rem))]">
          {(group: Group) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(o: Option) => (
                  <ComboboxItem
                    key={o.id}
                    value={o.id}
                    title={o.title}
                    showIndicator={false}
                    className="text-neutral-300"
                  >
                    {/* 选中标记放最左:复选框样式,同改版前 */}
                    <span
                      className={
                        'flex size-3.5 shrink-0 items-center justify-center rounded-sm border ' +
                        (used.has(o.id) ? 'border-sky-500 bg-sky-500 text-neutral-950' : 'border-neutral-600')
                      }
                    >
                      {used.has(o.id) && <Check className="size-2.75" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    <span className="shrink-0 text-[11px] text-neutral-600">{o.meta}</span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {yahooStatus && <p className="px-3 pb-2 pt-1 text-xs text-neutral-600">{yahooStatus}</p>}
      </ComboboxContent>
    </Combobox>
  );
}
