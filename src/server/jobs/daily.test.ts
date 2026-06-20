import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getQuotes, getMacroSeries, getJobHealth } from '../storage/repository';
import { runDailyJob } from './daily';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('daily job', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('writes quote rows for each requested symbol and records success', async () => {
    await runDailyJob({
      db,
      quoteSymbols: [{ symbol: 'AAA', label: 'A', group: 'index' }],
      macroSeries: [],
      yahoo: {
        fetchDailyBars: async (sym, since) => [
          { symbol: sym, tradeDate: '2026-05-10', open: 1, high: 2, low: 0, close: 1.5, volume: 100 },
        ],
      },
      fred: { fetchSeries: async () => [] },
      historyDays: 30,
    });

    expect(getQuotes(db, 'AAA', 36500)).toHaveLength(1);
    const health = getJobHealth(db);
    expect(health.find(h => h.name === 'quotes')?.status).toBe('success');
  });

  test('partial: one symbol fails, others succeed, marked partial', async () => {
    const failingYahoo = {
      fetchDailyBars: async (sym: string) => {
        if (sym === 'BAD') throw new Error('rate limited');
        return [{ symbol: sym, tradeDate: '2026-05-10', open: 1, high: 2, low: 0, close: 1.5, volume: 100 }];
      },
    };
    await runDailyJob({
      db,
      quoteSymbols: [
        { symbol: 'GOOD', label: 'G', group: 'index' },
        { symbol: 'BAD', label: 'B', group: 'index' },
      ],
      macroSeries: [],
      yahoo: failingYahoo,
      fred: { fetchSeries: async () => [] },
      historyDays: 30,
    });

    expect(getQuotes(db, 'GOOD', 36500)).toHaveLength(1);
    expect(getQuotes(db, 'BAD', 36500)).toHaveLength(0);
    const health = getJobHealth(db).find(h => h.name === 'quotes')!;
    expect(health.status).toBe('partial');
    expect(health.error).toContain('BAD');
  });

  test('writes macro and records macro success independently', async () => {
    await runDailyJob({
      db,
      quoteSymbols: [],
      macroSeries: [{ id: 'DGS10', label: '10Y', unit: '%' }],
      yahoo: { fetchDailyBars: async () => [] },
      fred: {
        fetchSeries: async () => [{ seriesId: 'DGS10', obsDate: '2026-05-10', value: 4.2 }],
      },
      historyDays: 30,
    });

    expect(getMacroSeries(db, 'DGS10', 36500)).toHaveLength(1);
    expect(getJobHealth(db).find(h => h.name === 'macro')?.status).toBe('success');
  });
});
