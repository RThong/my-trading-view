import YahooFinance from 'yahoo-finance2';
import type { QuoteRow } from '../storage/repository';

type YahooQuote = {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
};

export type YahooClient = {
  chart: (symbol: string, opts: { period1: Date | string; period2?: Date | string; interval: '1d' })
    => Promise<{ meta: { symbol: string; currency?: string }; quotes: YahooQuote[] }>;
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

export function createYahooFetcher(client: YahooClient = defaultYahooClient()) {
  return {
    async fetchDailyBars(symbol: string, since: Date): Promise<QuoteRow[]> {
      const result = await client.chart(symbol, { period1: since, interval: '1d' });
      return result.quotes
        .filter(q => q.close !== null && q.close !== undefined)
        .map(q => ({
          symbol,
          tradeDate: toIsoDate(q.date),
          open: q.open ?? null,
          high: q.high ?? null,
          low: q.low ?? null,
          close: q.close as number,
          volume: q.volume ?? null,
        }));
    },
  };
}
