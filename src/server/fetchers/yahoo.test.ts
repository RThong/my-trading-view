import { describe, test, expect } from 'bun:test';
import { createYahooFetcher, type YahooClient } from './yahoo';

describe('yahoo fetcher', () => {
  test('日期按交易所时区:JPY=X 伦敦 0 点在夏令时是前一天 23:00Z,仍记当地那天(周一不会变周日)', async () => {
    const mockClient: YahooClient = {
      chart: async (symbol) => ({
        meta: { symbol, exchangeTimezoneName: 'Europe/London' },
        quotes: [
          { date: new Date('2026-07-05T23:00:00Z'), open: 160, high: 161, low: 159, close: 160.5, volume: 0 },
          { date: new Date('2026-01-05T00:00:00Z'), open: 150, high: 151, low: 149, close: 150.5, volume: 0 },
        ],
      }),
    };
    const rows = await createYahooFetcher(mockClient).fetchDailyBars('JPY=X', new Date('2026-01-01'));
    expect(rows.map((r) => r.tradeDate)).toEqual(['2026-07-06', '2026-01-05']);
  });

  test('fetchDailyBars maps yahoo chart() output to QuoteRow shape', async () => {
    const mockClient: YahooClient = {
      chart: async (symbol, _opts) => ({
        meta: { symbol, currency: 'USD' },
        quotes: [
          { date: new Date('2026-05-10T00:00:00Z'), open: 100, high: 102, low: 99, close: 101, volume: 1000 },
          { date: new Date('2026-05-11T00:00:00Z'), open: 101, high: 103, low: 100, close: 102, volume: 1100 },
        ],
      }),
    };

    const fetcher = createYahooFetcher(mockClient);
    const rows = await fetcher.fetchDailyBars('TEST', new Date('2026-05-01'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      symbol: 'TEST',
      tradeDate: '2026-05-10',
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 1000,
    });
  });

  test('fetchDailyBars handles missing OHLC fields', async () => {
    const mockClient: YahooClient = {
      chart: async () => ({
        meta: { symbol: 'TEST', currency: 'USD' },
        quotes: [
          { date: new Date('2026-05-10T00:00:00Z'), open: null, high: null, low: null, close: 50, volume: null },
        ],
      }),
    };

    const fetcher = createYahooFetcher(mockClient);
    const rows = await fetcher.fetchDailyBars('TEST', new Date('2026-05-01'));
    expect(rows[0]).toEqual({
      symbol: 'TEST',
      tradeDate: '2026-05-10',
      open: null,
      high: null,
      low: null,
      close: 50,
      volume: null,
    });
  });

  test('fetchDailyBars rejects rows with null close', async () => {
    const mockClient: YahooClient = {
      chart: async () => ({
        meta: { symbol: 'TEST', currency: 'USD' },
        quotes: [
          { date: new Date('2026-05-10T00:00:00Z'), open: 1, high: 2, low: 0, close: null, volume: 100 },
          { date: new Date('2026-05-11T00:00:00Z'), open: 1, high: 2, low: 0, close: 50, volume: 100 },
        ],
      }),
    };

    const fetcher = createYahooFetcher(mockClient);
    const rows = await fetcher.fetchDailyBars('TEST', new Date('2026-05-01'));
    expect(rows).toHaveLength(1);
    expect(rows[0].tradeDate).toBe('2026-05-11');
  });
});
