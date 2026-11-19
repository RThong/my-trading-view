// 自建 tab 的竖 / 横 tab 条:样子同内置 TabBar(共用 TRIGGER 样式),另带增删改。
// 双击名字改名(回车 / 失焦提交,Esc 放弃,改成空白不算);悬停出 × 删除(先确认);末尾 + 新建并直接进改名。
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { TRIGGER } from '../../components/TabBar';
import { cn } from '../../lib/utils';

type Item = { id: string; label: string };

type Props = {
  items: Item[];
  active: string | null | undefined;
  onSelect: (id: string) => void;
  /** 新建,返回新项的 id */
  onAdd: () => string;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
  /** 竖排(视角)/ 横排(横 tab) */
  vertical?: boolean;
  /** 「+」的提示和删除确认里用的名字,如「视角」「标签」 */
  noun: string;
};

export function CustomTabBar({ items, active, onSelect, onAdd, onRename, onRemove, vertical, noun }: Props) {
  const [editing, setEditing] = useState<string | null>(null);

  const commit = (id: string, value: string) => {
    if (value.trim()) onRename(id, value.trim());
    setEditing(null);
  };

  const remove = (it: Item) => {
    if (window.confirm(`删除${noun}「${it.label}」?里面的图会一起删掉。`)) onRemove(it.id);
  };

  const item = (it: Item) =>
    editing === it.id ? (
      <input
        key={it.id}
        autoFocus
        defaultValue={it.label}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(it.id, e.currentTarget.value)}
        onKeyDown={(e) => {
          // 输入法选字时的回车 / Esc 是给输入法的,不算提交 / 放弃
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') commit(it.id, e.currentTarget.value);
          if (e.key === 'Escape') setEditing(null);
        }}
        className={cn(
          'rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-50 outline-none',
          vertical ? 'w-full' : 'w-32',
        )}
      />
    ) : (
      <div key={it.id} className="group relative">
        <button
          type="button"
          data-active={it.id === active ? '' : undefined}
          onClick={() => onSelect(it.id)}
          onDoubleClick={() => setEditing(it.id)}
          title="双击改名"
          className={cn(TRIGGER, 'inline-flex items-center whitespace-nowrap', vertical && 'w-full justify-center')}
        >
          {it.label}
        </button>
        {/* 悬停是红底,字固定用白:换成会随主题翻色的 neutral-50,浅色下会变成红底深色字 */}
        <button
          type="button"
          aria-label={`删除${noun}`}
          onClick={() => remove(it)}
          className="absolute -top-1 -right-1 hidden rounded-full bg-neutral-700 p-0.5 text-neutral-300 hover:bg-red-600 hover:text-white group-hover:block"
        >
          <X className="size-3" />
        </button>
      </div>
    );

  return (
    <div className={cn('flex gap-1', vertical ? 'flex-col' : 'flex-wrap items-center')}>
      {items.map(item)}
      <button
        type="button"
        aria-label={`新建${noun}`}
        title={`新建${noun}`}
        onClick={() => setEditing(onAdd())}
        className="flex items-center justify-center rounded px-2 py-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-50"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
