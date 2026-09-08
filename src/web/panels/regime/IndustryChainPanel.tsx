import { useState } from 'react';
import { TabBar } from '../../components/TabBar';
import { RegimeChart } from './RegimeChart';
import type { Interval } from '../../hooks/interval';
import { GROUP_ORDER, GROUP_LABELS, activeByGroup } from '../../../shared/aiChain';

// 产业链公司明细的内部公司选择器,按 GROUP_ORDER 分组(资金流向:云厂商花钱 → 算力芯片 → 上游产能)。
// 独立收进「AI」视角自己的一个横 tab(见 perspectives.tsx),不跟算力价格/买方合计/AI CDS 挤同一条 tab 条。
const COMPANY_TABS = GROUP_ORDER.flatMap((g) =>
  activeByGroup(g).map((ticker) => ({ id: ticker, label: ticker, group: GROUP_LABELS[g] })),
);

/**
 * ⚠️ 这里**必须一家一个 RegimeChart 实例**,不能用一个实例喂变化的 dim。
 *
 * `RegimeChart` 的不变式是「实例与维度绑定一辈子」(见该文件注释),它下游那三个 hook 全按这个假设写:
 * `usePaneChart` 的 `order` / `collapsed` 是 `useState(初始值来自 paneDefs)` —— 只在挂载时算一次;
 * `useTrendlines` 的 `entriesRef` 按 pane key 累积、只增不删。dim 一变,这些状态全部 stale:
 * hover 图例与分位徽标 find 不到 key 整块消失、↑↓ 换位静默失效(按钮却看着可点)、
 * collapsed 跨公司残留把格子压扁但线还画着、趋势线落到上一家的 storageKey 上存了读不回来。
 * 而且各家 pane 数不同(当前名单:多数 6 格,GOOGL/AMZN/ORCL 带分部格 7 格,TSM 走 sec6k+twse 8 格),
 * paneCount 变化会重建 chart 但那些状态不会重置。
 *
 * 改动前每家公司是主 tab 条上一个独立横 tab,天然各自一个实例 —— 收进这个面板后得自己把这件事补回来。
 *
 * 挂载策略照抄 App.tsx / usePerspectiveNavigation 的 keep-alive:**看过的才建、建了就不卸**,
 * 非活跃的挂 hidden(实例和缩放/折叠/趋势线状态都留着,只是不渲染像素)。
 * 不一上来全建 15 张 —— 首次打开这个 tab 会明显卡一下。
 */
export function IndustryChainPanel({ interval }: { interval: Interval }) {
  const first = COMPANY_TABS[0]!.id;
  const [ticker, setTicker] = useState(first);
  const [seen, setSeen] = useState<Set<string>>(() => new Set([first]));

  const select = (id: string) => {
    setTicker(id);
    setSeen((s) => (s.has(id) ? s : new Set(s).add(id)));
  };

  return (
    <div className="flex h-full flex-col">
      <TabBar tabs={COMPANY_TABS} active={ticker} onChange={select} />
      <div className="min-h-0 flex-1">
        {COMPANY_TABS.filter((t) => seen.has(t.id)).map((t) => (
          <div key={t.id} className={t.id === ticker ? 'h-full' : 'hidden'}>
            <RegimeChart dim={`fundamentals:${t.id}`} interval={interval} />
          </div>
        ))}
      </div>
    </div>
  );
}
