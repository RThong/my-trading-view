// 图表编辑器的「任意 Yahoo 代码」:按关键字搜代码 + 取某代码的历史日线(收盘 + 开高低 + 成交量,蜡烛图层 / 成交量指标用)。
// 读时现拉、不落库;日期按交易所当地日历(meta.exchangeTimezoneName,见 fetchers/yahoo 的 exchangeDate)取,非美市场不会错日。
// close 是 Yahoo 的「只调拆股、不调分红」收盘价,与全站 ETF 现货(/api/price)同口径(见 AGENTS.md 的 ETF 现货口径)。
import YahooFinance from 'yahoo-finance2';
import { exchangeDate, isYahooFx, realignFxDaily } from './yahoo';

export type YahooSearchHit = { symbol: string; name: string; type: string; exchange: string };
export type YahooHistory = {
  symbol: string;
  name: string;
  currency?: string;
  /** open / high / low 缺的那天为 null(指数偶有只给收盘的行),前端画蜡烛时跳过那一根;
   *  volume 缺 / 0 为 null(外汇、部分指数 Yahoo 全给 0,不是真没成交) */
  points: {
    date: string;
    close: number;
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
  }[];
};

type RawSearch = {
  quotes: {
    symbol?: string;
    shortname?: string;
    longname?: string;
    quoteType?: string;
    exchDisp?: string;
    isYahooFinance?: boolean;
  }[];
};
type RawChart = {
  /** exchangeTimezoneName:交易所时区名(如 Europe/London),日期按它逐根换算 */
  meta: { symbol: string; shortName?: string; longName?: string; currency?: string; exchangeTimezoneName?: string };
  quotes: {
    date: Date;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close: number | null;
    volume?: number | null;
  }[];
};

export type YahooLookupClient = {
  search: (q: string) => Promise<RawSearch>;
  chart: (symbol: string, since: string) => Promise<RawChart>;
};

export function defaultLookupClient(): YahooLookupClient {
  const yf = new YahooFinance();
  return {
    search: (q) => yf.search(q, { quotesCount: 12, newsCount: 0 }) as unknown as Promise<RawSearch>,
    chart: (symbol, since) => yf.chart(symbol, { period1: since, interval: '1d' }) as unknown as Promise<RawChart>,
  };
}

// Yahoo 代码只由这些字符组成(^GSPC、GC=F、BTC-USD、8306.T、BRK-B);别的一律当非法,不往上游转
export function isYahooSymbol(s: string): boolean {
  return /^[A-Za-z0-9.^=-]{1,24}$/.test(s);
}

/**
 * 只留 Yahoo 自己有行情的条目(搜索结果里混着新闻源 / 第三方的条目,取不到日线);
 * 代码里有白名单外字符的(如 M&M.NS)也滤掉 —— history 路由会拒,勾上只会一直「暂无数据」。
 */
export function toSearchHits(raw: RawSearch): YahooSearchHit[] {
  return raw.quotes
    .filter((q) => q.symbol && q.isYahooFinance !== false && isYahooSymbol(q.symbol))
    .map((q) => ({
      symbol: q.symbol!,
      name: q.longname ?? q.shortname ?? q.symbol!,
      type: q.quoteType ?? '',
      exchange: q.exchDisp ?? '',
    }));
}

export function toHistory(raw: RawChart): YahooHistory {
  // 日期按交易所当地日历取:澳股夏令时 10:00 开盘 = 前一天 23:00Z,按 UTC 取会整体错一天(周一的点标成周日)。
  // 不用 meta.gmtoffset:那是「现在」的时差,夏令时一换,历史上另一半年照样错
  const tz = raw.meta.exchangeTimezoneName;
  // 开高低、成交量:有限数才要,缺的给 null(0 也当缺:Yahoo 用 0 占位)
  const price = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null);
  // 同一天可能出现两根(盘中快照 + 收盘),Map 按日期保留后一根
  const byDate = new Map(
    raw.quotes
      // 只丢空值 / 0(占位);负价是真实成交(CL=F 2020-04-20 收 −37.63),别当坏数据滤掉
      .filter((q) => typeof q.close === 'number' && Number.isFinite(q.close) && q.close !== 0)
      .map((q) => [
        exchangeDate(q.date, tz),
        {
          close: q.close as number,
          open: price(q.open),
          high: price(q.high),
          low: price(q.low),
          volume: price(q.volume),
        },
      ]),
  );

  const points = [...byDate].map(([date, bar]) => ({ date, ...bar }));

  return {
    symbol: raw.meta.symbol,
    name: raw.meta.longName ?? raw.meta.shortName ?? raw.meta.symbol,
    currency: raw.meta.currency,
    // 外汇日 K 的收盘错位一根(见 fetchers/yahoo 的 realignFxDaily)
    points: isYahooFx(raw.meta.symbol) ? realignFxDaily(points) : points,
  };
}

export function createYahooLookup(client: YahooLookupClient = defaultLookupClient()) {
  return {
    search: async (q: string) => toSearchHits(await client.search(q)),
    history: async (symbol: string, since: string) => toHistory(await client.chart(symbol, since)),
  };
}
