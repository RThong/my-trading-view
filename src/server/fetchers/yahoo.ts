import YahooFinance from 'yahoo-finance2';
import type { QuoteRow } from '../storage/repository';

type YahooQuote = {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjclose?: number | null; // 拆股+分红复权收盘(回测用;蜡烛图仍用未复权 close)
  volume: number | null;
};

export type YahooClient = {
  chart: (
    symbol: string,
    opts: { period1: Date | string; period2?: Date | string; interval: '1d' },
  ) => Promise<{ meta: { symbol: string; currency?: string; exchangeTimezoneName?: string }; quotes: YahooQuote[] }>;
};

export function defaultYahooClient(): YahooClient {
  const instance = new YahooFinance();
  return {
    chart: (symbol, opts) => instance.chart(symbol, opts) as any,
  };
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * 日 K 的日期按**交易所当地日历**取:Yahoo 日 K 的时间戳是当地 0 点 / 开盘时刻,按 UTC 取日期只对美股成立。
 * 外汇 `JPY=X` 是伦敦 0 点:夏令时期间 = 前一天 23:00Z,按 UTC 取整条往前错一天(周一标成周日、周五标成周四);
 * 日经 `^N225` 东京 0 点 = 前一天 15:00Z,天天错。必须按时区名逐根换算 —— 用当前 gmtoffset 只对一半年份成立。
 * tz 缺失时退回 UTC(美股时间戳在当天 13:30Z,UTC 日期本来就对)。
 */
export function exchangeDate(d: Date, tz: string | undefined): string {
  if (!tz) return d.toISOString().slice(0, 10);
  const fmt =
    dayFormats.get(tz) ??
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  dayFormats.set(tz, fmt);

  return fmt.format(d);
}

export type AdjBar = { date: string; adjClose: number };

export function createYahooFetcher(client: YahooClient = defaultYahooClient()) {
  return {
    async fetchDailyBars(symbol: string, since: Date): Promise<QuoteRow[]> {
      const result = await client.chart(symbol, { period1: since, interval: '1d' });
      return result.quotes
        .filter((q) => q.close !== null && q.close !== undefined)
        .map((q) => ({
          symbol,
          tradeDate: exchangeDate(q.date, result.meta.exchangeTimezoneName),
          open: q.open ?? null,
          high: q.high ?? null,
          low: q.low ?? null,
          close: q.close as number,
          volume: q.volume ?? null,
        }));
    },

    /** 复权收盘日线(回测用):adjclose 缺失的行丢弃。 */
    async fetchAdjDailyBars(symbol: string, since: Date): Promise<AdjBar[]> {
      const result = await client.chart(symbol, { period1: since, interval: '1d' });
      return result.quotes
        .filter((q) => q.adjclose !== null && q.adjclose !== undefined)
        .map((q) => ({ date: exchangeDate(q.date, result.meta.exchangeTimezoneName), adjClose: q.adjclose as number }));
    },

    /** 复权收盘 + 成交量(一次 chart 调用):收益/波动类计算须用复权(避免分红/拆股的机械跳变),
     *  同时保留 volume 供广度指标使用。adjclose 缺失的行丢弃。 */
    async fetchAdjBarsWithVolume(symbol: string, since: Date): Promise<AdjBarVol[]> {
      const result = await client.chart(symbol, { period1: since, interval: '1d' });
      return result.quotes
        .filter((q) => q.adjclose !== null && q.adjclose !== undefined)
        .map((q) => ({
          date: exchangeDate(q.date, result.meta.exchangeTimezoneName),
          close: q.adjclose as number,
          volume: q.volume ?? null,
        }));
    },
  };
}

export type AdjBarVol = { date: string; close: number; volume: number | null };
