import { regimeTab, type Perspective } from '../tabs';

// 能源三 tab:价差(市场怎么定价)、实物(EIA 周报的开工率 / 库存 / 出口)、泵价(链条末端 + 零售加价)。
// 分开是因为三边频率与读法都不同 —— 价差日频看拐点,实物周三周频 + 季节 z 看因果,
// 泵价周一周频、看的是批发到零售那一段的传导(涨快跌慢)。
export const OIL: Perspective = {
  id: 'oil',
  label: '能源',
  tabs: [
    regimeTab('oil', '油市结构', 'oil'),
    regimeTab('refinery', '炼厂·库存', 'refinery'),
    regimeTab('pump', '泵价·加价', 'pump'),
  ],
};
