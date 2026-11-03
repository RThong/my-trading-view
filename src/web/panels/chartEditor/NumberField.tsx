import { useState } from 'react';

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
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      title={title}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className={
        'rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-center text-xs tabular-nums text-neutral-200 outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40 ' +
        (className ?? 'w-12')
      }
    />
  );
}
