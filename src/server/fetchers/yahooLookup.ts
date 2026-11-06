// 图表编辑器的「任意 Yahoo 代码」:按关键字搜代码 + 取某代码的历史日线(收盘 + 开高低,蜡烛图层用)。
// 读时现拉、不落库;日期按交易所当地时间(meta.gmtoffset)取,美股与 fetchers/yahoo 的 UTC 日期一致,非美市场不会错日。
// close 是 Yahoo 的「只调拆股、不调分红」收盘价,与全站 price_eod 同口径(见 AGENTS.md 的 ETF 现货口径)。
import YahooFinance from 'yahoo-finance2';

export type YahooSearchHit = { symbol: string; name: string; type: string; exchange: string };
export type YahooHistory = {
  symbol: string;
  name: string;
  currency?: string;
  /** open / high / low 缺的那天为 null(指数偶有只给收盘的行),前端画蜡烛时跳过那一根 */
  points: { date: string; close: number; open: number | null; high: number | null; low: number | null }[];
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
  /** gmtoffset:交易所时区相对 UTC 的秒数(夏令时已计入) */
  meta: { symbol: string; shortName?: string; longName?: string; currency?: string; gmtoffset?: number };
  quotes: { date: Date; open?: number | null; high?: number | null; low?: number | null; close: number | null }[];
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
  // 日期按交易所当地时间取:日 K 时间戳是开盘时刻,UTC 日期只对美股成立(13:30Z);
  // 澳股夏令时 10:00 开盘 = 前一天 23:00Z,按 UTC 取会整体错一天(周一的点标成周日)
  const offsetMs = (raw.meta.gmtoffset ?? 0) * 1000;
  // 开高低:有限数才要,缺的给 null(0 也当缺:Yahoo 用 0 占位)
  const price = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null);
  // 同一天可能出现两根(盘中快照 + 收盘),Map 按日期保留后一根
  const byDate = new Map(
    raw.quotes
      // 只丢空值 / 0(占位);负价是真实成交(CL=F 2020-04-20 收 −37.63),别当坏数据滤掉
      .filter((q) => typeof q.close === 'number' && Number.isFinite(q.close) && q.close !== 0)
      .map((q) => [
        new Date(q.date.getTime() + offsetMs).toISOString().slice(0, 10),
        { close: q.close as number, open: price(q.open), high: price(q.high), low: price(q.low) },
      ]),
  );

  return {
    symbol: raw.meta.symbol,
    name: raw.meta.longName ?? raw.meta.shortName ?? raw.meta.symbol,
    currency: raw.meta.currency,
    points: [...byDate].map(([date, bar]) => ({ date, ...bar })),
  };
}

export function createYahooLookup(client: YahooLookupClient = defaultLookupClient()) {
  return {
    search: async (q: string) => toSearchHits(await client.search(q)),
    history: async (symbol: string, since: string) => toHistory(await client.chart(symbol, since)),
  };
}
