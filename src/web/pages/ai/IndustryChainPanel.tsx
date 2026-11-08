import { useState } from 'react';
import { TabBar } from '../../components/TabBar';
import { FundChart } from '../../views/regime/FundChart';
import type { Interval } from '../../hooks/interval';
import { GROUP_ORDER, GROUP_LABELS, activeByGroup } from '../../../shared/aiChain';
import { fundamentalDoc } from '../regimeDims';

// 产业链公司明细的内部公司选择器,按 GROUP_ORDER 分组(资金流向:云厂商花钱 → 算力芯片 → 上游产能)。
// 独立收进「AI」视角自己的一个横 tab(见 pages/ai/index.tsx),不跟算力价格/买方合计/AI CDS 挤同一条 tab 条。
const COMPANY_TABS = GROUP_ORDER.flatMap((g) =>
  activeByGroup(g).map((ticker) => ({ id: ticker, label: ticker, group: GROUP_LABELS[g] })),
);

/**
 * ⚠️ 这里**必须一家一个图表实例**(FundChart → DocChart),不能用一个实例喂变化的 doc。
 *
 * DocChart 以传进来的 doc 为初值、之后在组件内自己留一份副本(眼睛按钮、拖分隔条只改副本)——
 * 换一家公司只换 props 的话,副本还是上一家的,图上画的仍是上一家。各家格数也不同
 * (多数 6 格,带分部格的 7 格,TSM 走 sec6k + twse 8 格)。
 *
 * 挂载策略照抄 App.tsx / usePerspectiveNavigation 的 keep-alive:**看过的才建、建了就不卸**,
 * 非活跃的挂 hidden(实例和缩放 / 显隐状态都留着,只是不渲染像素)。
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
            <FundChart dim={`fundamentals:${t.id}`} doc={fundamentalDoc(`fundamentals:${t.id}`)} interval={interval} />
          </div>
        ))}
      </div>
    </div>
  );
}
