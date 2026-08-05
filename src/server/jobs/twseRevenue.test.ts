import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { updateTwseRevenue } from './twseRevenue';
import type { TwseIncome, TwseRevenueResult } from '../fetchers/twseRevenue';

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

const noMonthly = async () => {
  throw new Error('本轮不该拉月营收');
};
const noIncome = async () => {
  throw new Error('本轮不该拉季度损益');
};

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
      incomeFetcher: async () => null,
    });

    expect(r.fetched.some((f) => /月营收 2026-06-30/.test(f))).toBe(true);
    expect(getMarketSeries(db, 'TWSE_TSM_REV_M')).toHaveLength(3);
    expect(getMarketSeries(db, 'TWSE_TSM_REV_YOY')).toEqual([{ date: '2026-06-30', value: 67.87 }]);
    db.close();
  });

  test('本月没出新数 → skip;而季度损益照常独立判断(两个端点两种频率)', async () => {
    const db = freshDb();
    insertMarketSeries(db, [{ seriesId: 'TWSE_TSM_REV_M', obsDate: '2026-06-30', value: 1 }]);

    const r = await updateTwseRevenue(db, {
      ...TSM,
      fetcher: async () => monthly('2026-06-30', [['2026-06-30', 442679.969]]),
      // 季度那侧给了新数据 → 必须照写,不能被月营收的 skip 带着一起跳过。
      incomeFetcher: async (): Promise<TwseIncome> => ({
        periodEnd: '2026-03-31',
        revenueYtdTwdM: 100,
        cogsYtdTwdM: 40,
      }),
    });

    expect(r.skipped).toContain('TSM:月营收');
    expect(getMarketSeries(db, 'TWSE_TSM_GM')).toEqual([{ date: '2026-03-31', value: 60 }]);
    db.close();
  });

  test('有月营收但同比一个点都没有 → 报出来(源字段改名会静默丢掉整条线)', async () => {
    const db = freshDb();
    const r = await updateTwseRevenue(db, {
      ...TSM,
      fetcher: async () => monthly('2026-06-30', [['2026-06-30', 442679.969]], null),
      incomeFetcher: async () => null,
    });

    expect(r.failed.some((f) => /有月营收但同比一个点都没有/.test(f))).toBe(true);
    db.close();
  });
});

describe('TWSE 季度毛利率(累计差分)', () => {
  const income = (periodEnd: string, rev: number, cogs: number) => async (): Promise<TwseIncome> => ({
    periodEnd,
    revenueYtdTwdM: rev,
    cogsYtdTwdM: cogs,
  });

  test('本季未申报(null)算 skip 不算 failed —— 同一季各公司陆续交,截止日是季后约 45 天', async () => {
    const db = freshDb();
    const r = await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: async () => null });

    expect(r.skipped).toContain('TSM:季度损益(本季未申报)');
    expect(r.failed.filter((f) => /季度损益/.test(f))).toEqual([]);
    db.close();
  });

  test('Q1 的累计就是单季,直接出点', async () => {
    const db = freshDb();
    await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: income('2026-03-31', 100, 40) });

    expect(getMarketSeries(db, 'TWSE_TSM_GM')).toEqual([{ date: '2026-03-31', value: 60 }]);
    // 累计原始量要留档(可审计 + 下一季要拿它来差分)。
    expect(getMarketSeries(db, 'TWSE_TSM_REV_YTD')).toEqual([{ date: '2026-03-31', value: 100 }]);
    db.close();
  });

  test('Q2 用相邻两季累计相减,不是拿累计值当单季', async () => {
    const db = freshDb();
    await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: income('2026-03-31', 100, 40) });
    await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: income('2026-06-30', 300, 90) });

    // Q2 单季:营收 300−100=200,成本 90−40=50 → 毛利率 75%。
    // 若错拿累计:(300−90)/300 = 70%,会把 Q1 的 60% 平均进来、抹平转折。
    expect(getMarketSeries(db, 'TWSE_TSM_GM')).toEqual([
      { date: '2026-03-31', value: 60 },
      { date: '2026-06-30', value: 75 },
    ]);
    db.close();
  });

  test('缺上一季累计 → 那一季不出点(宁可空着,不拿累计当单季)', async () => {
    // 首次接入正好落在 Q3:库里没有 Q2 累计,无法还原单季 → 该季无点。
    const db = freshDb();
    await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: income('2026-09-30', 500, 150) });

    expect(getMarketSeries(db, 'TWSE_TSM_GM')).toEqual([]);
    expect(getMarketSeries(db, 'TWSE_TSM_REV_YTD')).toHaveLength(1); // 累计仍留档,下一季就能差分
    db.close();
  });

  test('Q1 不去减上一年度的 Q4(累计跨年归零)', async () => {
    const db = freshDb();
    await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: income('2025-12-31', 1000, 600) });
    await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: income('2026-03-31', 100, 40) });

    const gm = getMarketSeries(db, 'TWSE_TSM_GM');
    // 2026-03-31 必须是 60%(100/40 本身),不是 (100−1000) 那种跨年乱减。
    expect(gm.find((p) => p.date === '2026-03-31')).toEqual({ date: '2026-03-31', value: 60 });
    db.close();
  });

  test('两个源的 gm 同名但落不同 series_id —— 不会互相覆盖', async () => {
    const db = freshDb();
    // SEC 侧的 NVDA 毛利率
    insertMarketSeries(db, [{ seriesId: 'SEC_NVDA_GM_TTM', obsDate: '2026-04-26', value: 70 }]);
    await updateTwseRevenue(db, { ...TSM, fetcher: noMonthly, incomeFetcher: income('2026-03-31', 100, 40) });

    expect(getMarketSeries(db, 'SEC_NVDA_GM_TTM')).toHaveLength(1);
    expect(getMarketSeries(db, 'TWSE_TSM_GM')).toHaveLength(1);
    db.close();
  });

  test('季度端点抛错只记 failed,不连累月营收那一半', async () => {
    const db = freshDb();
    const r = await updateTwseRevenue(db, {
      ...TSM,
      fetcher: async () => monthly('2026-06-30', [['2026-06-30', 442679.969]]),
      incomeFetcher: noIncome,
    });

    expect(r.failed.some((f) => /季度损益: 本轮不该拉季度损益/.test(f))).toBe(true);
    expect(getMarketSeries(db, 'TWSE_TSM_REV_M')).toHaveLength(1); // 月营收照常落库
    db.close();
  });
});
