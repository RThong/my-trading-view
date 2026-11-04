// 序列搜索的公共部分:关键字 → 分组的下拉选项(内置序列按分类 + Yahoo 任意代码)与下拉列表本身。
// 顶部多选框(SeriesPicker)与图层卡片里选「第二条序列」的单选框(SeriesSelect)共用,两处搜出来的东西一样。
import { type ReactNode, type RefObject, useCallback, useMemo } from 'react';
import { Check } from 'lucide-react';
import {
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from '@web/components/ui/combobox';
import {
  CATEGORIES,
  REGISTRY,
  familyHints,
  libraryIdForYahoo,
  rememberYahooName,
  searchSeries,
  seriesDef,
  type SeriesDef,
  yahooId,
} from '../../../views/chartDoc/registry';
import { useVxContracts } from '../hooks/useVxContracts';
import { searchable, type YahooHit, useYahooSearch } from '../hooks/useYahooSearch';

/** 下拉里的一行:id 是选中值,其余只管显示 */
type Option = { id: string; label: ReactNode; meta: string; title?: string };
export type Group = { value: string; items: Option[]; hint?: string };

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

export function labelOf(id: string) {
  return seriesDef(id)?.label ?? id;
}

const NO_IDLE: string[] = [];

function buildGroups(query: string, hits: YahooHit[], vxContracts: SeriesDef[], idle: string[]): Group[] {
  const q = query.trim();
  // 库里已有的 Yahoo 代码(SPY、^VIX…)归到库里那条:并进内置结果,不在 Yahoo 组里再列一条
  const yahooOnly = hits.filter((h) => !libraryIdForYahoo(h.symbol));
  const hitIds = new Set([
    ...searchSeries(query, vxContracts).map((d) => d.id),
    ...(q ? hits.map((h) => libraryIdForYahoo(h.symbol)) : []),
  ]);
  const all = [...REGISTRY, ...vxContracts];
  const matched = all.filter((d) => hitIds.has(d.id));
  const hints = familyHints(query, all);
  const builtin: Group[] = CATEGORIES.map((c) => ({
    value: c,
    items: matched.filter((d) => d.category === c).map((d) => ({ id: d.id, label: d.label, meta: d.code ?? d.freq })),
    ...(hints[c] && { hint: hints[c] }),
  }));
  const yahooItems: Option[] = q
    ? yahooOnly.map(yahooOption)
    : idle.map((id) => ({ id, label: labelOf(id), meta: '日' }));

  return [...builtin, { value: 'Yahoo', items: yahooItems }].filter((g) => g.items.length > 0);
}

/**
 * 关键字 → 分组选项。idle = 没关键字时 Yahoo 组里列哪些(多选框列图上已有的 Yahoo 代码,方便取消勾选)。
 * remember:选中一条 Yahoo 代码时记下它的名字(文档只存代码,名字给标签用)。
 * 返回值引用稳定(只在关键字 / 搜索结果 / 名单内容变了时才换),父组件因十字线等频繁重渲染时不跟着重算。
 */
export function useSeriesSearch(query: string, idle: string[] = NO_IDLE) {
  const yahoo = useYahooSearch(query);
  const vxContracts = useVxContracts();

  // 调用方每次渲染都给新数组:按内容当依赖(稳定化责任放在 hook 内)
  const idleKey = idle.join('\n');
  const groups = useMemo(
    () => buildGroups(query, yahoo.hits, vxContracts, idleKey ? idleKey.split('\n') : NO_IDLE),
    [query, yahoo.hits, vxContracts, idleKey],
  );

  const q = query.trim();
  const yahooCount = groups.find((g) => g.value === 'Yahoo')?.items.length ?? 0;
  const status = !q
    ? yahooCount === 0
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

  const hits = yahoo.hits;
  const remember = useCallback(
    (id: string) => {
      const hit = hits.find((h) => yahooId(h.symbol) === id);
      if (hit) rememberYahooName(hit.symbol, hit.name);
    },
    [hits],
  );

  return useMemo(
    () => ({ groups, status, yahooLoading: yahoo.isLoading, remember }),
    [groups, status, yahoo.isLoading, remember],
  );
}

type ListProps = {
  status: string | null;
  yahooLoading: boolean;
  anchor: RefObject<HTMLDivElement | null>;
  /** 哪些行打勾 */
  checked: (id: string) => boolean;
};

/** 下拉列表(分组 + 每行复选框样式的选中标记 + 底部 Yahoo 提示)。 */
/** 选项来自外层 Combobox 的 items(列表按它渲染),这里不再传一份。 */
export function SeriesOptionList({ status, yahooLoading, anchor, checked }: ListProps) {
  return (
    <ComboboxContent anchor={anchor} className="ring-neutral-700">
      {/* Yahoo 还在搜时先不说「没有匹配」,免得和下面的「搜索中」打架 */}
      {!yahooLoading && <ComboboxEmpty>没有匹配的序列</ComboboxEmpty>}
      {/* 最高 28rem,窗口矮时按可用高度收(留出下面那行 Yahoo 提示),否则列表底部被裁掉、滚不到 */}
      <ComboboxList className="max-h-[min(28rem,calc(var(--available-height)-2.5rem))]">
        {(group: Group) => (
          <ComboboxGroup key={group.value} items={group.items}>
            <ComboboxLabel>
              {group.value}
              {group.hint && <span className="ml-1.5 font-normal text-neutral-600">{group.hint}</span>}
            </ComboboxLabel>
            <ComboboxCollection>
              {(o: Option) => (
                <ComboboxItem
                  key={o.id}
                  value={o.id}
                  title={o.title}
                  showIndicator={false}
                  className="text-neutral-300"
                >
                  {/* 选中标记放最左:复选框样式 */}
                  <span
                    className={
                      'flex size-3.5 shrink-0 items-center justify-center rounded-sm border ' +
                      (checked(o.id) ? 'border-sky-500 bg-sky-500 text-neutral-950' : 'border-neutral-600')
                    }
                  >
                    {checked(o.id) && <Check className="size-2.75" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="shrink-0 text-[11px] text-neutral-600">{o.meta}</span>
                </ComboboxItem>
              )}
            </ComboboxCollection>
          </ComboboxGroup>
        )}
      </ComboboxList>
      {status && <p className="px-3 pb-2 pt-1 text-xs text-neutral-600">{status}</p>}
    </ComboboxContent>
  );
}
