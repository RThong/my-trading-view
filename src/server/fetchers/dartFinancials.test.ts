import { describe, expect, test } from 'bun:test';
import { DartNoData, REPORTS, fetchDartReport, latestExpectedPeriod } from './dartFinancials';

const Q1 = REPORTS[0];
const FY = REPORTS[3];

/** 造一份 DART 响应。CIS 给单季+累计两列,CF 只给一列(累计)—— 与真实响应同形。 */
const body = (rows: Array<Partial<Record<string, string>>>, status = '000') =>
  new Response(JSON.stringify({ status, message: status === '000' ? '정상' : 'x', list: rows }), { status: 200 });

const row = (o: { id?: string; nm: string; div: string; amt?: string; add?: string }) => ({
  sj_div: o.div,
  account_id: o.id ?? '',
  account_nm: o.nm,
  thstrm_amount: o.amt ?? '',
  thstrm_add_amount: o.add ?? '',
  rcept_no: '20250514000123',
});

/** 半年报的真实形态:CIS 的 thstrm 是**单季**、add 是累计;CF 的 thstrm 就是累计、add 空。 */
const H1_ROWS = [
  row({ id: 'ifrs-full_Revenue', nm: '매출액', div: 'CIS', amt: '22200', add: '39900' }),
  row({ id: 'ifrs-full_CostOfSales', nm: '매출원가', div: 'CIS', amt: '10200', add: '17800' }),
  row({ id: 'ifrs-full_CashFlowsFromUsedInOperatingActivities', nm: '영업활동 현금흐름', div: 'CF', amt: '18200' }),
  row({
    id: 'ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
    nm: '유형자산의 취득',
    div: 'CF',
    amt: '-10600',
  }),
];

describe('fetchDartReport', () => {
  /**
   * 一个源里两种期间口径。这条规则错了不会报错,只会静默给出错的数:
   * CIS 取 thstrm 会把累计当单季(反过来也一样),CF 取 add 会全空。
   */
  test('一律取「年初至今累计」:CIS 用 add,CF 退回 thstrm', async () => {
    const r = await fetchDartReport('00164779', 2025, REPORTS[1], 'k', async () => body(H1_ROWS));

    expect(r.values).toEqual({ revenue: 39900, cogs: 17800, ocf: 18200, capex: 10600 });
    expect(r.filing.periodEnd).toBe('2025-06-30');
  });

  test('年报的 CIS 累计列是空的 → 退回 thstrm(全年即累计)', async () => {
    const rows = [
      row({ id: 'ifrs-full_Revenue', nm: '매출액', div: 'CIS', amt: '97100' }), // add 空
      row({ id: 'ifrs-full_CostOfSales', nm: '매출원가', div: 'CIS', amt: '38500' }),
      row({ id: 'ifrs-full_CashFlowsFromUsedInOperatingActivities', nm: '영업활동현금흐름', div: 'CF', amt: '53400' }),
      row({
        id: 'ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
        nm: '유형자산의 취득',
        div: 'CF',
        amt: '-27500',
      }),
    ];
    const r = await fetchDartReport('00164779', 2025, FY, 'k', async () => body(rows));

    expect(r.values.revenue).toBe(97100);
    expect(r.filing.periodEnd).toBe('2025-12-31');
  });

  /**
   * 回归:按科目**中文名**匹配会静默取错。两个真实的陷阱都在这份固件里,
   * 而且都**排在正确那行前面** —— 顺序取第一个命中的必然中招。
   */
  test('按 account_id 取,不被同名科目骗:营业外收益 ≠ 营收,处分 ≠ 购置', async () => {
    const rows = [
      row({ id: 'dart_OtherGains', nm: '기타영업외수익', div: 'CIS', amt: '1', add: '1' }), // 含「수익」,排在营收前
      row({ id: 'ifrs-full_Revenue', nm: '매출액', div: 'CIS', amt: '22200', add: '39900' }),
      row({ id: 'ifrs-full_CostOfSales', nm: '매출원가', div: 'CIS', amt: '10200', add: '17800' }),
      row({ id: 'ifrs-full_CashFlowsFromUsedInOperatingActivities', nm: '영업활동 현금흐름', div: 'CF', amt: '18200' }),
      // 「처분」(处分/卖出)排在「취득」(购置)前面,值也不同 —— 取错了 capex 会小一个量级
      row({
        id: 'ifrs-full_ProceedsFromSalesOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
        nm: '유형자산의 처분',
        div: 'CF',
        amt: '77',
      }),
      row({
        id: 'ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
        nm: '유형자산의 취득',
        div: 'CF',
        amt: '-10600',
      }),
    ];
    const r = await fetchDartReport('00164779', 2025, REPORTS[1], 'k', async () => body(rows));

    expect(r.values.revenue).toBe(39900); // 不是 1
    expect(r.values.capex).toBe(10600); // 不是 77
  });

  /** 2019 3Q 之前是 `ifrs_*` 前缀,之后是 `ifrs-full_*`。少了旧档,历史只到 2019Q3。 */
  test('旧 taxonomy 前缀 ifrs_* 也认(2016~2019H1 靠它)', async () => {
    const rows = [
      row({ id: 'ifrs_Revenue', nm: '매출액', div: 'CIS', amt: '100', add: '100' }),
      row({ id: 'ifrs_CostOfSales', nm: '매출원가', div: 'CIS', amt: '60', add: '60' }),
      row({ id: 'ifrs_CashFlowsFromUsedInOperatingActivities', nm: '영업활동현금흐름', div: 'CF', amt: '30' }),
      row({
        id: 'ifrs_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
        nm: '유형자산의 취득',
        div: 'CF',
        amt: '-20',
      }),
    ];
    const r = await fetchDartReport('00164779', 2018, Q1, 'k', async () => body(rows));

    expect(r.values).toEqual({ revenue: 100, cogs: 60, ocf: 30, capex: 20 });
  });

  test('status 013(那期还没交)是 DartNoData,不是失败', async () => {
    const call = fetchDartReport('00164779', 2026, FY, 'k', async () => body([], '013'));
    await expect(call).rejects.toBeInstanceOf(DartNoData);
  });

  test('科目取不到就抛,不静默落一份残缺的', async () => {
    const rows = H1_ROWS.filter((r) => r.account_id !== 'ifrs-full_CostOfSales');
    const call = fetchDartReport('00164779', 2025, REPORTS[1], 'k', async () => body(rows));
    await expect(call).rejects.toThrow(/cogs 没取到/);
  });

  test('rcept_no 前 8 位当申报日 —— 溯源指到那一份公示', async () => {
    const r = await fetchDartReport('00164779', 2025, REPORTS[1], 'k', async () => body(H1_ROWS));
    expect(r.filing.filed).toBe('2025-05-14');
    expect(r.filing.accn).toBe('20250514000123');
  });
});

describe('latestExpectedPeriod', () => {
  // 判早了会每天白拉一轮拿 013;判晚了会让新一期干等着。分기 45 天 + 5 天余量。
  test('季末后不足 50 天 → 还轮不到那一期', () => {
    const r = latestExpectedPeriod(new Date('2026-05-10T00:00:00Z')); // Q1(03-31)才过 40 天
    expect(`${r.year}-${r.report.monthDay}`).toBe('2025-12-31');
  });

  test('季末后超过 50 天 → 该期应已交', () => {
    const r = latestExpectedPeriod(new Date('2026-05-25T00:00:00Z'));
    expect(`${r.year}-${r.report.monthDay}`).toBe('2026-03-31');
  });

  test('年报按 95 天(法定 90)算,跨年不会误判成今年 Q1', () => {
    const r = latestExpectedPeriod(new Date('2026-04-10T00:00:00Z'));
    expect(`${r.year}-${r.report.monthDay}`).toBe('2025-12-31');
  });
});
