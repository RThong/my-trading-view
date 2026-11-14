/**
 * `/api/regime` 每条对外序列的**显示元信息**(名称、类别、频率、单位、别名)。前后端共用。
 *
 * 与 `regimeSeries.ts` 分工:那边只管名字(拼错即编译错误),这里管「怎么给人看」;
 * 数据从哪来、要不要落库仍在 `AGENTS.md` 的取数总览表里,不进这张表。
 *
 * 类型是 `Record<RegimeSeries, …>`:后端加一个名字却没在这里登记 = 编译错误。
 * 图表编辑器的序列名单由这张表生成(见 web/views/chartDoc/registry.ts),登记完就能搜到。
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
  /** 事件日期(发布日、决议日):能解析(ChartDoc 里写 render: events 画竖线),但不进编辑器下拉 —— 事件不该由用户从搜索里拼。须同时 chartable: false */
  events?: true;
  /** 不进编辑器下拉(id 照常能解析):与另一条同值、只是取法不同的腿,下拉里只该有一条 */
  hidden?: true;
};

function daily(category: SeriesCategory, label: string, unit?: string, aliases?: string[]): SeriesMeta {
  return {
    label,
    category,
    freq: '日',
    ...(unit && { unit }),
    ...(aliases && { aliases }),
  };
}

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
  coreCpiRelease: { label: '核心 CPI 发布日', category: '通胀·宏观', freq: '不定', chartable: false, events: true },
  corePceRelease: { label: '核心 PCE 发布日', category: '通胀·宏观', freq: '不定', chartable: false, events: true },
  ismMfg: { label: 'ISM 制造业 PMI', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },
  ismSvc: { label: 'ISM 服务业 PMI', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },
  ismMfgPrices: { label: 'ISM 制造业 Prices', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },
  ismSvcPrices: { label: 'ISM 服务业 Prices', category: '通胀·宏观', freq: '月', aliases: ['pmi', 'ism'] },

  // ── 情绪·持仓
  fng: daily('情绪·持仓', 'CNN Fear & Greed', undefined, ['恐慌', '贪婪']),
  rxmSpx: daily('情绪·持仓', 'RXM/SPX 风险逆转相对表现'),
  pcEquity: daily('情绪·持仓', 'Cboe 个股认沽认购比', undefined, ['put/call', 'pcr', 'cpce', '散户']),
  pcIndex: daily('情绪·持仓', 'Cboe 指数认沽认购比', undefined, ['put/call', 'pcr', 'cpci', '对冲']),
  pcTotal: daily('情绪·持仓', 'Cboe 全部认沽认购比', undefined, ['put/call', 'pcr']),
  pcEquityMa5: daily('情绪·持仓', 'Cboe 个股认沽认购比 5 日均线', undefined, ['put/call', 'pcr']),
  pcEquityMa20: daily('情绪·持仓', 'Cboe 个股认沽认购比 20 日均线', undefined, ['put/call', 'pcr']),
  pcEquityMa63: daily('情绪·持仓', 'Cboe 个股认沽认购比 3 个月均线', undefined, ['put/call', 'pcr']),
  pcIndexMa5: daily('情绪·持仓', 'Cboe 指数认沽认购比 5 日均线', undefined, ['put/call', 'pcr']),
  pcIndexMa20: daily('情绪·持仓', 'Cboe 指数认沽认购比 20 日均线', undefined, ['put/call', 'pcr']),
  pcIndexMa63: daily('情绪·持仓', 'Cboe 指数认沽认购比 3 个月均线', undefined, ['put/call', 'pcr']),
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
  distDemandYoy: {
    label: '馏分油表观需求同比 (4 周均)',
    category: '能源',
    freq: '周',
    unit: '%',
    aliases: ['eia', '柴油', 'product supplied'],
  },
  gasDemandYoy: {
    label: '汽油表观需求同比 (4 周均)',
    category: '能源',
    freq: '周',
    unit: '%',
    aliases: ['eia', 'product supplied'],
  },
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
  bojHikeDates: { label: '日银加息决定日', category: '日本', freq: '不定', chartable: false, events: true },
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

  // ── 派生量的原始腿(前端 calc 现算差 / 比值用;以前只在服务端内部用)
  iorb: { ...daily('利率', 'IORB 准备金利率', '%', ['联储', 'fed']), weekends: true },
  vix3m: daily('波动率', 'VIX3M 3 个月隐含波动率'),
  // 与 vix 同值(都是 CBOE 收盘),但现拉、当天就有;给与现拉腿内连接的计算格用,下拉里只留 vix
  vixSpot: { ...daily('波动率', 'VIX(CBOE 现拉)'), hidden: true },
  rxm: daily('情绪·持仓', 'RXM 风险逆转指数', undefined, ['风险逆转']),
  spx: daily('资产', '标普 500', undefined, ['spx', 's&p', 'gspc']),
  spxew: daily('资产', '标普 500 等权', undefined, ['等权', 'rsp']),
  wti: daily('能源', 'WTI 原油期货', '$/桶', ['原油', 'oil', 'cl']),
  brent: daily('能源', 'Brent 原油期货', '$/桶', ['原油', 'oil', 'bz']),
  rbob: daily('能源', 'RBOB 汽油期货', '$/gal', ['汽油']),
  // 期货连续合约换月错配(见 shared/calc/oilRoll):1 = 这天两腿合约月份对不上,差出来的是近两月价差。
  // 0 / 1 标记,只配裂解 / Brent−WTI 那几格当背景色带(ChartDoc 写 render: background),单独加没意义 → 不进下拉
  oilRollCrack: { ...daily('能源', '裂解错月日(产品腿与 WTI 合约月不同)'), hidden: true },
  oilRollBrentWti: { ...daily('能源', 'Brent−WTI 错月日(两腿合约月不同)'), hidden: true },
};

/**
 * 服务端算出来的派生量(不是数据源直接给的数),值 = 能不能用 ChartDoc 的 calc 现算:
 *  · 'calc'   = 就是两条原始序列的差 / 比值 → 不进编辑器下拉(要看就在编辑器里用 calc 拼),固定面板也改成 calc 现算
 *  · 'server' = calc 表达不了(多项相加、乘常数、同比、z、均线、锚在第三条序列日期上…)→ 暂留下拉、名称标「派生」
 * 两种都照常由 /api/regime 发出:知识库的 skill 还在读接口,也留着给前端现算结果对账。
 */
export const DERIVED: Partial<Record<RegimeSeries, 'calc' | 'server'>> = {
  // ── calc:A − B / A ÷ B
  vixeqVix: 'calc', // vixeq ÷ vixSpot(现拉 VIX,不等 daily job)
  corTermSpread: 'calc', // cor3m − cor1m
  vxTermSpread: 'calc', // VX1 − VX3(注册表的 db:VX1 / db:VX3)
  vixSpotTerm: 'calc', // vixSpot − vix3m
  rxmSpx: 'calc', // rxm ÷ spx
  repoStress: 'calc', // iorb − sofr
  spxEqw: 'calc', // spx ÷ spxew
  brentWti: 'calc', // brent − wti
  dieselRetailMargin: 'calc', // dieselRetail − ulsd(锚在周一零售)
  gasRetailMargin: 'calc', // gasRetail − rbob
  usjp2y: 'calc', // 美债 2Y − 日债 2Y(注册表的曲线腿;两国假日错开时沿用旧值,calc 带 fill)
  // ── server:calc 表达不了
  netLiquidity: 'server', // WALCL − TGA − RRP,只取周三
  // 认沽认购比均线(编辑器的指标只有 EMA;以后有变换图层的简单均线再改 calc)
  pcEquityMa5: 'server',
  pcEquityMa20: 'server',
  pcEquityMa63: 'server',
  pcIndexMa5: 'server',
  pcIndexMa20: 'server',
  pcIndexMa63: 'server',
  reserves: 'server', // 源是百万美元,÷1000 换成十亿美元(乘常数)
  dieselCrack: 'server', // ULSD × 42 − WTI
  rbobCrack: 'server', // RBOB × 42 − WTI
  crack321: 'server', // (2 × RBOB + ULSD) × 42 / 3 − WTI
  distYield: 'server', // 馏分油产量 ÷ 加工量 × 100
  crudeRunsYoy: 'server', // 同比
  distProdYoy: 'server',
  distDemandYoy: 'server', // 4 周滚动均值后取同比
  gasDemandYoy: 'server',
  rbobYoy: 'server',
  coreCpiYoy: 'server', // 由 CPI 指数算同比 / 3 个月年化
  coreCpi3m: 'server',
  corePceYoy: 'server',
  corePce3m: 'server',
  jpCgpiYoy: 'server',
  refUtilZ5y: 'server', // 季节 z
  distStocksZ5y: 'server',
  gasStocksZ5y: 'server',
  distExportsZ5y: 'server',
  eqwDdSpread: 'server', // 两条各算 252 日回撤再相减
  btcSharpe1y: 'server', // 滚动一年夏普
  btcSupplyDensity: 'server', // 7 日均线
  jpCallRate: 'server', // 日频拆借利率求月均
  jpDepositBeta: 'server', // 累计变动之比
  jpDepositDelta: 'server',
  jpCallDelta60: 'server',
  jpLoanDepositSpread: 'server', // 日本银行利差四条:锚在 JGB 2Y 的日期上、月频腿前向填充
  jp2yMinusDeposit: 'server',
  jpCallMinusDeposit: 'server',
  jp2yMinusCall: 'server',
  oisHikes3m: 'server', // 由 OIS 曲线推算
  oisHikes6m: 'server',
  oisHikes12m: 'server',
  oisHikes2y: 'server',
  rstarSepImplied: 'server', // 点阵图长期利率 − 2%
  lProxyHlwT5yifr: 'server', // HLW r* + 5y5y
  expShort10Kw: 'server', // KW 拟合 10Y − 期限溢价(拟合那条没对外发)
  cftcJpy: 'server', // 多头 − 空头
  vixCotAm: 'server', // 净持仓占未平仓 %
  vixCotLm: 'server',
};
