import { resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const DB_PATH = resolve(PROJECT_ROOT, 'data', 'mtv.db');

/** 保留的最早交易日。所有回填和过滤逻辑都以此为准(更早的数据意义不大)。 */
export const HISTORY_START_DATE = '2018-01-01';
/** 对应的天数,用于 API/前端的上限(约留 22 年余量)。 */
export const HISTORY_MAX_DAYS = 8000;

// 通过 moomoo 做期权快照的标的;原样作为 moomoo 证券代码传入,并存储为
// `underlying` 键。个股/ETF 用普通代码(SPY);指数用双点格式(.VIX = VIX 指数,
// .SPX = SPX 指数)—— 指数无现货报价权限,underlying_price 会存 null。
export const OPTIONS_UNDERLYINGS = ['SPY', 'QQQ', '.VIX', 'TLT', 'GLD', 'USO'];

// 通过 Deribit 做期权快照的加密标的(BTC/ETH);存储为 `underlying` 键(BTC)。
export const DERIBIT_UNDERLYINGS = ['BTC'];

// 期权 API 路由的白名单(moomoo + deribit 两类合并)。
export const ALL_OPTION_UNDERLYINGS = [...OPTIONS_UNDERLYINGS, ...DERIBIT_UNDERLYINGS];
