// 「信用」视角各 regime tab 的 pane 配置(合进 pages/regimeDims 的 REGIME_DIMS)。
import type { RegimeDims } from '../../views/regime/regimeChart.hooks';

export const CREDIT_DIMS = {
  credit: {
    panes: [
      {
        key: 'hyOas',
        label: '信用利差',
        title: 'HY 信用利差',
        color: '#f59e0b',
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
} satisfies RegimeDims;
