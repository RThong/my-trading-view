// 「估值」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';
import { RESONANCE } from '../../views/regime/descSnippets';

export const VALUATION_DOCS = {
  // 估值:席勒 CAPE(PE10)。高=贵=未来回报低=风险(红);低=便宜=机会(绿)。
  valuation: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'cape',
            scale: 'right',
            color: '#eab308',
            title: '席勒 CAPE (PE10 周期调整市盈率)',
            // 图看 1990+(含互联网泡沫),但 CAPE 结构性抬升,分位只用 2000+ 才有说服力。
            percentile: { riskTail: 'high', since: '2000-01-01' },
          },
        ],
        desc: [
          '定义:席勒 CAPE(周期调整市盈率 PE10)。股市长期估值,对象是整体大盘、不适合套个股。',
          '高 = 贵 = 未来 10 年回报低(风险端,红);低 = 便宜。约 40X = 系统性预警值。',
          '与 10Y 联动:预警区估值 + 杠杆集中的市场,承受不起 10Y 冲上 5%。',
          '',
          '⚠️ 40X 不是恒定阈值 —— 中枢随无风险利率与会计口径结构性抬升,利率环境变了要重定。',
          '(分位只用 2000+ 算,长历史比不公平。)',
          '⚠️ 单看高估值只值得关注。' + RESONANCE,
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
