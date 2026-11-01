import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { CATEGORIES, searchSeries } from './registry';

type Props = {
  /** 已在图上的序列 id = 勾选状态 */
  used: Set<string>;
  /** 勾选 = 加到第 1 格;取消勾选 = 从图上拿掉 */
  onToggle: (seriesId: string) => void;
};

// 右侧顶部:搜索框 + 多选下拉。平时只占一行,点开才列序列,可以连续勾好几条(勾完不收起)。
export function SeriesPicker({ used, onToggle }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点下拉框外面收起
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);

    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const hits = searchSeries(query);
  const groups = CATEGORIES.map((c) => ({ category: c, items: hits.filter((d) => d.category === c) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div ref={rootRef} className="relative">
      <label className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 focus-within:border-neutral-600">
        <Search size={14} className="text-neutral-500" />
        <input
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
        {used.size > 0 && <span className="whitespace-nowrap text-xs text-neutral-500">已选 {used.size}</span>}
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
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-96 overflow-y-auto rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg">
          {groups.length === 0 && <p className="px-3 py-2 text-xs text-neutral-500">没有匹配「{query}」的序列</p>}
          {groups.map((g) => (
            <div key={g.category}>
              <h3 className="px-3 pb-0.5 pt-1.5 text-xs text-neutral-500">{g.category}</h3>
              {g.items.map((d) => {
                const on = used.has(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onToggle(d.id)}
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
                    <span className="flex-1 truncate">{d.label}</span>
                    <span className="text-[11px] text-neutral-600">{d.freq}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
