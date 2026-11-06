import { useState } from 'react';
import { Input } from '../../../components/ui/input';
import { cn } from '../../../lib/utils';

type Props = {
  value: number;
  onCommit: (n: number) => void;
  className?: string;
  title?: string;
  disabled?: boolean;
};

// 数字输入:边打边存草稿,回车或失焦才提交。直接受控的话,打到一半的「-」「」会被立刻纠正回原值,负数都打不进去。
export function NumberField({ value, onCommit, className, title, disabled }: Props) {
  const [draft, setDraft] = useState(String(value));
  // 外部值变了(比如点了 ± 按钮)→ 草稿跟着换。渲染中同步 + 单调 guard,不用 effect
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }

  const commit = () => {
    const n = Number(draft.trim());
    if (draft.trim() !== '' && Number.isFinite(n)) onCommit(n);
    else setDraft(String(value));
  };

  return (
    <Input
      type="text"
      inputMode="numeric"
      value={draft}
      title={title}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      // Esc 也提交:输入框在弹层里,Esc 关弹层时它直接卸载、不触发 blur,不提交草稿就丢了(点外部关会先 blur,不受影响)
      onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && commit()}
      className={cn(
        'h-5 rounded bg-neutral-900 px-1 py-0 text-center text-xs tabular-nums text-neutral-200 disabled:opacity-40',
        className ?? 'w-12',
      )}
    />
  );
}
