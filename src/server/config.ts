import { resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const DB_PATH = resolve(PROJECT_ROOT, 'data', 'mtv.db');

/** 保留的最早交易日。所有回填和过滤逻辑都以此为准。 */
export const HISTORY_START_DATE = '2007-01-01';
/** 对应的天数,用于 API/前端的上限(约留 22 年余量)。 */
export const HISTORY_MAX_DAYS = 8000;

/** 从 Yahoo(yahoo-finance2)拉取的标的。 */
export const QUOTE_SYMBOLS = [
  { symbol: '^GSPC',   label: 'S&P 500', group: 'index' as const },
  { symbol: 'QQQ',     label: 'QQQ',   group: 'index' as const },
  { symbol: 'IWM',     label: 'IWM',   group: 'index' as const },
  { symbol: 'GLD',     label: 'GLD',   group: 'asset' as const },
  { symbol: 'TLT',     label: 'TLT',   group: 'asset' as const },
  { symbol: 'BTC-USD', label: 'BTC',   group: 'asset' as const },
];

/**
 * 直接从 CBOE(cdn.cboe.com)拉取的指数,这里有可追溯到 1990 年代甚至更早的
 * 完整历史数据。`cboeSymbol` 是 URL 里的标识;我们以 `symbol` 存储
 * (加 `^` 前缀,以便和 DB 中其他地方使用的 Yahoo 风格命名保持一致)。
 */
export const CBOE_INDEX_SYMBOLS = [
  { symbol: '^VIX',    cboeSymbol: 'VIX',    label: 'VIX',   group: 'volatility' as const },
  { symbol: '^VIX9D',  cboeSymbol: 'VIX9D',  label: 'VIX9D', group: 'volatility' as const },
  { symbol: '^VIX3M',  cboeSymbol: 'VIX3M',  label: 'VIX3M', group: 'volatility' as const },
  { symbol: '^VIX6M',  cboeSymbol: 'VIX6M',  label: 'VIX6M', group: 'volatility' as const },
  { symbol: '^VIX1Y',  cboeSymbol: 'VIX1Y',  label: 'VIX1Y', group: 'volatility' as const },
  { symbol: '^VVIX',   cboeSymbol: 'VVIX',   label: 'VVIX',  group: 'volatility' as const },
  { symbol: '^SKEW',   cboeSymbol: 'SKEW',   label: 'SKEW',  group: 'volatility' as const },
  { symbol: '^RXM',    cboeSymbol: 'RXM',    label: 'RXM',   group: 'strategy'   as const },
];

// 通过 moomoo 做期权快照的标的;原样作为 moomoo 证券代码传入,并存储为
// `underlying` 键。个股/ETF 用普通代码(SPY);指数用双点格式(.VIX = VIX 指数,
// .SPX = SPX 指数)—— 指数无现货报价权限,underlying_price 会存 null。
export const OPTIONS_UNDERLYINGS = ['SPY', '.VIX'];

// 通过 Deribit 做期权快照的加密标的(BTC/ETH);存储为 `underlying` 键(BTC)。
export const DERIBIT_UNDERLYINGS = ['BTC'];

// 期权 API 路由的白名单(moomoo + deribit 两类合并)。
export const ALL_OPTION_UNDERLYINGS = [...OPTIONS_UNDERLYINGS, ...DERIBIT_UNDERLYINGS];

export const MACRO_SERIES = [
  { id: 'DGS10',     label: 'UST 10Y',  unit: '%' },
  { id: 'DGS2',      label: 'UST 2Y',   unit: '%' },
  { id: 'DGS3MO',    label: 'UST 3M',   unit: '%' },
  { id: 'DTWEXBGS',  label: 'USD Index (broad)', unit: 'index' },
];
