import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { updateTwseRevenue } from './twseRevenue';
import type { TwseRevenueResult } from '../fetchers/twseRevenue';

const freshDb = () => {
  const db = new Database(':memory:');
  migrate(db);
  return db;
};

// TSM 是名单里唯一走 TWSE 的一家(twseCode 2330),故测试都用它。
const TSM = { tickers: ['TSM'] };

const monthly = (
  latestMonthEnd: string,
  points: Array<[string, number]>,
  yoyPct: number | null = 10,
): TwseRevenueResult => ({
  company: '台積電',
  points: points.map(([monthEnd, revenueTwdM]) => ({ monthEnd, revenueTwdM })),
  yoyPct,
  latestMonthEnd,
  note: null,
});

describe('TWSE 月营收', () => {
  test('一次写三个点 + 一个同比点(快照型源唯一的历史来源)', async () => {
    const db = freshDb();
    const r = await updateTwseRevenue(db, {
      ...TSM,
      fetcher: async () =>
        monthly(
          '2026-06-30',
          [
            ['2025-06-30', 263708.978],
            ['2026-05-31', 416975.163],
            ['2026-06-30', 442679.969],
          ],
          67.87,
        ),
    });

    expect(r.fetched.some((f) => /月营收 2026-06-30/.test(f))).toBe(true);
    expect(getMarketSeries(db, 'TWSE_TSM_REV_M')).toHaveLength(3);
    expect(getMarketSeries(db, 'TWSE_TSM_REV_YOY')).toEqual([{ date: '2026-06-30', value: 67.87 }]);
    db.close();
  });

  test('本月没出新数 → skip,零写入', async () => {
    const db = freshDb();
    insertMarketSeries(db, [{ seriesId: 'TWSE_TSM_REV_M', obsDate: '2026-06-30', value: 1 }]);

    const r = await updateTwseRevenue(db, {
      ...TSM,
      fetcher: async () => monthly('2026-06-30', [['2026-06-30', 442679.969]]),
    });

    expect(r.skipped).toContain('TSM:月营收');
    expect(r.written).toBe(0); // 真 no-op
    db.close();
  });

  test('有月营收但同比一个点都没有 → 报出来(源字段改名会静默丢掉整条线)', async () => {
    const db = freshDb();
    const r = await updateTwseRevenue(db, {
      ...TSM,
      fetcher: async () => monthly('2026-06-30', [['2026-06-30', 442679.969]], null),
    });

    expect(r.failed.some((f) => /有月营收但同比一个点都没有/.test(f))).toBe(true);
    db.close();
  });
});
