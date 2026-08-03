import { describe, expect, test } from 'bun:test';
import {
  aggregateFcf,
  calendarQuarter,
  collectPeriods,
  deriveSeries,
  extractFundamentals,
  TAG_CHAINS,
  toQuarters,
  trailingContiguous,
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

describe('MU 黄金值(存储侧,tag 画像与 NVDA 完全不同)', () => {
  // MU 的 revenue 要三个 tag 缝起来才有全历史,且 CostOfRevenue 在 MU 根本不存在。
  // 实测值来自 data.sec.gov;Q3 FY2026 公司公布营收 41.5B、非 GAAP 毛利率 84.9%(GAAP 84.6%)。
  const MU_REV_YTD = [
    row('2025-08-29', '2025-11-27', 13_643_000_000, { filed: '2025-12-18' }),
    row('2025-08-29', '2026-02-26', 37_503_000_000, { filed: '2026-03-19' }),
    row('2025-08-29', '2026-05-28', 78_959_000_000, { filed: '2026-06-25' }),
  ];
  const MU_COGS_YTD = [
    row('2025-08-29', '2025-11-27', 5_997_000_000, { filed: '2025-12-18' }),
    row('2025-08-29', '2026-02-26', 12_102_000_000, { filed: '2026-03-19' }),
    row('2025-08-29', '2026-05-28', 18_502_000_000, { filed: '2026-06-25' }),
  ];

  test('YTD 差分还原出的单季与源里的直接单季行逐位一致', () => {
    const diffed = toQuarters(
      collectPeriods(facts({ RevenueFromContractWithCustomerExcludingAssessedTax: MU_REV_YTD }), [
        'RevenueFromContractWithCustomerExcludingAssessedTax',
      ]),
    );

    // 78.959 − 37.503 = 41.456,与 SEC 里那条 start=2026-02-27 的直接单季行相同。
    expect(diffed.map((q) => [q.periodEnd, q.value])).toEqual([
      ['2025-11-27', 13_643_000_000],
      ['2026-02-26', 23_860_000_000],
      ['2026-05-28', 41_456_000_000],
    ]);
  });

  test('cogs 走 CostOfGoodsAndServicesSold(MU 没有 CostOfRevenue),毛利率 84.6%', () => {
    const muFacts = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: MU_REV_YTD,
      CostOfGoodsAndServicesSold: MU_COGS_YTD,
    });
    const rows = extractFundamentals('MU', muFacts);
    const q3 = (concept: string) => rows.find((r) => r.concept === concept && r.periodEnd === '2026-05-28')!;

    expect(q3('cogs').tagUsed).toBe('CostOfGoodsAndServicesSold');
    expect(q3('revenue').value).toBe(41_456_000_000);
    expect(q3('cogs').value).toBe(6_400_000_000);

    const gm = ((q3('revenue').value - q3('cogs').value) / q3('revenue').value) * 100;
    expect(gm).toBeCloseTo(84.56, 2);
  });

  test('ocf 也跨两个 tag:老年份走 ...ContinuingOperations,新年份走主 tag', () => {
    // MU 实测:2011-09~2016-06 那 16 期走的是 ...ContinuingOperations。链里少这一档,
    // 那几年的 ocf 全没,FCF 会被 trailingContiguous 裁到 2017 之后而无人察觉。
    const stitched = collectPeriods(
      facts({
        NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: [
          row('2015-09-04', '2015-12-03', 1_500_000_000, { filed: '2016-01-07' }),
        ],
        NetCashProvidedByUsedInOperatingActivities: [
          row('2025-08-29', '2025-11-27', 5_000_000_000, { filed: '2025-12-18' }),
        ],
      }),
      TAG_CHAINS.ocf, // 走生产链:少一档 tag 这条测试就红
    );

    expect(stitched.map((p) => [p.end, p.tag])).toEqual([
      ['2015-12-03', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
      ['2025-11-27', 'NetCashProvidedByUsedInOperatingActivities'],
    ]);
  });

  test('capex 的第二档也在链里:PaymentsToAcquireProductiveAssets(NVDA 近年走它)', () => {
    const stitched = collectPeriods(
      facts({
        PaymentsToAcquireProductiveAssets: [row('2025-01-27', '2025-04-27', 1_230_000_000)],
      }),
      TAG_CHAINS.capex,
    );

    expect(stitched.map((p) => p.tag)).toEqual(['PaymentsToAcquireProductiveAssets']);
  });

  test('三个 revenue tag 逐期缝成一条:各段都进来,重叠期不重复', () => {
    const stitched = collectPeriods(
      facts({
        SalesRevenueNet: [row('2016-06-03', '2016-09-01', 3_217_000_000, { filed: '2016-10-01' })],
        Revenues: [row('2016-12-02', '2017-03-02', 4_648_000_000, { filed: '2017-04-01' })],
        RevenueFromContractWithCustomerExcludingAssessedTax: [MU_REV_YTD[0]!],
      }),
      TAG_CHAINS.revenue, // 走生产链:少一档 tag 这条测试就红
    );

    expect(stitched.map((p) => [p.end, p.tag])).toEqual([
      ['2016-09-01', 'SalesRevenueNet'],
      ['2017-03-02', 'Revenues'],
      ['2025-11-27', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
    ]);
  });
});

describe('tag 链的内容本身', () => {
  // 期望清单**写死**,不能遍历 TAG_CHAINS —— 遍历是自指的:某档被删掉,循环就不测它,测试照样绿。
  // 实测过这个后果:少了 SalesRevenueNet,MU 的 revenue 直接丢掉 2008–2016 整段而没人发现。
  // 故意改链时这条会红,那正是它的用途:提醒你顺手确认「哪些公司靠这一档」。
  const EXPECTED: Record<string, string[]> = {
    revenue: [
      'Revenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
    ],
    cogs: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
    ocf: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
    capex: [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
      'PaymentsToAcquireOtherPropertyPlantAndEquipment',
    ],
  };

  test('四条链一档不少(删档即红)', () => {
    expect(TAG_CHAINS).toEqual(EXPECTED);
  });

  test('每一档单独出现时都能被命中(用生产链跑,删档即命中不到)', () => {
    for (const [concept, chain] of Object.entries(EXPECTED)) {
      const live = TAG_CHAINS[concept as keyof typeof TAG_CHAINS];
      for (const tag of chain) {
        const hit = collectPeriods(facts({ [tag]: [row('2025-01-27', '2025-04-27', 1)] }), live).map((p) => p.tag);
        expect(hit, `${concept} 的 ${tag} 应被生产链命中`).toEqual([tag]);
      }
    }
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

describe('尾部连续段裁剪', () => {
  const p = (date: string) => ({ date, value: 1 });

  test('孤岛段裁掉,只留最后一段连续的', () => {
    // NVDA 实测形态:2012 四点 → 隔 9 年 → 2022-01-30 → 隔 21 个月 → 2023-10 起才真连续。
    expect(
      trailingContiguous([p('2012-01-29'), p('2012-04-29'), p('2022-01-30'), p('2023-10-29'), p('2024-01-28')]).map(
        (x) => x.date,
      ),
    ).toEqual(['2023-10-29', '2024-01-28']);
  });

  test('缺一个季度(约 182 天)就断开 —— 阈值不能放宽到「多留点历史」', () => {
    // 这条锁的是 maxGapDays:调到 200 会让「缺一季」的断档蒙混过关,图上多出一段假斜率。
    expect(trailingContiguous([p('2025-01-31'), p('2025-07-31'), p('2025-10-31')]).map((x) => x.date)).toEqual([
      '2025-07-31',
      '2025-10-31',
    ]);
  });

  test('全程连续则原样返回(MU 那种)', () => {
    const s = [p('2025-04-27'), p('2025-07-27'), p('2025-10-26')];
    expect(trailingContiguous(s)).toEqual(s);
  });

  test('空序列不炸', () => {
    expect(trailingContiguous([])).toEqual([]);
  });
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
