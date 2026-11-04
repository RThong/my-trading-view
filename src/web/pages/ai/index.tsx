import { historyTab, regimeTab, type Perspective } from '../tabs';
import { IndustryChainPanel } from './IndustryChainPanel';

export const AI: Perspective = {
  id: 'ai',
  label: 'AI',
  // AI 相关指标全收在这一个竖 tab 里(不再单独开「基本面」)。前三个横 tab 是跨公司的汇总/宏观信号
  // (算力价格、买方合计判据线、AI CDS);「产业链」单独一个横 tab,里面是各家公司的财务明细
  // (一家一格,格子由那家的 source 决定,见 aiChain 的 SOURCE_KINDS)—— 十几家挤进主 tab 条太乱,
  // 收进 IndustryChainPanel 自己的内部公司选择器(见该文件,按 GROUP_ORDER 分组)。
  tabs: [
    regimeTab('gpu_compute', '算力价格', 'compute'),
    regimeTab('buyer', '买方合计', 'fundamentals:buyer'),
    // 曾配 Oracle − Apple 差值格,已撤:实测与 Oracle 本线相关 0.9986(Apple 日波动仅其 1/10、两者日变动相关 0.12),
    // 减掉 Apple 只是把 Oracle 平移约 40bp,剥不出「共同因子」。
    historyTab('ai_cds', 'AI CDS', 'ai_cds'),
    { id: 'industry_chain', label: '产业链', render: (interval) => <IndustryChainPanel interval={interval} /> },
  ],
};
