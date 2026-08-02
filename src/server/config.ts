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

// AI 链的 SEC CIK(取自官方 company_tickers.json)。TSM(CIK 0001046179)报 20-F、走 IFRS
// taxonomy,不在 us-gaap 里,另立需求。
// 各家财年末不同(NVDA 1 月末 / MSFT 6 月末 / AAPL 9 月末 / ORCL 5 月末 / AVGO 10-11 月初 / DELL 1-2 月初,
// 其余 12 月末),合计 FCF 按日历季度对齐(不做前向填充),见 analytics/secFundamentals 的 aggregateFcf。
export const SEC_COMPANIES = [
  { ticker: 'NVDA', cik: '1045810' },
  { ticker: 'MSFT', cik: '789019' },
  { ticker: 'GOOGL', cik: '1652044' },
  { ticker: 'AMZN', cik: '1018724' },
  { ticker: 'AAPL', cik: '320193' },
  { ticker: 'AVGO', cik: '1730168' },
  { ticker: 'DELL', cik: '1571996' },
  { ticker: 'INTC', cik: '50863' },
  { ticker: 'META', cik: '1326801' },
  { ticker: 'ORCL', cik: '1341439' },
];

/** 已通过逐家毛利率核对、可入库的标的。核对一家开一家 —— 未核对的进来会污染合计 FCF。 */
export const SEC_ACTIVE_TICKERS = ['NVDA'];

export const cikOf = (ticker: string): string | undefined => SEC_COMPANIES.find((c) => c.ticker === ticker)?.cik;
