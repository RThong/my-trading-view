// 报警规则(ROADMAP L3-1):全项目只有这一份「什么数值算越线」。
// 固定面板的分位背景带 / 参考线由它生成(web/views/chartDoc/ruleMarks),以后 L4 每日扫描 / 推送也读它 ——
// 规则不再只活在前端画图配置里。状态怎么算见 shared/calc/ruleState(截到当天、不看未来、带滞后带)。
//
// 一条规则 = 输入(哪条线,可带 A − B / A ÷ B)+ 切点 + 每个区间的含义:
// - percentile:按自身历史分位切,P5 / P95(PCTL_LO / PCTL_HI,画图的 web/chart/percentileMarks 也用这两个);
//   riskTail = 哪一端是风险(染红),另一端染绿;不给 = 方向不定,只画 P5 / P95 线
// - levels:绝对值切点(有确定含义的线:常态带、警戒线),画成参考线
// 两者都给时(季节 z 库存):线用 levels,背景与扫描按分位 —— 和改造前的画法一致。
// 以后要更复杂的(变化率、上穿、多条件、阶梯)按 ROADMAP 再加字段 / 类型;输出统一是「某天在哪个区间」。
import type { SeriesKey } from './regimeSeries';

/** 分位规则的两个切点(分位点数):画图的 P5 / P95 线与扫描的切点都用这一份 */
export const PCTL_LO = 5;
export const PCTL_HI = 95;

export type RuleLevel = { price: number; title: string; color?: string };

export type AlertRule = {
  id: string;
  /** 改切点 / 含义就 +1:存档里的状态按版本区分,改规则后新旧不混 */
  version: number;
  /** 规则名:写清哪端是风险、为什么(扫描 / 推送里显示) */
  name: string;
  /** 在哪个固定面板(pages/regimeDims 的 REGIME_DOCS 键),今日变化条点进去跳这里 */
  at: string;
  // 输入序列限定为 /api/regime 的键:扫描在服务端按键取数,拼错编译期就报
  input: { series: SeriesKey; calc?: { op: '-' | '/'; series: SeriesKey } };
  percentile?: { riskTail?: 'low' | 'high'; since?: string };
  levels?: RuleLevel[];
  /**
   * 滞后带:从越线区间回到「常态」要越过切点多少才算(防贴线来回切换)。
   * 分位规则按分位点数(默认 5:P5 进、P10 才出);levels 规则按原单位(默认 0,各条见下)。
   * 2026-11-17 用全量库校准:全段历史按不同宽度逐日重放,数「回到常态 5 个点内又反弹回去」的来回抖;
   * 分位默认 5 合适(再宽非常态天数涨 30~50%),levels 里偏窄的几条加宽到约一个单点波动
   */
  exitPad?: number;
  /** 常态区间的下标(区间从低到高编号 0..切点数);默认:两个切点 = 1(中间),其余 = 0(最低那段) */
  neutral?: number;
  /**
   * 连续几天落在新区间才算切换(默认 1 = 当天就切)。2026-11-17 校准:加宽滞后带后仍来回抖 ≥7 次的
   * (认沽认购比、VIX 期货持仓、零售加价、出口季节 z 等本身跳得厉害)设 2 —— 抖动降到 0~5 次、
   * 非常态天数不增反减(只冒一个点就回去的假越线被滤掉),代价是进入晚一个点(日频 1 天、周频 1 周)
   */
  confirmDays?: number;
};

/** 常态带:两条「常态下限 / 上限」虚线(超出即非常态,高低哪端是风险看图说明) */
export function normalBand(lo: number, hi: number): RuleLevel[] {
  return [
    { price: lo, title: '常态下限' },
    { price: hi, title: '常态上限' },
  ];
}

function pctl<const Id extends string>(
  id: Id,
  at: string,
  name: string,
  input: AlertRule['input'],
  riskTail?: 'low' | 'high',
  { since, ...extra }: Partial<Omit<AlertRule, 'id'>> & { since?: string } = {},
): AlertRule & { id: Id } {
  return {
    id,
    version: 1,
    name,
    at,
    input,
    percentile: { ...(riskTail && { riskTail }), ...(since && { since }) },
    ...extra,
  };
}

function lvl<const Id extends string>(
  id: Id,
  at: string,
  name: string,
  input: AlertRule['input'],
  levels: RuleLevel[],
  exitPad: number,
  extra: Partial<Omit<AlertRule, 'id'>> = {},
): AlertRule & { id: Id } {
  return { id, version: 1, name, at, input, levels, exitPad, ...extra };
}

function one(series: SeriesKey): AlertRule['input'] {
  return { series };
}

function minus(series: SeriesKey, other: SeriesKey): AlertRule['input'] {
  return { series, calc: { op: '-', series: other } };
}

function ratio(series: SeriesKey, other: SeriesKey): AlertRule['input'] {
  return { series, calc: { op: '/', series: other } };
}

// 不标 `: AlertRule[]`(会把 id 拓宽成 string):用 satisfies 校验形状、保留每条的字面量 id,推出 AlertRuleId
export const ALERT_RULES = [
  // 情绪 · 波动率:波动率低 = 压扁 = 自满(逆向,恐慌飙高反而是机会)
  pctl('vix', 'vol', 'VIX 分位(低 = 压扁 / 自满)', one('vix'), 'low'),
  pctl('vxn', 'vol', 'VXN 纳指波动率分位(低 = 自满)', one('vxn'), 'low'),
  pctl('vixeq', 'vol', '成分股波动率 VIXEQ 分位(低 = 自满)', one('vixeq'), 'low'),
  pctl('vix6m', 'vol', 'VIX6M 分位(低 = 自满)', one('vix6m'), 'low'),
  pctl('skew', 'vol', 'SKEW 分位(高 = 尾部保护被抢贵)', one('skew'), 'high', {
    version: 2,
    confirmDays: 2,
    // 序列 1990 起,但 2010 前整体低一截,分位仍按 2018 起算,保持报警口径不变
    since: '2018-01-01',
  }),
  pctl('vixCotLm', 'vol', 'VIX 期货杠杆资金净持仓分位(极端净空 = 卖波动拥挤)', one('vixCotLm'), 'low', {
    version: 2,
    confirmDays: 2,
  }),
  pctl('vixCotAm', 'vol', 'VIX 期货资管净持仓分位(方向不定)', one('vixCotAm'), undefined, {
    version: 2,
    confirmDays: 2,
  }),
  // 情绪
  pctl('fng', 'sentiment', 'CNN Fear & Greed 分位(高 = 贪婪)', one('fng'), 'high'),
  pctl('cor1m', 'sentiment', '隐含相关性 COR1M 分位(低 = 压扁)', one('cor1m'), 'low', { version: 2, confirmDays: 2 }),
  pctl('cor3m', 'sentiment', '隐含相关性 COR3M 分位(低 = 压扁)', one('cor3m'), 'low'),
  pctl('rxmSpx', 'sentiment', 'RXM/SPX 风险逆转相对表现分位(方向不定)', ratio('rxm', 'spx')),
  pctl('pcEquity', 'sentiment', '个股认沽认购比分位(低 = 看涨拥挤)', one('pcEquity'), 'low', {
    version: 2,
    confirmDays: 2,
  }),
  pctl('pcIndex', 'sentiment', '指数认沽认购比分位(方向不定)', one('pcIndex'), undefined, {
    version: 2,
    confirmDays: 2,
  }),
  // 日本
  lvl(
    'usdjpyRv21',
    'jpy',
    'USD/JPY 1 个月已实现波动率(低于 10 分位 4.4 / 高于 90 分位 12.3)',
    one('usdjpyRv21'),
    [
      { price: 4.4, title: '已实现 10 分位 4.4', color: '#22c55e' },
      { price: 12.3, title: '已实现 90 分位 12.3', color: '#ef4444' },
    ],
    0.6,
    { version: 2 },
  ),
  pctl('jgb10y', 'jgbVol', 'JGB 10Y 收益率分位(方向不定)', one('jgb10y')),
  pctl('jgbVix', 'jgbVol', 'JGB VIX 日债波动率分位(低 = 压扁)', one('jgbVix'), 'low', { version: 2, confirmDays: 2 }),
  // 利率
  pctl('dgs10', 'ratesVol', '美债 10Y 收益率分位(方向不定)', one('dgs10')),
  pctl('move', 'ratesVol', 'MOVE 债市波动率分位(低 = 压扁)', one('move'), 'low', { version: 2, confirmDays: 2 }),
  pctl('t5yifr', 'ratesDecomp', '5y5y 通胀远期分位(高 = 通胀预期上移)', one('t5yifr'), 'high'),
  // 通胀
  pctl('wages', 'inflSource', '薪资增速分位(高 = 工资通胀压力)', one('wages'), 'high'),
  pctl('stickyCpi', 'inflSource', 'Sticky CPI 分位(高 = 服务通胀黏)', one('stickyCpi'), 'high'),
  pctl('rbobYoy', 'inflSource', 'RBOB 汽油同比分位(高 = 能源通胀)', one('rbobYoy'), 'high'),
  // 能源
  lvl('brentWti', 'oil', 'Brent − WTI 常态带 1.5 ~ 10 $/桶', minus('brent', 'wti'), normalBand(1.5, 10), 0.9, {
    version: 2,
  }),
  pctl('dieselCrack', 'oil', '柴油裂解分位(高 = 馏分油紧)', one('dieselCrack'), 'high'),
  pctl('rbobCrack', 'oil', '汽油裂解分位(不设风险端:P95 以上九成落在 5~8 月,是季节不是风险)', one('rbobCrack')),
  pctl('crack321', 'oil', '3-2-1 裂解分位(高 = 成品油紧)', one('crack321'), 'high', { version: 2, confirmDays: 2 }),
  lvl('refUtil', 'refinery', '炼厂开工率常态带 85 ~ 97%', one('refUtil'), normalBand(85, 97), 1),
  lvl('refUtilZ5y', 'refinery', '炼厂开工率季节 z 常态带 ±2', one('refUtilZ5y'), normalBand(-2, 2), 0.25),
  lvl('distYield', 'refinery', '馏分油收率常态带 28 ~ 32%', one('distYield'), normalBand(28, 32), 0.8, {
    version: 2,
  }),
  pctl('distStocksZ5y', 'refinery', '馏分油库存季节 z 分位(低 = 库存紧)', one('distStocksZ5y'), 'low', {
    levels: normalBand(-2, 2),
  }),
  pctl('gasStocksZ5y', 'refinery', '汽油库存季节 z 分位(低 = 库存紧)', one('gasStocksZ5y'), 'low', {
    levels: normalBand(-2, 2),
  }),
  lvl('distExportsZ5y', 'refinery', '馏分油出口季节 z 常态带 ±2', one('distExportsZ5y'), normalBand(-2, 2), 0.25, {
    version: 2,
    confirmDays: 2,
  }),
  pctl('dieselMarkup', 'pump', '柴油零售加价分位(高 = 零售端挤压)', minus('dieselRetail', 'ulsd'), 'high', {
    version: 2,
    confirmDays: 2,
  }),
  pctl('gasMarkup', 'pump', '汽油零售加价分位(方向不定)', minus('gasRetail', 'rbob'), undefined, {
    version: 2,
    confirmDays: 2,
  }),
  // BTC
  lvl('btcSharpe1y', 'btc', 'BTC 1Y 滚动夏普常态带 −2 ~ 2.9', one('btcSharpe1y'), normalBand(-2, 2.9), 0.2),
  lvl(
    'btcSupplyDensity',
    'btcOnchain',
    'BTC 供应密度(13% 警戒 / 15% 高风险)',
    one('btcSupplyDensity'),
    [
      { price: 13, title: '警戒 13%', color: '#ec4899' },
      { price: 15, title: '高风险 15%', color: '#a855f7' },
    ],
    0.5,
    { neutral: 0 },
  ),
  lvl(
    'btcAviv',
    'btcOnchain',
    'BTC AVIV(0.8 以下低估 / 1.9 以上近两轮顶)',
    one('btcAviv'),
    [
      { price: 0.8, title: '低估 0.8', color: '#22c55e' },
      { price: 1.9, title: '近两轮顶 1.9', color: '#ef4444' },
    ],
    0.05,
    { version: 2, confirmDays: 2 },
  ),
  // 估值
  pctl('cape', 'valuation', '席勒 CAPE 分位(2000 年起;高 = 贵)', one('cape'), 'high', { since: '2000-01-01' }),
  // 特色指标 · 集中度
  pctl('vixeqVix', 'concentration', 'VIXEQ / VIX 隐含集中度分位(高 = 集中)', ratio('vixeq', 'vixSpot'), 'high', {
    version: 2,
    confirmDays: 2,
  }),
  lvl(
    'eqwDdSpread',
    'concentration',
    '等权回撤 − 加权回撤(4pp 临界)',
    one('eqwDdSpread'),
    [{ price: 4, title: '临界 4', color: '#ef4444' }],
    0.5,
  ),
] satisfies AlertRule[];

/** 规则 id 的字面量联合:图层里 `ruleMarks('vix')` 拼错了编译期就报 */
export type AlertRuleId = (typeof ALERT_RULES)[number]['id'];

export function alertRule(id: AlertRuleId): AlertRule {
  const rule = ALERT_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`没有这条报警规则:${id}`);

  return rule;
}
