/**
 * `/api/regime` 每条对外序列的**显示元信息**(名称、类别、频率、单位、别名)。前后端共用。
 *
 * 与 `regimeSeries.ts` 分工:那边只管名字(拼错即编译错误),这里管「怎么给人看」;
 * 数据从哪来、要不要落库仍在 `AGENTS.md` 的取数总览表里,不进这张表。
 *
 * 类型是 `Record<RegimeSeries, …>`:后端加一个名字却没在这里登记 = 编译错误。
 * 图表编辑器的序列名单由这张表生成(见 web/panels/chartEditor/registry.ts),登记完就能搜到。
 * `freq` 以后也给按序列频率判过期(ROADMAP L0-1)用。
 */
import type { RegimeSeries } from './regimeSeries';

export type SeriesCategory =
  | '资产'
  | '波动率'
  | '利率'
  | '信用·流动性'
  | '通胀·宏观'
  | '情绪·持仓'
  | '估值·结构'
  | '能源'
  | '日本'
  | '加密'
  | 'AI 链';

/** 下拉里的分组顺序 */
export const CATEGORIES: SeriesCategory[] = [
  '资产',
  '波动率',
  '利率',
  '信用·流动性',
  '通胀·宏观',
  '情绪·持仓',
  '估值·结构',
  '能源',
  '日本',
  '加密',
  'AI 链',
];

/** 数据的发布节奏(不是点的间隔:月频序列的日期是所属月份 1 日)。「不定」= 事件日期。 */
export type SeriesFreq = '日' | '周' | '月' | '季' | '半年' | '年' | '不定';

export type SeriesMeta = {
  label: string;
  category: SeriesCategory;
  freq: SeriesFreq;
  unit?: string;
  /** 搜索用的别名 */
  aliases?: string[];
  /**
   * 日频序列带周末点(7×24 资产、按日历日前向填充的序列)。编辑器取数时只留周一~周五。
   * ⚠️ 月 / 季频别标:它们的日期是月初 / 季末,落在周末会被整月滤掉。
   */
  weekends?: true;
  /** 不能当一条线画:事件日期(值无意义)或日期不是观测日(点阵图的日期是预测年份)。 */
  chartable?: false;
};

const daily = (category: SeriesCategory, label: string, unit?: string, aliases?: string[]): SeriesMeta => ({
  label,
  category,
  freq: '日',
  ...(unit && { unit }),
  ...(aliases && { aliases }),
});

export const SERIES_META: Record<RegimeSeries, SeriesMeta> = {
  // ── 资产
  qqq: daily('资产', 'QQQ 纳指 100', '$', ['纳指', 'nasdaq']),
  usd: daily('资产', '美元指数 DXY', undefined, ['dxy', '美元']),
  usdjpy: { ...daily('资产', 'USD/JPY', undefined, ['日元', 'yen']), weekends: true },

  // ── 波动率
  vix: daily('波动率', 'VIX', undefined, ['恐慌']),
  vxn: daily('波动率', 'VXN 纳指波动率', undefined, ['纳指波动率']),
  move: daily('波动率', 'MOVE 债市波动率', undefined, ['债市波动率']),
  skew: daily('波动率', 'SKEW 标普尾部偏度', undefined, ['尾部']),
  vix6m: daily('波动率', 'VIX6M 6 个月隐含波动率'),
  vixeq: daily('波动率', 'VIXEQ 成分股波动率'),
  cor1m: daily('波动率', 'COR1M 隐含相关性', undefined, ['相关性']),
  cor3m: daily('波动率', 'COR3M 隐含相关性', undefined, ['相关性']),
  corTermSpread: daily('波动率', '隐含相关性期限结构 COR3M − COR1M', 'pp', ['相关性']),
  vxTermSpread: daily('波动率', 'VX1 − VX3 期货期限结构', undefined, ['期限结构']),
  vixSpotTerm: daily('波动率', 'VIX − VIX3M 即期期限结构', undefined, ['期限结构']),

  // ── 利率
  dgs10: daily('利率', '美债 10Y', '%', ['us10y', '国债']),
  usjp2y: daily('利率', '美日 2Y 利差', '%', ['利差']),
  tp10Kw: daily('利率', '10Y 期限溢价 (KW)', '%', ['term premium']),
  tp10Acm: { label: '10Y 期限溢价 (ACM)', category: '利率', freq: '月', unit: '%', aliases: ['term premium'] },
  expShort10Kw: daily('利率', '10Y 预期短端均值 (KW)', '%'),
  rstarHlwCurrent: { label: '自然利率 r* (HLW)', category: '利率', freq: '季', unit: '%', aliases: ['rstar'] },
  lProxyHlwT5yifr: { label: 'L 代理:HLW r* + 5y5y', category: '利率', freq: '季', unit: '%' },
  rstarSepImplied: {
    label: '联储口径 r*:SEP 长期利率 − 2%',
    category: '利率',
    freq: '季',
    unit: '%',
    aliases: ['rstar'],
  },
  sofr: daily('利率', 'SOFR 定盘', '%'),
  fedTargetUpper: { ...daily('利率', '联邦基金目标区间上限', '%', ['fed', '政策利率']), weekends: true },
  fedTargetLower: { ...daily('利率', '联邦基金目标区间下限', '%', ['fed', '政策利率']), weekends: true },
  sepMedian: { label: 'SEP 点阵图中值', category: '利率', freq: '年', unit: '%', chartable: false },
  sepMedianLr: {
    label: 'SEP 点阵图长期水平',
    category: '利率',
    freq: '季',
    unit: '%',
    aliases: ['点阵图', 'dot plot'],
  },
  oisHikes3m: daily('利率', 'OIS 隐含加息次数 · 3 个月', '次', ['加息', 'ois']),
  oisHikes6m: daily('利率', 'OIS 隐含加息次数 · 6 个月', '次', ['加息', 'ois']),
  oisHikes12m: daily('利率', 'OIS 隐含加息次数 · 12 个月', '次', ['加息', 'ois']),
  oisHikes2y: daily('利率', 'OIS 隐含加息次数 · 2 年', '次', ['加息', 'ois']),

  // ── 信用·流动性
  hyOas: daily('信用·流动性', 'HY OAS 高收益信用利差', '%', ['高收益', '信用利差']),
  netLiquidity: { label: '净流动性', category: '信用·流动性', freq: '周', unit: '$B', aliases: ['liquidity'] },
  reverseRepo: daily('信用·流动性', '逆回购 RRP', '$B', ['rrp']),
  reserves: { label: '准备金', category: '信用·流动性', freq: '周', unit: '$B' },
  repoUsage: daily('信用·流动性', '回购用量 (隔夜正回购)', '$B'),
  repoStress: daily('信用·流动性', '回购压力 IORB − SOFR', '%'),

  // ── 通胀·宏观
  t5yifr: daily('通胀·宏观', '5y5y 通胀远期', '%', ['通胀预期']),
  wages: { label: '薪资增速 (Atlanta Fed)', category: '通胀·宏观', freq: '月', unit: '%', aliases: ['工资'] },
  stickyCpi: { label: 'Sticky CPI', category: '通胀·宏观', freq: '月', unit: '%', aliases: ['cpi', '通胀'] },
  coreCpiYoy: { label: '核心 CPI 同比', category: '通胀·宏观', freq: '月', unit: '%', aliases: ['cpi', '通胀'] },
  coreCpi3m: { label: '核心 CPI 3 个月年化', category: '通胀·宏观', freq: '月', unit: '%', aliases: ['cpi', '通胀'] },
  corePceYoy: { label: '核心 PCE 同比', category: '通胀·宏观', freq: '月', unit: '%', aliases: ['pce', '通胀'] },
  corePce3m: { label: '核心 PCE 3 个月年化', category: '通胀·宏观', freq: '月', unit: '%', aliases: ['pce', '通胀'] },
  coreCpiRelease: { label: '核心 CPI 发布日', category: '通胀·宏观', freq: '不定', chartable: false },
  corePceRelease: { label: '核心 PCE 发布日', category: '通胀·宏观', freq: '不定', chartable: false },
  ismMfg: { label: 'ISM 制造业 PMI', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },
  ismSvc: { label: 'ISM 服务业 PMI', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },
  ismMfgPrices: { label: 'ISM 制造业 Prices', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },
  ismSvcPrices: { label: 'ISM 服务业 Prices', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },

  // ── 情绪·持仓
  fng: daily('情绪·持仓', 'CNN Fear & Greed', undefined, ['恐慌', '贪婪']),
  rxmSpx: daily('情绪·持仓', 'RXM/SPX 风险逆转相对表现'),
  cftcJpy: { label: 'CFTC 日元净持仓', category: '情绪·持仓', freq: '周', unit: '张', aliases: ['cot', '日元'] },
  vixCotAm: {
    label: 'CFTC VIX 净持仓 · Asset Manager',
    category: '情绪·持仓',
    freq: '周',
    unit: '% OI',
    aliases: ['cot'],
  },
  vixCotLm: {
    label: 'CFTC VIX 净持仓 · Leveraged Money',
    category: '情绪·持仓',
    freq: '周',
    unit: '% OI',
    aliases: ['cot'],
  },

  // ── 估值·结构
  cape: { label: '席勒 CAPE', category: '估值·结构', freq: '月', aliases: ['估值', '市盈率', 'pe'] },
  spxEqw: daily('估值·结构', '标普 500 ÷ 等权', undefined, ['集中度']),
  vixeqVix: daily('估值·结构', 'VIXEQ / VIX 隐含集中度', undefined, ['集中度']),
  eqwDdSpread: daily('估值·结构', '等权回撤 − 加权回撤', 'pp', ['宽度']),

  // ── 能源(EIA 周报:周三发、截止上周五;零售泵价周一发)
  brentWti: daily('能源', 'Brent − WTI', '$/桶', ['原油', 'oil']),
  dieselCrack: daily('能源', '柴油裂解', '$/桶', ['crack', 'heating oil']),
  rbobCrack: daily('能源', '汽油裂解', '$/桶', ['crack']),
  crack321: daily('能源', '3-2-1 裂解', '$/桶', ['crack']),
  rbobYoy: daily('能源', 'RBOB 汽油同比', '%'),
  ulsd: daily('能源', 'ULSD 批发 (NYMEX HO)', '$/gal', ['柴油', 'heating oil']),
  refUtil: { label: '炼厂开工率', category: '能源', freq: '周', unit: '%', aliases: ['eia'] },
  refUtilZ5y: { label: '炼厂开工率 · 季节 z', category: '能源', freq: '周', unit: 'z', aliases: ['eia'] },
  distStocksZ5y: { label: '馏分油库存 · 季节 z', category: '能源', freq: '周', unit: 'z', aliases: ['eia', '柴油'] },
  gasStocksZ5y: { label: '汽油库存 · 季节 z', category: '能源', freq: '周', unit: 'z', aliases: ['eia'] },
  distExportsZ5y: { label: '馏分油出口 · 季节 z', category: '能源', freq: '周', unit: 'z', aliases: ['eia', '柴油'] },
  distYield: { label: '馏分油收率', category: '能源', freq: '周', unit: '%', aliases: ['eia', '柴油'] },
  crudeRunsYoy: { label: '炼厂加工量同比', category: '能源', freq: '周', unit: '%', aliases: ['eia'] },
  distProdYoy: { label: '馏分油产量同比', category: '能源', freq: '周', unit: '%', aliases: ['eia', '柴油'] },
  dieselRetail: { label: '零售柴油', category: '能源', freq: '周', unit: '$/gal', aliases: ['eia', '泵价'] },
  gasRetail: { label: '零售汽油', category: '能源', freq: '周', unit: '$/gal', aliases: ['eia', '泵价'] },
  dieselRetailMargin: { label: '柴油零售加价', category: '能源', freq: '周', unit: '$/gal', aliases: ['eia'] },
  gasRetailMargin: { label: '汽油零售加价', category: '能源', freq: '周', unit: '$/gal', aliases: ['eia'] },

  // ── 日本
  jgb2y: daily('日本', '日债 2Y', '%', ['jgb', '日本国债']),
  jgb10y: daily('日本', '日债 10Y', '%', ['jgb', '日本国债']),
  jgbVix: daily('日本', 'JGB VIX 日债波动率', undefined, ['jgb']),
  mufg: daily('日本', '8306.T 三菱 UFJ', '¥', ['银行', 'mufg']),
  jpTp10Nakajima: daily('日本', 'JGB 10Y 期限溢价 (中島)', '%', ['term premium']),
  jpExpShort10Nakajima: daily('日本', 'JGB 10Y 预期短端均值 (中島)', '%'),
  jpRstar10Nakajima: { label: '日本 r* 10Y (中島)', category: '日本', freq: '季', unit: '%', aliases: ['rstar'] },
  jpRstar10NakajimaLo: {
    label: '日本 r* 95% 下限 (中島)',
    category: '日本',
    freq: '季',
    unit: '%',
    aliases: ['rstar'],
  },
  jpRstar10NakajimaHi: {
    label: '日本 r* 95% 上限 (中島)',
    category: '日本',
    freq: '季',
    unit: '%',
    aliases: ['rstar'],
  },
  jpOutputGap: { label: '日本产出缺口 (需給ギャップ)', category: '日本', freq: '季', unit: '%' },
  jpPotentialGrowth: { label: '日本潜在增速', category: '日本', freq: '半年', unit: '%' },
  jpPotTfp: { label: '日本潜在增速贡献 · TFP', category: '日本', freq: '半年', unit: '%' },
  jpPotCapital: { label: '日本潜在增速贡献 · 资本', category: '日本', freq: '半年', unit: '%' },
  jpPotHours: { label: '日本潜在增速贡献 · 劳动时间', category: '日本', freq: '半年', unit: '%' },
  jpPotWorkers: { label: '日本潜在增速贡献 · 就业者', category: '日本', freq: '半年', unit: '%' },
  jpDepositRate: { label: '日本普通存款挂牌利率', category: '日本', freq: '月', unit: '%', aliases: ['银行'] },
  jpLoanRateStock: { label: '日本存量贷款平均利率', category: '日本', freq: '月', unit: '%', aliases: ['银行'] },
  jpCallRate: { label: '日本无担保隔夜拆借 (月均)', category: '日本', freq: '月', unit: '%', aliases: ['银行'] },
  jpDepositBeta: { label: '日本存款贝塔', category: '日本', freq: '月', aliases: ['银行'] },
  jpDepositDelta: { label: 'Δ 存款挂牌利率 (2024-01 起)', category: '日本', freq: '月', unit: '%', aliases: ['银行'] },
  jpCallDelta60: { label: '0.6 × Δ 拆借月均 (2024-01 起)', category: '日本', freq: '月', unit: '%', aliases: ['银行'] },
  jpLoanDepositSpread: { label: '日本存量贷款 − 存款', category: '日本', freq: '月', unit: '%', aliases: ['银行'] },
  jp2yMinusDeposit: daily('日本', 'JGB 2Y − 存款挂牌利率', '%', ['银行']),
  jpCallMinusDeposit: daily('日本', '拆借 − 存款', '%', ['银行']),
  jp2yMinusCall: daily('日本', 'JGB 2Y − 拆借', '%', ['银行']),
  bojHikeDates: { label: '日银加息决定日', category: '日本', freq: '不定', chartable: false },
  jpCgpiYoy: { label: '日本企业物价 CGPI 同比', category: '日本', freq: '月', unit: '%', aliases: ['通胀'] },
  jpCoreCoreCpiYoy: {
    label: '日本新核心核心 CPI 同比',
    category: '日本',
    freq: '月',
    unit: '%',
    aliases: ['通胀', 'cpi'],
  },

  // ── 加密
  // 编辑器里用 ohlc.btc 的收盘(registry 手写那条),这里登记供其它消费方用
  btc: { ...daily('加密', 'BTC', '$', ['比特币', 'bitcoin']), weekends: true },
  btcSharpe1y: { ...daily('加密', 'BTC 1Y 滚动夏普', undefined, ['比特币', 'bitcoin']), weekends: true },
  btcSupplyDensity: { ...daily('加密', 'BTC 供应密度 (7 日均线)', '%', ['比特币', 'bitcoin', 'urpd']), weekends: true },
  btcSupplyDensityRaw: {
    ...daily('加密', 'BTC 供应密度 (原始日值)', '%', ['比特币', 'bitcoin', 'urpd']),
    weekends: true,
  },

  // ── AI 链(Computable GPU 租赁价,按 UTC 日聚合)
  gpuH100: { ...daily('AI 链', 'GPU 租赁价 H100', '$/GPU·时', ['gpu', '算力']), weekends: true },
  gpuH200: { ...daily('AI 链', 'GPU 租赁价 H200', '$/GPU·时', ['gpu', '算力']), weekends: true },
  gpuB200: { ...daily('AI 链', 'GPU 租赁价 B200', '$/GPU·时', ['gpu', '算力']), weekends: true },
  gpuB300: { ...daily('AI 链', 'GPU 租赁价 B300', '$/GPU·时', ['gpu', '算力']), weekends: true },
};
