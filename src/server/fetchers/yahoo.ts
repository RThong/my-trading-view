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
  ) => Promise<{ meta: { symbol: string; currency?: string }; quotes: YahooQuote[] }>;
};

export function defaultYahooClient(): YahooClient {
  const instance = new YahooFinance();
  return {
    chart: (symbol, opts) => instance.chart(symbol, opts) as any,
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
          tradeDate: toIsoDate(q.date),
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
        .map((q) => ({ date: toIsoDate(q.date), adjClose: q.adjclose as number }));
    },

    /** 复权收盘 + 成交量(一次 chart 调用):收益/波动类计算须用复权(避免分红/拆股的机械跳变),
     *  同时保留 volume 供广度指标使用。adjclose 缺失的行丢弃。 */
    async fetchAdjBarsWithVolume(symbol: string, since: Date): Promise<AdjBarVol[]> {
      const result = await client.chart(symbol, { period1: since, interval: '1d' });
      return result.quotes
        .filter((q) => q.adjclose !== null && q.adjclose !== undefined)
        .map((q) => ({ date: toIsoDate(q.date), close: q.adjclose as number, volume: q.volume ?? null }));
    },
  };
}

export type AdjBarVol = { date: string; close: number; volume: number | null };
