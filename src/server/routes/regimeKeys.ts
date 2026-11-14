// /api/regime 的键名清单:哪些序列由本地库提供、OHLC 的形状。纯字面量、零依赖 ——
// 缓存策略(regimePolicy)要按这些键判断,但不该为此把 sqlite / 数据库读写一起加载进来(regimeDb 只管读库)。

// 后端不 import web 的 Bar(跨边界);内联 OHLC 形状,JSON 与前端 chart 的 Bar 一致。
export type OhlcBar = { time: string; open: number; high: number; low: number; close: number };

/**
 * 由**独立 job**写库、因此缓存命中时必须重读的序列(out 键 → market_series 的 symbol)。
 * 这些不像 FRED/CBOE 那样是请求时现拉的:进程内缓存看不到 cryptoDaily 等别的进程刚写进去的行,
 * 不重读的话,job 刚跑完最长还要等 TTL(6h)才在面板上出现。读库很便宜,不值得为它整体失效缓存。
 * GPU 这几条尤其要重读 —— 缓存条件专门放宽了「gpu 前缀缺失也缓存」(库没跑过 job 时四条必然缺、
 * B300 长期允许缺),两个改动合起来会把「GPU 不可用」这个状态缓存住并卡满 6h。
 */
export const JOB_WRITTEN_SERIES = [
  // VIX/VXN 同样是 daily job 写库、同样该重读 —— 它们历史非空,所以症状比 GPU 轻
  // (不是"整格不可用",只是最新一点最长滞后 6h),但性质一模一样,别再漏第二次。
  ['vix', 'VIX'],
  ['vxn', 'VXN'],
  // SKEW 同理(daily 的 vrp_inputs 组写库)。
  ['skew', 'SKEW'],
  ['gpuH100', 'CGI_H100'],
  ['gpuH200', 'CGI_H200'],
  ['gpuB200', 'CGI_B200'],
  ['gpuB300', 'CGI_B300'],
  // ISM 四条(月频,daily 的 ism 分组写库)。**不进 gpu 那种「缺着也缓存」的豁免**:
  // 回填过就恒有,缺了说明库没回填或 job 坏了 —— 那种状态不该被缓存 6 小时。
  ['ismMfg', 'ISM_MFG_PMI'],
  ['ismSvc', 'ISM_SVC_PMI'],
  ['ismMfgPrices', 'ISM_MFG_PRICES'],
  ['ismSvcPrices', 'ISM_SVC_PRICES'],
  // Cboe 认沽认购比(日频,daily 的 put_call 分组写库)。同 ISM,不进「缺着也缓存」的豁免
  ['pcEquity', 'CBOE_PC_EQUITY'],
  ['pcIndex', 'CBOE_PC_INDEX'],
  ['pcTotal', 'CBOE_PC_TOTAL'],
  // 美元零息通胀掉期(日频,daily 的 dtcc_zcis 分组写库)。同 ISM,不进「缺着也缓存」的豁免
  ['zcis1y', 'DTCC_ZCIS_1Y'],
  ['zcis2y', 'DTCC_ZCIS_2Y'],
] as const;

/** 认沽认购比均线:对外名 → 哪条原始序列、几个交易日(63 ≈ 3 个月)。readDbBacked 现算 */
export const PUT_CALL_MAS = [
  ['pcEquityMa5', 'CBOE_PC_EQUITY', 5],
  ['pcEquityMa20', 'CBOE_PC_EQUITY', 20],
  ['pcEquityMa63', 'CBOE_PC_EQUITY', 63],
  ['pcIndexMa5', 'CBOE_PC_INDEX', 5],
  ['pcIndexMa20', 'CBOE_PC_INDEX', 20],
  ['pcIndexMa63', 'CBOE_PC_INDEX', 63],
] as const;

/** OIS 隐含累计加息次数:对外名 → 以哪个期限结尾的那一段远期(见 shared/calc/policyPath)。 */
export const OIS_HIKE_HORIZONS = [
  ['oisHikes3m', '3M'],
  ['oisHikes6m', '6M'],
  ['oisHikes12m', '12M'],
  ['oisHikes2y', '2Y'],
] as const;

/** 这一批的 key 全集:缓存命中时要先把旧条目按 key 剔掉,再塞新读到的。 */
export const DB_BACKED_KEYS: ReadonlySet<string> = new Set<string>([
  ...JOB_WRITTEN_SERIES.map(([out]) => out),
  'qqq',
  'btc',
  'btcSharpe1y',
  'btcSupplyDensity',
  'btcSupplyDensityRaw',
  'vxTermSpread',
  'move',
  'hyOas',
  'cdxIg',
  'cdxHy',
  ...OIS_HIKE_HORIZONS.map(([out]) => out),
  ...PUT_CALL_MAS.map(([out]) => out),
]);
