import { resolve } from 'node:path';
import { optionUnderlyings } from '../shared/marketCatalog';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const DB_PATH = resolve(PROJECT_ROOT, 'data', 'mtv.db');

/** 保留的最早交易日。所有回填和过滤逻辑都以此为准(更早的数据意义不大)。 */
export const HISTORY_START_DATE = '2018-01-01';

// 期权 / 价格标的白名单均由标的目录(src/shared/marketCatalog)派生,改一处即全局生效。
// moomoo:个股/ETF 用普通代码(SPY);指数用双点格式(.VIX)—— 指数无现货报价,underlying_price 存 null。
// deribit:加密标的(BTC)。none:仅价格序列(NOBL=股息贵族 ETF,攻防指标的防御腿)。
export const OPTIONS_UNDERLYINGS = optionUnderlyings('moomoo');
export const DERIBIT_UNDERLYINGS = optionUnderlyings('deribit');
export const ALL_OPTION_UNDERLYINGS = [...OPTIONS_UNDERLYINGS, ...DERIBIT_UNDERLYINGS];
export const PRICE_ONLY_UNDERLYINGS = optionUnderlyings('none');
