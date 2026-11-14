// 「信用」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';

export const CREDIT_DOCS = {
  credit: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          { id: 'l1', series: 'hyOas', scale: 'right', color: '#f59e0b', title: 'HY 信用利差' },
          { id: 'l2', series: 'cdxHy', scale: 'right', color: '#a78bfa', title: 'CDX 北美高收益 5Y' },
        ],
        desc: [
          '定义:高收益债 vs 美债利差(OAS)。信用风险 / 融资环境的温度计。',
          '走阔 = 违约担忧升、risk-off,且是「流动性事件升级成信用事件」的确认。',
          '收窄 = 信用宽松、risk-on。',
          '',
          '⚠️ 低 ≠ 安全:集中度极高时利差被按住(借来的平静),只在走阔时才有信息量。',
          '',
          '叠的紫线是 CDX 北美高收益指数(100 家高收益公司的 5Y CDS 篮子)的约定利差 —— 同一件事的衍生品报价。',
          '两条口径不同(CDX 是固定 5Y 篮子、OAS 是全部高收益现券),水位不必相等,看方向和间距的变化。',
          '⚠️ CDX HY 市场按价报(如 106.2),这里按 CDS 定价模型反解成利差(回收率 40%);HY 惯例有说按 30% 的,那样换算会高约 3bp。',
          '⚠️ HY 每年 3/27、9/27 换新系列(比 IG 晚一周;成分换、期限后移半年),换新那天有台阶,不是行情:',
          '2024-09 起实测多为 +3~9bp,2026-03-27 叠上当天行情是 +28bp。',
          '历史:ICE 结算价 2026-11-13 起逐日存,之前约 2 年由 DTCC 公开成交回填(当天全部成交的中位数)。',
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [{ id: 'l3', series: 'cdxIg', scale: 'right', color: '#38bdf8', title: 'CDX 北美投资级 5Y' }],
        desc: [
          '定义:CDX 北美投资级指数(125 家投资级公司的 5Y CDS 篮子)的约定利差,%。',
          '投资级是信用市场的主体,宏观对冲最常用的就是它:走阔 = 机构在买整体信用保护。',
          '和上面的高收益对照读:IG 跟着走阔 = 担忧扩散到优质发行人;只有 HY 走阔 = 风险还局限在弱资质。',
          '',
          '⚠️ 每年 3/20、9/20 换新系列(期限后移半年),换新那天有约 +4~5bp 的台阶(2024-09 起实测),不是行情。',
          '历史:ICE 结算价 2026-11-13 起逐日存,之前约 2 年由 DTCC 公开成交回填(当天全部成交的中位数)。',
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
