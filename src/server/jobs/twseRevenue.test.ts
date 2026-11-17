import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { expectedLatest, missingMonths, rowsFrom6k, updateTwseRevenue } from './twseRevenue';
import type { TwseRevenueResult } from '../fetchers/twseRevenue';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

// TSM 是名单里唯一走 TWSE 的一家(twseCode 2330),故测试都用它。6-K 补洞默认注入成「一份公告都没有」,不联网
const TSM = { tickers: ['TSM'], reports6k: async () => [], now: new Date('2026-07-20T00:00:00Z') };

function monthly(
  latestMonthEnd: string,
  points: Array<[string, number]>,
  yoyPct: number | null = 10,
): TwseRevenueResult {
  return {
    company: '台積電',
    points: points.map(([monthEnd, revenueTwdM]) => ({ monthEnd, revenueTwdM })),
    yoyPct,
    latestMonthEnd,
    note: null,
  };
}

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

describe('6-K 补缺月', () => {
  const report = (monthEnd: string, revenue: number, prevRevenue: number, lastYearRevenue: number, yoyPct: number) => ({
    monthEnd,
    revenue,
    prevRevenue,
    lastYearRevenue,
    yoyPct,
    accn: 'x',
  });

  test('missingMonths:from ~ last 之间缺的;区间反了 → 无', () => {
    const dates = ['2025-06-30', '2025-07-31', '2025-08-31', '2025-09-30', '2025-10-31', '2026-05-31', '2026-06-30'];
    expect(missingMonths(dates, '2025-07-31', '2026-06-30')).toEqual([
      '2025-11-30',
      '2025-12-31',
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
    expect(missingMonths(dates, '2026-07-31', '2026-06-30')).toEqual([]);
  });

  test('rowsFrom6k:只补库里没有的;当月优先于别份的上月;没公告同比的按营收现算', () => {
    const rows = rowsFrom6k(
      [report('2026-02-28', 200, 190, 100, 100), report('2026-04-30', 230, 220, 150, 53.3)],
      [
        { date: '2025-03-31', value: 110 },
        { date: '2026-04-30', value: 230.4 }, // TWSE 已有,不覆盖
      ],
      ['2026-04-30'],
      { rev: 'R', yoy: 'Y' },
    );
    const rev = Object.fromEntries(rows.filter((r) => r.seriesId === 'R').map((r) => [r.obsDate, r.value]));
    const yoy = Object.fromEntries(rows.filter((r) => r.seriesId === 'Y').map((r) => [r.obsDate, r.value]));

    expect(rev).toEqual({
      '2025-02-28': 100,
      '2026-01-31': 190,
      '2025-04-30': 150,
      '2026-03-31': 220,
      '2026-02-28': 200,
    });
    expect(yoy['2026-02-28']).toBe(100); // 公告给的
    expect(yoy['2026-03-31']).toBeCloseTo((220 / 110 - 1) * 100); // 公告没覆盖,按营收现算
    expect(yoy).not.toHaveProperty('2026-04-30'); // 库里已有
  });

  test('job:近 12 个月有缺才去取 6-K、补上后不再报缺;取 6-K 失败只记一条,TWSE 那步照样写', async () => {
    const db = freshDb();
    const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2025, 7 + i, 0)).toISOString().slice(0, 10));
    insertMarketSeries(db, [
      ...months.filter((d) => d !== '2026-01-31').map((d) => ({ seriesId: 'TWSE_TSM_REV_M', obsDate: d, value: 1 })),
      ...months.map((d) => ({ seriesId: 'TWSE_TSM_REV_YOY', obsDate: d, value: 5 })),
    ]);
    let calls = 0;
    const r = await updateTwseRevenue(db, {
      ...TSM,
      fetcher: async () => monthly('2026-06-30', [['2026-06-30', 1]]),
      reports6k: async () => {
        calls += 1;
        return [report('2026-02-28', 2, 3, 1, 100)];
      },
    });
    expect(calls).toBe(1);
    expect(getMarketSeries(db, 'TWSE_TSM_REV_M').find((p) => p.date === '2026-01-31')?.value).toBe(3);
    expect(r.failed.some((f) => /仍缺/.test(f))).toBe(false);

    // 营收连续、只缺上月同比(漏跑一个月后 TWSE 带回了上月营收、没带上月同比)→ 也要去补
    const yoyOnly = freshDb();
    insertMarketSeries(yoyOnly, [
      ...months.map((d) => ({ seriesId: 'TWSE_TSM_REV_M', obsDate: d, value: 1 })),
      ...months.filter((d) => d !== '2026-06-30').map((d) => ({ seriesId: 'TWSE_TSM_REV_YOY', obsDate: d, value: 5 })),
    ]);
    let yoyCalls = 0;
    await updateTwseRevenue(yoyOnly, {
      ...TSM,
      fetcher: async () => monthly('2026-07-31', [['2026-07-31', 1]]),
      reports6k: async () => {
        yoyCalls += 1;
        return [report('2026-06-30', 1, 1, 1, 7)];
      },
    });
    expect(yoyCalls).toBe(1);
    expect(getMarketSeries(yoyOnly, 'TWSE_TSM_REV_YOY').find((p) => p.date === '2026-06-30')?.value).toBe(7);

    const boom = await updateTwseRevenue(freshDb(), {
      ...TSM,
      fetcher: async () =>
        monthly('2026-06-30', [
          ['2026-05-31', 1],
          ['2026-06-30', 1],
        ]),
      reports6k: async () => {
        throw new Error('SEC down');
      },
    });
    expect(boom.fetched.some((f) => /月营收 2026-06-30/.test(f))).toBe(true);
    expect(boom.failed.some((f) => /6-K 补月营收: SEC down/.test(f))).toBe(true);
  });
});

test('expectedLatest:15 日起算上个月、之前算上上个月;跨年', () => {
  expect(expectedLatest(new Date('2026-07-20T00:00:00Z'))).toBe('2026-06-30');
  expect(expectedLatest(new Date('2026-07-10T00:00:00Z'))).toBe('2026-05-31');
  expect(expectedLatest(new Date('2026-01-05T00:00:00Z'))).toBe('2025-11-30');
});

test('TWSE 挂了几个月(库里最新月不动)→ 按今天推算出缺口,由 6-K 续上', async () => {
  const db = freshDb();
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2025, 3 + i, 0)).toISOString().slice(0, 10));
  insertMarketSeries(db, [
    ...months.map((d) => ({ seriesId: 'TWSE_TSM_REV_M', obsDate: d, value: 1 })),
    ...months.map((d) => ({ seriesId: 'TWSE_TSM_REV_YOY', obsDate: d, value: 5 })),
  ]);
  const r = await updateTwseRevenue(db, {
    ...TSM,
    fetcher: async () => {
      throw new Error('TWSE down');
    },
    reports6k: async () => [
      { monthEnd: '2026-04-30', revenue: 8, prevRevenue: 7, lastYearRevenue: 1, yoyPct: 700, accn: 'x' },
      { monthEnd: '2026-05-31', revenue: 9, prevRevenue: 8, lastYearRevenue: 1, yoyPct: 800, accn: 'x' },
      { monthEnd: '2026-06-30', revenue: 10, prevRevenue: 9, lastYearRevenue: 1, yoyPct: 900, accn: 'x' },
    ],
  });

  expect(getMarketSeries(db, 'TWSE_TSM_REV_M').at(-1)).toEqual({ date: '2026-06-30', value: 10 });
  expect(r.failed.some((f) => /TWSE down/.test(f))).toBe(true);
  expect(r.failed.some((f) => /仍缺/.test(f))).toBe(false);
});
