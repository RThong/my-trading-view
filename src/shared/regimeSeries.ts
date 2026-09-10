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

  // ── 库里读 + 派生(readDbBacked)
  'qqq',
  'btc',
  'btcSharpe1y',
  'vxTermSpread',
  'move',

  // ── 现拉 + 派生(主 handler)
  'netLiquidity',
  'repoStress',
  'usd',
  'usdjpy',
  'cftcJpy',
  'dgs10',
  'usjp2y',
  'jgb10y',
  'jgbVix',
  'cape',
  'rxmSpx',
  'vixSpotTerm',
  'brentWti',
  'dieselCrack',
  'rbobYoy',

  // ── 长端分解(rates-decomposition)
  'expShort10Kw',
  'rstarHlwCurrent',
  'lProxyHlwT5yifr',
] as const;

export type RegimeSeries = (typeof REGIME_SERIES)[number];

/** 面板 pane / 后端 put 能用的键:枚举名,或基本面那类动态键。 */
export type SeriesKey = RegimeSeries | FundSeries;

const ENUMERATED: ReadonlySet<string> = new Set(REGIME_SERIES);

/** 运行时校验(给测试与动态来源用;类型收窄不了的地方靠它)。 */
export const isSeriesKey = (k: string): k is SeriesKey => ENUMERATED.has(k) || k.startsWith(FUND_KEY_PREFIX);
