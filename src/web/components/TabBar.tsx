/** group 省略 = 不分组(和以前一样一条排开)。同一 group 的 tab 必须相邻,顺序即渲染顺序。 */
type Tab = { id: string; label: string; group?: string };

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  vertical?: boolean;
};

/** 按 group 切成连续的块。**不重排**:分组只是在原顺序上插分隔,顺序由调用方决定。 */
function chunkByGroup(tabs: Tab[]): Array<{ group?: string; items: Tab[] }> {
  return tabs.reduce<Array<{ group?: string; items: Tab[] }>>((acc, t) => {
    const last = acc.at(-1);
    if (last && last.group === t.group) last.items.push(t);
    else acc.push({ group: t.group, items: [t] });
    return acc;
  }, []);
}

export function TabBar({ tabs, active, onChange, vertical }: Props) {
  // 单视图视角:横排只有 ≤1 个 tab 时不渲染(不显示孤零零一个横 tab)。竖排不受此限。
  if (!vertical && tabs.length <= 1) return null;

  const btn = (t: Tab) => (
    <button
      key={t.id}
      onClick={() => onChange(t.id)}
      className={
        'rounded px-3 py-1.5 text-sm transition-colors ' +
        (t.id === active ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-800')
      }
    >
      {t.label}
    </button>
  );

  if (vertical) {
    return <nav className="flex flex-col gap-1 border-r border-neutral-800 px-2 py-3">{tabs.map(btn)}</nav>;
  }

  // 横排:每组一块,块之间留大间距 + 竖线。组名小而暗 —— 它是分区标签,不是可点的 tab。
  // 组间距用 gap-8 而不是 justify-between:标的数不均时(云厂商 5 个、备查 1 个)平均分布
  // 会把小组推到很远,反而看不出「这几个是一伙的」。
  return (
    <nav className="flex flex-wrap items-center gap-x-8 gap-y-1 border-b border-neutral-800 px-6 py-2">
      {chunkByGroup(tabs).map((chunk, i) => (
        <div key={chunk.group ?? `g${i}`} className="flex items-center gap-1">
          {chunk.group && (
            <span className="mr-1 select-none whitespace-nowrap text-xs text-neutral-600">{chunk.group}</span>
          )}
          {chunk.items.map(btn)}
        </div>
      ))}
    </nav>
  );
}
