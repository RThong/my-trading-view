import { resolve } from 'node:path';
import { optionUnderlyings } from '../shared/marketCatalog';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const DB_PATH = resolve(PROJECT_ROOT, 'data', 'mtv.db');

/** 保留的最早交易日。所有回填和过滤逻辑都以此为准(更早的数据意义不大)。 */
export const HISTORY_START_DATE = '2018-01-01';

/**
 * 季节 z 的基准期年数。**必须单一真源** —— 它同时决定两件事:
 *  · `analytics/seasonalZ` 往前取几年的同期样本;
 *  · `fetchers/eia` 要多拉多少周(展示起点再往前垫这么多年)。
 *
 * `seasonalZ` 的 `years` **刻意没有默认值**(类型上必填),就是为了逼调用方从这里取。
 * 两处各写一个 5 的话,改动任一处就静默失配,而失效形式是无声的:
 * 拉取窗口盖不住基准期 → `seasonalZ` 对样本不足的点直接跳过 → 图上最早那批 z 悄悄消失,不报错。
 */
export const SEASONAL_BASELINE_YEARS = 5;
// ⚠️ 改这个数要连带改对外序列名(`refUtilZ5y` / `distStocksZ5y` … 把 5 写进了名字),否则名字会说谎。

// 期权 / 价格标的白名单均由标的目录(src/shared/marketCatalog)派生,改一处即全局生效。
// moomoo:个股/ETF 用普通代码(SPY);指数用双点格式(.VIX)—— 指数无现货报价,underlying_price 存 null。
// deribit:加密标的(BTC)。none:仅价格序列(NOBL=股息贵族 ETF,攻防指标的防御腿)。
export const OPTIONS_UNDERLYINGS = optionUnderlyings('moomoo');
export const DERIBIT_UNDERLYINGS = optionUnderlyings('deribit');
export const ALL_OPTION_UNDERLYINGS = [...OPTIONS_UNDERLYINGS, ...DERIBIT_UNDERLYINGS];
export const PRICE_ONLY_UNDERLYINGS = optionUnderlyings('none');
