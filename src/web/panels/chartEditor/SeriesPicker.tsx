import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { CATEGORIES, YAHOO_PREFIX, rememberYahooName, searchSeries, seriesDef, yahooId } from './registry';
import { searchable, useYahooSearch } from './useYahooSearch';

type Props = {
  /** 已在图上的序列 id = 勾选状态 */
  used: Set<string>;
  /** 勾选 = 加到第 1 格;取消勾选 = 从图上拿掉 */
  onToggle: (seriesId: string) => void;
  /** 一键清空图上所有序列 */
  onClear: () => void;
};

// 右侧顶部:搜索框 + 多选下拉。平时只占一行,点开才列序列;勾一条就收起、清空关键字,接着打字搜下一条。
// 下拉里先列内置序列(按分类),再列 Yahoo 搜索结果(任意代码)。
export function SeriesPicker({ used, onToggle, onClear }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点下拉框外面收起
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);

    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 勾选后清空关键字、收起列表(下次展开从头开始),焦点留在输入框:接着打字就重新展开搜下一条
  const pick = (id: string) => {
    onToggle(id);
    setQuery('');
    // 先聚焦再收起:聚焦会触发 onFocus 的展开,放在后面就把刚收起的列表又打开了
    inputRef.current?.focus();
    setOpen(false);
  };

  const q = query.trim();
  const yahoo = useYahooSearch(query);
  const usedYahoo = [...used].filter((id) => id.startsWith(YAHOO_PREFIX));
  const hits = searchSeries(query);
  const groups = CATEGORIES.map((c) => ({ category: c, items: hits.filter((d) => d.category === c) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div ref={rootRef} className="relative">
      <label className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 focus-within:border-neutral-600">
        <Search size={14} className="text-neutral-500" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          placeholder="搜索并勾选序列"
          className="w-full bg-transparent text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
        />
        {used.size > 0 && (
          <>
            <span className="whitespace-nowrap text-xs text-neutral-500">已选 {used.size}</span>
            <button
              type="button"
              onClick={onClear}
              className="flex items-center whitespace-nowrap text-xs text-neutral-500 hover:text-neutral-200"
              title="清空图上所有序列"
            >
              <X size={12} />
              清空
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-neutral-500 hover:text-neutral-200"
          title={open ? '收起' : '展开'}
        >
          <ChevronDown size={14} className={open ? 'rotate-180' : ''} />
        </button>
      </label>

      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-[28rem] overflow-y-auto rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg">
          {groups.length === 0 && !q && <p className="px-3 py-2 text-xs text-neutral-500">没有可选的序列</p>}
          {groups.map((g) => (
            <div key={g.category}>
              <h3 className="px-3 pb-0.5 pt-1.5 text-xs text-neutral-500">{g.category}</h3>
              {g.items.map((d) => (
                <OptionRow key={d.id} on={used.has(d.id)} onClick={() => pick(d.id)} label={d.label} meta={d.freq} />
              ))}
            </div>
          ))}

          {/* 任意 Yahoo 代码:有关键字时列搜索结果;没关键字时列图上已有的,方便取消勾选 */}
          <div>
            <h3 className="px-3 pb-0.5 pt-1.5 text-xs text-neutral-500">
              Yahoo
              {q
                ? searchable(q)
                  ? yahoo.isLoading
                    ? ' · 搜索中…'
                    : ` · 搜到 ${yahoo.hits.length} 个`
                  : ' · 只能用英文名或代码搜'
                : ' · 图上已有'}
            </h3>
            {q ? (
              <>
                {yahoo.hits.map((h) => (
                  <OptionRow
                    key={h.symbol}
                    on={used.has(yahooId(h.symbol))}
                    onClick={() => {
                      rememberYahooName(h.symbol, h.name);
                      pick(yahooId(h.symbol));
                    }}
                    label={
                      <>
                        <span className="font-medium text-neutral-200">{h.symbol}</span>{' '}
                        <span className="text-neutral-400">{h.name}</span>
                      </>
                    }
                    meta={TYPE_LABEL[h.type] ?? h.type}
                    title={[h.symbol, h.name, h.exchange].filter(Boolean).join(' · ')}
                  />
                ))}
                {searchable(q) && !yahoo.isLoading && yahoo.hits.length === 0 && (
                  <p className="px-3 py-1 text-xs text-neutral-600">
                    {yahoo.error ? '搜索失败,稍后再试' : 'Yahoo 上没搜到(用英文名或代码搜,如 gold、GC=F、^N225)'}
                  </p>
                )}
              </>
            ) : usedYahoo.length > 0 ? (
              usedYahoo.map((id) => (
                <OptionRow key={id} on onClick={() => pick(id)} label={seriesDef(id)?.label ?? id} meta="日" />
              ))
            ) : (
              <p className="px-3 py-1 text-xs text-neutral-600">输入代码或英文名搜索 Yahoo 上的任意品种</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Yahoo 的 quoteType → 短中文标签(交易所全名太长,挤掉代码;放进悬停提示)
const TYPE_LABEL: Record<string, string> = {
  EQUITY: '股票',
  ETF: 'ETF',
  INDEX: '指数',
  FUTURE: '期货',
  CURRENCY: '汇率',
  CRYPTOCURRENCY: '加密',
  MUTUALFUND: '基金',
};

function OptionRow({
  on,
  onClick,
  label,
  meta,
  title,
}: {
  on: boolean;
  onClick: () => void;
  label: ReactNode;
  meta: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white"
    >
      <span
        className={
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ' +
          (on ? 'border-sky-500 bg-sky-500 text-neutral-950' : 'border-neutral-600')
        }
      >
        {on && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] text-neutral-600">{meta}</span>
    </button>
  );
}
