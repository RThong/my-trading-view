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

export function IndustryChainPanel({ interval }: { interval: Interval }) {
  const [ticker, setTicker] = useState(COMPANY_TABS[0]!.id);

  return (
    <div className="flex h-full flex-col">
      <TabBar tabs={COMPANY_TABS} active={ticker} onChange={setTicker} />
      <div className="min-h-0 flex-1">
        <RegimeChart dim={`fundamentals:${ticker}`} interval={interval} />
      </div>
    </div>
  );
}
