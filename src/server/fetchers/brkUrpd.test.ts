import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { supplyDensityPct } from './brkUrpd';
import { updateSupplyDensity } from '../jobs/supplyDensitySnapshot';
import { rollingMean } from '../analytics/regime';

describe('supplyDensityPct', () => {
  it('只算收盘价 ±5% 内的桶,分母用 total_supply', () => {
    // 收盘 100:94.9 / 105.1 在带外。不测压线:95/100−1 有浮点误差,边界归属不稳定也无所谓。
    const buckets = [94.9, 95.1, 100, 104.9, 105.1].map((price_floor, i) => ({
      price_floor,
      supply: [1000, 10, 20, 30, 1000][i],
    }));

    expect(supplyDensityPct({ close: 100, total_supply: 200, buckets })).toBeCloseTo(30);
  });
});

describe('updateSupplyDensity', () => {
  const now = new Date('2026-10-07T03:00:00Z');
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];

  it('只拉库里缺的 + 盘中抓的;2012 前不拉;单日失败不连累其它', async () => {
    const db = new Database(':memory:');
    migrate(db);
    // insertMarketSeries 的 fetched_at = 真实当前时刻:今天(UTC)那行就是「盘中抓的」,更早的已收盘。
    const today = new Date().toISOString().slice(0, 10);
    insertMarketSeries(
      db,
      ['2026-10-01', '2026-10-02', today].map((obsDate) => ({ seriesId: 'BTC_SUPPLY_DENSITY', obsDate, value: 1 })),
    );
    const asked: string[] = [];
    const r = await updateSupplyDensity(
      db,
      {
        fetchDates: async () => ['2011-12-31', '2026-10-01', '2026-10-02', '2026-10-03', today],
        fetchValue: async (d) => {
          asked.push(d);
          if (d === '2026-10-03') throw new Error('boom');
          return 12;
        },
      },
      new Date(`${today}T12:00:00Z`),
    );

    expect(asked.sort()).toEqual(['2026-10-03', today]);
    expect(r).toMatchObject({ total: 2, succeeded: 1, latest: today, stale: false });
    expect(r.failures).toEqual(['2026-10-03: boom']);
    expect(getMarketSeries(db, 'BTC_SUPPLY_DENSITY').find((p) => p.date === today)?.value).toBe(12);
  });

  it('恰好落后 3 个日历天不算停更(按日期比,不按小时)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const r = await updateSupplyDensity(
      db,
      { fetchDates: async () => ['2026-10-04'], fetchValue: async () => 12 },
      new Date('2026-10-07T23:00:00Z'),
    );

    expect(r.stale).toBe(false);
  });

  it('源最新日期落后 >3 天 → stale', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const r = await updateSupplyDensity(
      db,
      { fetchDates: async () => dates.slice(0, 3), fetchValue: async () => 12 },
      now,
    );

    expect(r.stale).toBe(true);
  });
});

describe('rollingMean', () => {
  it('窗口不足的前 n−1 点不输出', () => {
    const pts = [1, 2, 3, 4].map((value, i) => ({ date: `2026-10-0${i + 1}`, value }));

    expect(rollingMean(pts, 3)).toEqual([
      { date: '2026-10-03', value: 2 },
      { date: '2026-10-04', value: 3 },
    ]);
  });
});
