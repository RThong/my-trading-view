import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

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

// 激活 / 悬停样式。shadcn tabs 默认是灰底胶囊,这里改回原来的「激活 neutral-700 底」样式。
// 激活阴影写在 group-data-[variant=default]/tabs-list:data-active: 变体下,要用同一个变体前缀才盖得掉
const TRIGGER =
  'h-auto flex-none rounded border-0 px-3 py-1.5 text-sm font-normal text-neutral-400 hover:bg-neutral-800 hover:text-white ' +
  'data-active:bg-neutral-700 data-active:text-white data-active:hover:bg-neutral-700 ' +
  'group-data-[variant=default]/tabs-list:data-active:shadow-none group-data-[orientation=vertical]/tabs:justify-center';

export function TabBar({ tabs, active, onChange, vertical }: Props) {
  // 单视图视角:横排只有 ≤1 个 tab 时不渲染(不显示孤零零一个横 tab)。竖排不受此限。
  if (!vertical && tabs.length <= 1) return null;

  const trigger = (t: Tab) => (
    <TabsTrigger key={t.id} value={t.id} className={TRIGGER}>
      {t.label}
    </TabsTrigger>
  );

  if (vertical) {
    return (
      <Tabs
        orientation="vertical"
        value={active}
        onValueChange={(v) => onChange(String(v))}
        className="border-r border-neutral-800 px-2 py-3"
      >
        <TabsList className="w-full items-stretch gap-1 rounded-none bg-transparent p-0">{tabs.map(trigger)}</TabsList>
      </Tabs>
    );
  }

  // 横排:每组一块,块之间留大间距 + 竖线。组名小而暗 —— 它是分区标签,不是可点的 tab。
  // 组间距用 gap-8 而不是 justify-between:标的数不均时(云厂商 5 个、备查 1 个)平均分布
  // 会把小组推到很远,反而看不出「这几个是一伙的」。
  return (
    <Tabs value={active} onValueChange={(v) => onChange(String(v))} className="border-b border-neutral-800 px-6 py-2">
      <TabsList className="flex w-full flex-wrap justify-start gap-x-8 gap-y-1 rounded-none bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-auto">
        {chunkByGroup(tabs).map((chunk, i) => (
          <div key={chunk.group ?? `g${i}`} className="flex items-center gap-1">
            {chunk.group && (
              <span className="mr-1 select-none whitespace-nowrap text-xs text-neutral-600">{chunk.group}</span>
            )}
            {chunk.items.map(trigger)}
          </div>
        ))}
      </TabsList>
    </Tabs>
  );
}
