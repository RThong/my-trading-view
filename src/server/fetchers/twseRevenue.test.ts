import { describe, expect, test } from 'bun:test';
import { fetchTwseMonthlyRevenue, rocMonthEnd, twseSeriesId } from './twseRevenue';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// TSMC 2026-06 的真实记录(openapi.twse.com.tw/v1/opendata/t187ap05_L,实测 2026-08-05 取)。
// 金额单位是千元新台币,年月是民国年月。
const TSMC_ROW = {
  出表日期: '1150717',
  資料年月: '11506',
  公司代號: '2330',
  公司名稱: '台積電',
  產業別: '半導體業',
  '營業收入-當月營收': '442679969',
  '營業收入-上月營收': '416975163',
  '營業收入-去年當月營收': '263708978',
  '營業收入-去年同月增減(%)': '67.86685548491262',
  備註: '因先進製程產品需求增加所致。',
};

describe('民国年月 → 月末日', () => {
  test('按月末打点(月营收是整月的量,落月初会造成「月初就有这个数」的错觉)', () => {
    expect(rocMonthEnd('11506')).toBe('2026-06-30');
    expect(rocMonthEnd('11502')).toBe('2026-02-28'); // 平年
    expect(rocMonthEnd('11302')).toBe('2024-02-29'); // 闰年
    expect(rocMonthEnd('11412')).toBe('2025-12-31');
  });

  test('格式不对返回 null(不猜)', () => {
    for (const bad of ['11413', '11500', '1150', 'abcde', '']) expect(rocMonthEnd(bad)).toBeNull();
  });
});

describe('fetchTwseMonthlyRevenue', () => {
  const withRows = (rows: unknown[]) => async () => json(rows);

  test('一次调用拿三个点:当月 / 上月 / 去年当月,升序', async () => {
    const r = await fetchTwseMonthlyRevenue('2330', withRows([{ 公司代號: '1234' }, TSMC_ROW]));

    // 千元 → 百万新台币。三个点是这个源唯一的历史来源(不可回填),少取一个就少一格。
    expect(r.points).toEqual([
      { monthEnd: '2025-06-30', revenueTwdM: 263708.978 },
      { monthEnd: '2026-05-31', revenueTwdM: 416975.163 },
      { monthEnd: '2026-06-30', revenueTwdM: 442679.969 },
    ]);
    expect(r.latestMonthEnd).toBe('2026-06-30');
    expect(r.company).toBe('台積電');
    expect(r.note).toBe('因先進製程產品需求增加所致。');
  });

  test('同比取源自己算的值 —— 我们攒的历史可能缺去年那个月', async () => {
    const r = await fetchTwseMonthlyRevenue('2330', withRows([TSMC_ROW]));

    expect(r.yoyPct).toBeCloseTo(67.8669, 3);
    // 与「当月 / 去年当月 − 1」一致,证明取的是同一口径而不是别的字段。
    const self = (442679969 / 263708978 - 1) * 100;
    expect(r.yoyPct!).toBeCloseTo(self, 6);
  });

  test('找不到代号要抛 —— 2330 是上市股,必然在表里,缺了是源/配置出问题不是「本月没数」', async () => {
    await expect(fetchTwseMonthlyRevenue('2330', withRows([{ 公司代號: '1234' }]))).rejects.toThrow(/没有代号 2330/);
  });

  test('空数组要抛(源结构变了),不是当成「本月无数据」静默返回', async () => {
    await expect(fetchTwseMonthlyRevenue('2330', withRows([]))).rejects.toThrow(/返回空数组/);
  });

  test('缺值是空字符串而不是 0 —— 不能把它当 0 写进序列', async () => {
    const r = await fetchTwseMonthlyRevenue(
      '2330',
      withRows([{ ...TSMC_ROW, '營業收入-上月營收': '', '營業收入-去年當月營收': '0' }]),
    );

    // 上月空、去年当月为 0 → 都不落点,只剩当月那一个。
    expect(r.points.map((p) => p.monthEnd)).toEqual(['2026-06-30']);
  });

  test('非 200 抛错', async () => {
    await expect(fetchTwseMonthlyRevenue('2330', async () => new Response('x', { status: 503 }))).rejects.toThrow(
      /HTTP 503/,
    );
  });

  test('series_id 前缀标出源:一眼看出这条线不是 SEC 来的', () => {
    expect(twseSeriesId('TSM', 'revM')).toBe('TWSE_TSM_REV_M');
    expect(twseSeriesId('TSM', 'revYoy')).toBe('TWSE_TSM_REV_YOY');
  });
});
