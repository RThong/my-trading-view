import { describe, test, expect } from 'bun:test';
import { createYahooFetcher, realignFxDaily, type YahooClient } from './yahoo';

describe('realignFxDaily', () => {
  test('收盘换成下一根的收盘(高低把它包进去),最后一根去掉', () => {
    const rows = [
      { open: 150, high: 151, low: 149.5, close: 150 },
      { open: 152, high: 152.5, low: 151.8, close: 152 },
      { open: 149, high: 150, low: 148, close: 149 },
    ];
    expect(realignFxDaily(rows)).toEqual([
      { open: 150, high: 152, low: 149.5, close: 152 },
      { open: 152, high: 152.5, low: 149, close: 149 },
    ]);
  });

  test('fetchDailyBars 只对 =X 外汇代码拼,股票不动', async () => {
    const mockClient: YahooClient = {
      chart: async (symbol) => ({
        meta: { symbol, exchangeTimezoneName: 'Europe/London' },
        quotes: [
          { date: new Date('2026-01-05T00:00:00Z'), open: 150, high: 151, low: 149, close: 150, volume: 0 },
          { date: new Date('2026-01-06T00:00:00Z'), open: 151, high: 152, low: 150, close: 151, volume: 0 },
        ],
      }),
    };
    const f = createYahooFetcher(mockClient);
    expect((await f.fetchDailyBars('JPY=X', new Date(0))).map((r) => [r.tradeDate, r.close])).toEqual([
      ['2026-01-05', 151],
    ]);
    expect(await f.fetchDailyBars('SPY', new Date(0))).toHaveLength(2);
  });
});

describe('yahoo fetcher', () => {
  test('日期按交易所时区:伦敦 0 点在夏令时是前一天 23:00Z,仍记当地那天(周一不会变周日)', async () => {
    const mockClient: YahooClient = {
      chart: async (symbol) => ({
        meta: { symbol, exchangeTimezoneName: 'Europe/London' },
        quotes: [
          { date: new Date('2026-07-05T23:00:00Z'), open: 160, high: 161, low: 159, close: 160.5, volume: 0 },
          { date: new Date('2026-01-05T00:00:00Z'), open: 150, high: 151, low: 149, close: 150.5, volume: 0 },
        ],
      }),
    };
    const rows = await createYahooFetcher(mockClient).fetchDailyBars('^FTSE', new Date('2026-01-01'));
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
