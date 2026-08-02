import { describe, expect, test } from 'bun:test';
import {
  aggregateFcf,
  calendarQuarter,
  collectPeriods,
  deriveSeries,
  extractFundamentals,
  toQuarters,
  ttm,
  type CompanyFacts,
  type FactRow,
} from './secFundamentals';

const row = (start: string, end: string, val: number, extra: Partial<FactRow> = {}): FactRow => ({
  start,
  end,
  val,
  accn: 'a-1',
  form: '10-Q',
  filed: '2025-05-28',
  ...extra,
});

const facts = (tags: Record<string, FactRow[]>): CompanyFacts => ({
  facts: {
    'us-gaap': Object.fromEntries(Object.entries(tags).map(([t, rows]) => [t, { units: { USD: rows } }])),
  },
});

// NVDA FY2026 现金流实测值(YTD 累计),黄金值来自 data.sec.gov companyfacts。
const NVDA_OCF_YTD = [
  row('2025-01-27', '2025-04-27', 27_414_000_000),
  row('2025-01-27', '2025-07-27', 42_779_000_000),
  row('2025-01-27', '2025-10-26', 66_530_000_000),
  row('2025-01-27', '2026-01-25', 102_718_000_000, { form: '10-K', filed: '2026-02-25' }),
];

describe('YTD 差分还原单季', () => {
  test('NVDA FY2026 四季相加 = 全年 102.718B(黄金值)', () => {
    const quarters = toQuarters(
      collectPeriods(facts({ NetCashProvidedByUsedInOperatingActivities: NVDA_OCF_YTD }), [
        'NetCashProvidedByUsedInOperatingActivities',
      ]),
    );

    expect(quarters.map((q) => q.value)).toEqual([
      27_414_000_000, // Q1 累计即单季
      15_365_000_000,
      23_751_000_000,
      36_188_000_000,
    ]);
    expect(quarters.reduce((s, q) => s + q.value, 0)).toBe(102_718_000_000);
  });

  test('跨财年不串:新 start 的第一条不去减上一年的累计', () => {
    const quarters = toQuarters(
      collectPeriods(
        facts({
          NetCashProvidedByUsedInOperatingActivities: [
            ...NVDA_OCF_YTD,
            row('2026-01-26', '2026-04-26', 50_344_000_000, { filed: '2026-05-20' }),
          ],
        }),
        ['NetCashProvidedByUsedInOperatingActivities'],
      ),
    );

    expect(quarters.at(-1)).toMatchObject({ periodEnd: '2026-04-26', value: 50_344_000_000 });
  });

  test('直接单季行优先于差分(利润表两者并存时不重复计)', () => {
    const quarters = toQuarters(
      collectPeriods(
        facts({
          Revenues: [
            row('2025-01-27', '2025-04-27', 100),
            row('2025-04-28', '2025-07-27', 130), // 直接单季行
            row('2025-01-27', '2025-07-27', 230), // 同期 YTD
          ],
        }),
        ['Revenues'],
      ),
    );

    expect(quarters.map((q) => [q.periodEnd, q.value])).toEqual([
      ['2025-04-27', 100],
      ['2025-07-27', 130],
    ]);
  });
});

describe('tag 逐期 fallback', () => {
  test('稀疏 tag 排在前面也不会饿死后面的全历史 tag', () => {
    // 实测形态:RevenueFromContract... 只有 2017–2022,Revenues 才是全历史。
    const periods = collectPeriods(
      facts({
        RevenueFromContractWithCustomerExcludingAssessedTax: [row('2021-02-01', '2021-05-02', 5_661_000_000)],
        Revenues: [row('2021-02-01', '2021-05-02', 5_661_000_000), row('2025-01-27', '2025-04-27', 44_062_000_000)],
      }),
      ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'],
    );

    expect(periods).toHaveLength(2);
    expect(periods.map((p) => p.tag)).toEqual([
      'RevenueFromContractWithCustomerExcludingAssessedTax', // 重叠期靠前的 tag 占位
      'Revenues', // 只有它覆盖的期间照常进来
    ]);
  });

  test('只留 10-Q/10-K,丢弃 8-K 等', () => {
    const periods = collectPeriods(facts({ Revenues: [row('2025-01-27', '2025-04-27', 1, { form: '8-K' })] }), [
      'Revenues',
    ]);

    expect(periods).toEqual([]);
  });
});

describe('重述', () => {
  test('同 tag 同期间取 filed 最新的一条', () => {
    const periods = collectPeriods(
      facts({
        Revenues: [
          row('2025-01-27', '2025-04-27', 100, { filed: '2025-05-28', accn: 'old' }),
          row('2025-01-27', '2025-04-27', 111, { filed: '2026-05-20', accn: 'new' }),
        ],
      }),
      ['Revenues'],
    );

    expect(periods[0]).toMatchObject({ val: 111, accn: 'new' });
  });

  test('公司重述时换了 tag:filed 更新的胜出,不被靠前 tag 的旧值挡住', () => {
    const periods = collectPeriods(
      facts({
        Revenues: [row('2025-01-27', '2025-04-27', 100, { filed: '2025-05-28', accn: 'old' })],
        SalesRevenueNet: [row('2025-01-27', '2025-04-27', 111, { filed: '2026-05-20', accn: 'restated' })],
      }),
      ['Revenues', 'SalesRevenueNet'], // Revenues 在链里更靠前
    );

    expect(periods[0]).toMatchObject({ val: 111, accn: 'restated', tag: 'SalesRevenueNet' });
  });

  test('filed 相同则按 tag 链顺序定优先', () => {
    const periods = collectPeriods(
      facts({
        Revenues: [row('2025-01-27', '2025-04-27', 100)],
        SalesRevenueNet: [row('2025-01-27', '2025-04-27', 999)],
      }),
      ['Revenues', 'SalesRevenueNet'],
    );

    expect(periods[0]).toMatchObject({ val: 100, tag: 'Revenues' });
  });
});

test('日历季度按期间中点归:NVDA 11 月~1 月财季落 Q4', () => {
  expect(calendarQuarter('2025-10-27', '2026-01-25')).toBe('2025Q4');
  expect(calendarQuarter('2026-01-26', '2026-04-26')).toBe('2026Q1');
});

describe('TTM', () => {
  const q = (periodEnd: string, value: number) => ({ periodEnd, value, fiscalQ: periodEnd.slice(0, 4) });

  test('滚动四季相加', () => {
    const points = ttm([
      q('2025-04-27', 1),
      q('2025-07-27', 2),
      q('2025-10-26', 3),
      q('2026-01-25', 4),
      q('2026-04-26', 5),
    ]);

    expect(points).toEqual([
      { date: '2026-01-25', value: 10, fiscalQ: '2026' },
      { date: '2026-04-26', value: 14, fiscalQ: '2026' },
    ]);
  });

  test('中间缺季不出值(跨度超窗)', () => {
    expect(ttm([q('2024-04-27', 1), q('2025-07-27', 2), q('2025-10-26', 3), q('2026-01-25', 4)])).toEqual([]);
  });
});

test('派生量:毛利率百分点、金额百万美元、FCF 可负', () => {
  const mk = (concept: string, vals: number[]) =>
    ['2025-04-27', '2025-07-27', '2025-10-26', '2026-01-25'].map((periodEnd, i) => ({
      ticker: 'X',
      periodEnd,
      concept,
      value: vals[i]!,
      tagUsed: 't',
      form: '10-Q',
      accn: 'a',
      filed: 'f',
      fiscalQ: ['2025Q1', '2025Q2', '2025Q3', '2025Q4'][i]!,
    }));

  const { gmTtm, capexTtm, fcfTtm } = deriveSeries([
    ...mk('revenue', [100e6, 100e6, 100e6, 100e6]),
    ...mk('cogs', [40e6, 40e6, 40e6, 40e6]),
    ...mk('ocf', [10e6, 10e6, 10e6, 10e6]),
    ...mk('capex', [20e6, 20e6, 20e6, 20e6]),
  ]);

  expect(gmTtm).toEqual([{ date: '2026-01-25', value: 60, fiscalQ: '2025Q4' }]);
  expect(capexTtm.at(-1)).toMatchObject({ date: '2026-01-25', value: 80 });
  expect(fcfTtm.at(-1)).toMatchObject({ date: '2026-01-25', value: -40 });
});

describe('合计 FCF', () => {
  test('财年末不齐:按日历季度对齐,obs_date 取该季最晚的期末', () => {
    const points = aggregateFcf(
      new Map([
        // A 财年末 1 月底(NVDA 型):2026-01-31 那期归 2025Q4,与 B 的 12 月末同季。
        [
          'A',
          [
            { date: '2025-10-31', value: 10, fiscalQ: '2025Q3' },
            { date: '2026-01-31', value: 20, fiscalQ: '2025Q4' },
          ],
        ],
        ['B', [{ date: '2025-12-31', value: 100, fiscalQ: '2025Q4' }]],
      ]),
    );

    // 2025Q3 只有 A → 不出点;2025Q4 两家齐 → 出点,日期取 2026-01-31(更晚的那个)。
    expect(points).toEqual([{ date: '2026-01-31', value: 120 }]);
  });

  test('缺一家就不出点,且不拿旧值前向填充(防止停报后合计线看着还在更新)', () => {
    const points = aggregateFcf(
      new Map([
        [
          'A',
          [
            { date: '2025-03-31', value: 10, fiscalQ: '2025Q1' },
            { date: '2025-06-30', value: 20, fiscalQ: '2025Q2' },
          ],
        ],
        ['B', [{ date: '2025-03-31', value: 100, fiscalQ: '2025Q1' }]], // B 之后停报
      ]),
    );

    expect(points).toEqual([{ date: '2025-03-31', value: 110 }]);
  });

  test('空输入', () => {
    expect(aggregateFcf(new Map())).toEqual([]);
  });
});

test('extractFundamentals 打平四个科目', () => {
  const rows = extractFundamentals(
    'NVDA',
    facts({
      NetCashProvidedByUsedInOperatingActivities: NVDA_OCF_YTD,
      Revenues: [row('2025-01-27', '2025-04-27', 44_062_000_000)],
    }),
  );

  expect(new Set(rows.map((r) => r.concept))).toEqual(new Set(['ocf', 'revenue']));
  expect(rows.every((r) => r.ticker === 'NVDA' && r.tagUsed && r.accn)).toBe(true);
});
