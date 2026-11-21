// 「踩踏监控」五维度卡片的配置:每行一条 /api/regime 序列 + 名称 / 小数位 / 红线文案。只留付鹏原有的指标。
// 判线阈值在 shared/calc/stampede 的 LEVEL_RULES(只用于卡片标签和维度分,不参与阶段判定)。
import { type Level, LEVEL_RULES, type LevelRule, type RuleKey } from '../../../shared/calc/stampede';

export type { Level };

export type Metric = LevelRule & {
  key: RuleKey;
  label: string;
  digits: number;
  /** 红线(灰色小字) */
  red: string;
  /** 付鹏红线在我们 2018 起历史上的分位,画在分位横条上的细竖线;没有就不画 */
  redPctl?: number;
};
/** title = 分数条上的短名;full / desc = 维度卡卡头(照原页) */
export type Dim = { title: string; full: string; desc: string; metrics: Metric[] };

function metric(key: RuleKey, label: string, digits: number, red: string): Metric {
  return { key, label, digits, red, ...LEVEL_RULES[key] };
}

export const DIMS: Dim[] = [
  {
    title: '离散与相关性',
    full: '离散与相关性',
    desc: '衡量权重股分化与离散交易平仓压力',
    metrics: [
      metric('vixeqVix', 'VIXEQ / VIX 比值', 2, '红线 < 1.85 · 黄 < 2.15(高位断崖回落)'),
      metric('dspx', 'DSPX 官方离散度指数', 1, '红线 < 35 且 VIX > 25 · 黄 < 39(相关性飙升时高位回落)'),
    ],
  },
  {
    title: '波动率',
    full: '波动率与流动性挤兑',
    desc: '监测基准恐慌与对冲工具爆炒红灯',
    metrics: [
      metric('vix', '30 天基准 VIX', 2, '红线 ≥ 28 · 黄 ≥ 20(触发 Vanna)'),
      metric('vvix', 'VVIX(波动率的波动率)', 1, '红线 ≥ 115 · 黄 ≥ 100(流动性挤兑)'),
    ],
  },
  {
    title: '期限结构与偏度',
    full: '期限结构与结构性偏度',
    desc: '近远端倒挂斜率与尾部保护成本',
    metrics: [
      metric('vixVix3m', 'VIX / VIX3M(近远端倒挂比率)', 3, '红线 > 1.00 · 黄 ≥ 0.95(Backwardation)'),
      metric('vix9dVix', 'VIX9D / VIX(短端爆发斜率)', 3, '红线 > 1.00 · 黄 ≥ 0.95(超短端反超)'),
      metric('skew', 'CBOE SKEW 偏度指数', 1, '警戒区 160~170;见顶回落切入去杠杆(红 = VIX ≥ 25 时 < 150)'),
    ],
  },
  {
    title: '期权流量',
    full: '期权流量(CBOE Put/Call)',
    desc: '追踪防御需求从个股向全市场扩散',
    metrics: [
      metric('pcEquity', '个股 P/C(灰线)', 2, '红线 ≥ 0.80 · 黄 ≥ 0.68(2022 式个股去杠杆)'),
      metric('pcTotal', '全市场综合 P/C(橙线)', 2, '红线 ≥ 1.25 · 黄 ≥ 1.00(全市场扩散)'),
      metric('pcIndex', '指数 P/C(蓝线)', 2, '红线 ≥ 1.25 站稳 · 黄 ≥ 1.12(宏观全面防御)'),
    ],
  },
  {
    title: '做市商',
    full: '做市商敞口(Hedging Flow)',
    desc: '监控 Gamma Flip 翻转与机械抛压极值(Squeezemetrics GEX,按自身分位读)',
    metrics: [
      metric('gex', 'SPX GEX 敞口(亿美元 / SPX 每点)', 1, '零轴翻转;口径与原页不同,按分位 ≤ 5 记红 · ≤ 20 记黄'),
    ],
  },
];
