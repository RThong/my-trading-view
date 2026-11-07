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
        layers: [{ id: 'l1', series: 'hyOas', scale: 'right', color: '#f59e0b', title: 'HY 信用利差' }],
        desc: [
          '定义:高收益债 vs 美债利差(OAS)。信用风险 / 融资环境的温度计。',
          '走阔 = 违约担忧升、risk-off,且是「流动性事件升级成信用事件」的确认。',
          '收窄 = 信用宽松、risk-on。',
          '',
          '⚠️ 低 ≠ 安全:集中度极高时利差被按住(借来的平静),只在走阔时才有信息量。',
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
