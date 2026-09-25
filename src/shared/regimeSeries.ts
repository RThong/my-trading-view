/**
 * `/api/regime` 对外序列名的**唯一真源**。前后端共用。
 *
 * 为什么要有这个文件:这些名字原先只是散在 `routes/regime.ts` 函数体里的字符串字面量
 * (一半以上是 `put('xxx', …)` 的派生名,不在任何表里),而前端 `PaneSpec.key` 是裸 `string`。
 * 两边靠约定对齐 —— **拼错不会报错,只会让那一格永远 unavailable**,得有人打开面板才看得见。
 *
 * 收成联合类型后:后端 `put()` 只收这里的名字、前端 pane key 也只收这里的名字,
 * 任何一侧拼错都是编译错误。加新序列 = 这里加一行,两端同时生效。
 *
 * ⚠️ 这里只管**名字**,不管数据从哪来、什么频率、要不要落库 —— 那些在
 * `AGENTS.md` 的取数总览表里。别把这个文件长成数据源注册表。
 */

/** 基本面序列是按启用名单派生的动态键(`fund:NVDA:fcf` / `fund:buyerFcf`),不进枚举。 */
export const FUND_KEY_PREFIX = 'fund:';
export type FundSeries = `${typeof FUND_KEY_PREFIX}${string}`;

export const REGIME_SERIES = [
  // ── 直接透传的 FRED / CBOE / CNN 源(regime.ts 的 `direct` 映射)
  'hyOas',
  'cor1m',
  'vixeq',
  'fng',
  'vix6m',
  'reverseRepo',
  'repoUsage',
  'wages',
  'stickyCpi',
  't5yifr',
  'tp10Kw',

  // ── 库里读(daily job 写)。与 routes/regime.ts 的 JOB_WRITTEN_SERIES 对应
  'vix',
  'vxn',
  'gpuH100',
  'gpuH200',
  'gpuB200',
  'gpuB300',
  // ISM 制造业 / 服务业 PMI 及各自 Prices 分项(月频,PR Newswire 全文解析,daily 增量写库)。
  // 见 fetchers/ismPrn 与 jobs/ismSnapshot。
  'ismMfg',
  'ismSvc',
  'ismMfgPrices',
  'ismSvcPrices',

  // ── 库里读 + 派生(readDbBacked)
  'qqq',
  'btc',
  'btcSharpe1y',
  'vxTermSpread',
  'move',

  // ── 现拉 + 派生(主 handler)
  // ACM 期限溢价(纽约联储,月频)。不在 `direct` 映射里,是主 handler 单独现拉 + catch → null,
  // 给同格的 tp10Kw 当独立对照。见 fetchers/nyfedAcm。
  'tp10Acm',
  'netLiquidity',
  'repoStress',
  'usd',
  'usdjpy',
  'cftcJpy',
  'vixCotAm',
  'vixCotLm',
  'dgs10',
  'usjp2y',
  'jgb10y',
  'jgbVix',
  // 日银产出缺口 / 潜在增速(季度更新,**两条时间轴不同**:缺口是日历季度,潜在增速是财年半期)。
  // 见 fetchers/bojOutputGap —— 尤其「别 join 这两条」与「末尾待发布行」两条。
  'jpOutputGap',
  'jpPotentialGrowth',
  'jpPotTfp',
  'jpPotCapital',
  'jpPotHours',
  'jpPotWorkers',
  // 日本长端分解(中島上智模型,GitHub CSV)。名字带模型名是因为**同名指标会有第二套模型** ——
  // 美债那边 KW 与 ACM 同一天能差 100bp 以上,叫成 jpTp10 就会让两套被误当同一个东西。
  // 期限溢价 / 预期短端日频,r* 季频(带 95% 区间)。见 fetchers/nakajimaJgb。
  'jpTp10Nakajima',
  'jpExpShort10Nakajima',
  'jpRstar10Nakajima',
  'jpRstar10NakajimaLo',
  'jpRstar10NakajimaHi',
  'cape',
  'rxmSpx',
  'vixSpotTerm',
  'brentWti',
  'dieselCrack',
  'rbobCrack',
  'crack321',
  'rbobYoy',
  // ULSD(NYMEX HO)批发价 $/gal。裂解三条一直在拿它当输入腿,这里单独发出来是因为
  // **零售加价(泵价 − 批发)要它当减数** —— 只发零售泵价的话,泵价涨了归因不了是原油、
  // 裂解还是零售端在加价。⚠️ 单位是 $/gal 不是 $/桶(裂解那几条 ×42 换过),别混着读。
  'ulsd',

  // ── EIA 周报(周三 10:30 ET,数据截止上周五)。水位 + 季节 z 见 analytics/seasonalZ。
  'refUtil',
  'refUtilZ5y',
  'distStocksZ5y',
  'gasStocksZ5y',
  'distExportsZ5y',
  'distYield',
  'crudeRunsYoy',
  'distProdYoy',
  // 零售泵价两条 + 各自的零售加价(EIA 周度零售价调查,**周一发**,与上面那批周三的不同天)。
  // 加价 = 泵价 − 同口径批发期货,$/gal。材料里「加油站并没有按同样比例降价」「下调慢于上调」
  // 说的就是这一层 —— 批发价与裂解都在批发口径,看不见它。
  // ⚠️ 加价里含联邦 + 州燃油税(柴油约 $0.55/gal、汽油约 $0.50/gal,各州不同):
  // **水位不是纯毛利,但税近乎常数,所以变动仍然是加价的变动**。
  // ⚠️ 汽油那条是判别腿:柴油加价走阔时,只有对照汽油才分得清「全行业零售在加价」还是「柴油独有」。
  'dieselRetail',
  'gasRetail',
  'dieselRetailMargin',
  'gasRetailMargin',

  // ── 长端分解(rates-decomposition)
  'expShort10Kw',
  'rstarHlwCurrent',
  'lProxyHlwT5yifr',
  // SEP 口径的 r* = 点阵图长期水平(FEDTARMDLR,名义)− 2%(长期 PCE 目标)。日期 = SEP 发布日,季频。
  'rstarSepImplied',

  // ── 利率预期的三样参照(FRED 现拉)。派生算法见 shared/policyPath。
  // SOFR 定盘值(FRED,日频 %,次日早上发)。OIS 加息次数的基准 —— 不是 Eris 的 SOFR1D(那是 T+2 起息的掉期)。
  'sofr',
  // 政策利率目标区间上 / 下限(DFEDTARU / DFEDTARL,日频 %)
  'fedTargetUpper',
  'fedTargetLower',
  // SEP 点阵图中值:⚠️ 日期 = **预测的那一年年底**(YYYY-12-31),不是发布日;FRED 只留最新一版 SEP。
  'sepMedian',
  // 点阵图长期水平(FEDTARMDLR):日期 = SEP 发布日,季频,自带历史。
  'sepMedianLr',
  // 核心 CPI / 核心 PCE 的同比与 3 个月年化(%)。⚠️ 日期 = **数据所属月份**,不是发布日。
  'coreCpiYoy',
  'coreCpi3m',
  'corePceYoy',
  'corePce3m',
  // 例行发布日(ALFRED 首发 vintage,已天然排除季调 / 年度修订那类 vintage)。
  // 日期 = 发布日;值 = 该次发布那个月的**当前修订后**同比(不是首发值)。给日线断点对齐用。
  'coreCpiRelease',
  'corePceRelease',

  // ── 库里读 + 派生:SOFR OIS 隐含的「到 N 为止累计计入几次 25bp」(次,负 = 降息)。近似值,见 shared/policyPath。
  'oisHikes3m',
  'oisHikes6m',
  'oisHikes12m',
  'oisHikes2y',
] as const;

export type RegimeSeries = (typeof REGIME_SERIES)[number];

/** 面板 pane / 后端 put 能用的键:枚举名,或基本面那类动态键。 */
export type SeriesKey = RegimeSeries | FundSeries;

const ENUMERATED: ReadonlySet<string> = new Set(REGIME_SERIES);

/** 运行时校验(给测试与动态来源用;类型收窄不了的地方靠它)。 */
export const isSeriesKey = (k: string): k is SeriesKey => ENUMERATED.has(k) || k.startsWith(FUND_KEY_PREFIX);
