import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  aggregateFcf,
  calendarQuarter,
  collectPeriods,
  deriveSeries,
  extractFundamentals,
  parseXbrlInstance,
  mergeFacts,
  segmentCumulativeFill,
  TAG_CHAINS,
  capexScopeOf,
  tagConflicts,
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
    // 链序 = 口径优先级(靠前的赢)。已排除的三档都是「子项 / 含税」不是总额:
    // CostOfGoodsSold(不含服务)、RevenueFromContract…IncludingAssessedTax(含代收税款)、
    // PaymentsToAcquireOtherPropertyPlantAndEquipment(PP&E 的「其他」子项)。
    revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
    cogs: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
    // ocf 是**总额在前**。试过反过来(为对齐只含持续经营的 capex),更糟:持续经营那个 tag
    // 「有终止经营才报」,AMD 的 Q1 就没有 → 逐期 fallback 会在同一个差分组里换基础。见 TAG_CHAINS.ocf。
    ocf: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
    capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
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

  test('**跨 tag 不比 filed**:链序(口径优先级)赢,filed 再新也不能换口径', () => {
    // filed 解决版本、tag 解决口径,不能用一个比较器裁决。实测反例:AMZN FY2016 的
    // PaymentsToAcquirePropertyPlantAndEquipment 6.737B(filed 2017-02-10)对
    // PaymentsToAcquireProductiveAssets 7.804B(filed 2019-02-01)—— 后者含自用软件,
    // 是另一个口径而不是同一个数的新版本;按 filed 挑就会在序列中间悄悄换口径。
    const periods = collectPeriods(
      facts({
        Revenues: [row('2025-01-27', '2025-04-27', 100, { filed: '2025-05-28', accn: 'chosen' })],
        SalesRevenueNet: [row('2025-01-27', '2025-04-27', 111, { filed: '2026-05-20', accn: 'newer-but-other-scope' })],
      }),
      ['Revenues', 'SalesRevenueNet'], // Revenues 在链里更靠前
    );

    expect(periods[0]).toMatchObject({ val: 100, accn: 'chosen', tag: 'Revenues' });
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

describe('派生量', () => {
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

  test('毛利率百分点、金额百万美元、FCF 可负', () => {
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

  // ORCL 实测形态:CostOfRevenue 在 2009 那几期被标成恰好 0(当季实际约 15 亿),
  // 差分出的 0−0 也是 0。照单全收会让 TTM 成本少一截、毛利率虚高,而且**不报错**。
  test('恰好为 0 的科目行不进派生 —— 宁可断档,不要一条虚高的毛利率', () => {
    const { gmTtm } = deriveSeries([
      ...mk('revenue', [100e6, 100e6, 100e6, 100e6]),
      ...mk('cogs', [40e6, 0, 40e6, 40e6]),
    ]);

    // 收下那个 0 会算出 70%(真值 60%)。丢掉它 → 成本只剩三季 → TTM 无窗口 → 断档。
    expect(gmTtm).toEqual([]);
  });
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

describe('tagConflicts(同期两 tag 值不一致)', () => {
  const both = (a: number, b: number, filedA = '2025-05-28', filedB = '2026-05-20') =>
    facts({
      Revenues: [row('2025-01-27', '2025-04-27', a, { filed: filedA })],
      SalesRevenueNet: [row('2025-01-27', '2025-04-27', b, { filed: filedB })],
    });

  test('值不一致就报,并指出取的是哪个', () => {
    const cs = tagConflicts(both(100, 111));

    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ concept: 'revenue', period: '2025-01-27~2025-04-27' });
    expect(cs[0]!.a.tag).toBe('Revenues'); // a = 实际取的(链序优先)
    expect(cs[0]!.b.tag).toBe('SalesRevenueNet');
  });

  test('值一致不报 —— 那只是同一个数换了 tag,不是换口径', () => {
    expect(tagConflicts(both(100, 100))).toEqual([]);
  });

  test('只看最近 8 个季度:更早的冲突不报(否则会把真信号淹掉)', () => {
    // 实测 ORCL 有 17 期 Revenues vs SalesRevenueNet 冲突,全在 2011 年前。
    const old = facts({
      Revenues: [
        row('2010-01-01', '2010-03-31', 100, { filed: '2010-05-01' }),
        row('2025-01-27', '2025-04-27', 500), // 最新期末,窗口基准
      ],
      SalesRevenueNet: [row('2010-01-01', '2010-03-31', 0, { filed: '2011-05-01' })],
    });

    expect(tagConflicts(old)).toEqual([]);
  });

  test('链首那档缺失时,后两档之间的冲突也要能查到(AMZN 没有 Revenues)', () => {
    const noHead = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [row('2025-01-27', '2025-04-27', 100)],
      SalesRevenueNet: [row('2025-01-27', '2025-04-27', 111, { filed: '2026-05-20' })],
    });

    expect(tagConflicts(noHead)).toHaveLength(1);
  });
});

describe('capexScopeOf', () => {
  test('两档 capex 是两个口径,不是同义词', () => {
    expect(capexScopeOf('PaymentsToAcquirePropertyPlantAndEquipment')).toBe('ppe');
    // NVDA 那行原文含 intangible assets、AMZN 含自用软件 → 同样的生意会显得更重、FCF 更低。
    expect(capexScopeOf('PaymentsToAcquireProductiveAssets')).toBe('productive_assets');
    expect(capexScopeOf('SomethingElse')).toBeUndefined();
  });
});

describe('parseXbrlInstance / mergeFacts(申报实例兜底)', () => {
  // 真实片段:META 2026Q2 10-Q(accession 0001628280-26-050705)的实例摘录 ——
  // 保留了真命名空间、真 context id、以及两个带 <segment> 的反例 context。
  const xml = readFileSync(new URL('./__fixtures__/meta-20260630-excerpt.xml', import.meta.url), 'utf8');
  const META_FILING = { accn: '0001628280-26-050705', form: '10-Q', filed: '2026-07-30' };

  test('只收无维度的 duration context —— 分部数据不能混进合并口径', () => {
    const facts = parseXbrlInstance(xml, META_FILING);
    const revenue = facts.facts!['us-gaap']!.RevenueFromContractWithCustomerExcludingAssessedTax!.units!.USD!;
    const vals = new Set(revenue.map((r) => r.val));

    expect(vals.has(60_801_000_000)).toBe(true); // 合并口径的本季收入
    // 59.363B 是「广告」分部那条(带 explicitMember)。漏掉维度过滤就会与总额争同一期间。
    expect(vals.has(59_363_000_000)).toBe(false);
  });

  test('unit 按 iso4217:USD 认,不靠 id 命名(实测 META 用 usd、MSFT 用 U_USD)', () => {
    const facts = parseXbrlInstance(xml, META_FILING);
    // 换成别的 id 名照样要能认出来 —— 只改命名不改口径。
    const renamed = parseXbrlInstance(xml.replace(/"usd"/g, '"U_USD"'), META_FILING);
    expect(Object.keys(renamed.facts!['us-gaap']!)).toEqual(Object.keys(facts.facts!['us-gaap']!));
  });

  test('与 companyfacts 合并后算出本季:现金流只有累计,减掉的上一季来自 companyfacts', () => {
    // 实例里现金流只有 H1(2026-01-01~06-30);Q1 在 companyfacts 里。分开算得不出 Q2。
    const q1 = (val: number) => ({
      units: {
        USD: [{ start: '2026-01-01', end: '2026-03-31', val, accn: 'q1', form: '10-Q', filed: '2026-04-30' }],
      },
    });
    const companyFacts = {
      facts: {
        'us-gaap': {
          NetCashProvidedByUsedInOperatingActivities: q1(32_226_000_000),
          PaymentsToAcquirePropertyPlantAndEquipment: q1(18_997_000_000),
        },
      },
    };

    const onlyInstance = extractFundamentals('META', parseXbrlInstance(xml, META_FILING));
    expect(onlyInstance.find((r) => r.periodEnd === '2026-06-30' && r.concept === 'ocf')).toBeUndefined();

    const merged = extractFundamentals('META', mergeFacts(companyFacts, parseXbrlInstance(xml, META_FILING)));
    const q2 = (concept: string) => merged.find((r) => r.periodEnd === '2026-06-30' && r.concept === concept)?.value;

    expect(q2('ocf')).toBe(64_088_000_000 - 32_226_000_000); // 31.862B
    expect(q2('capex')).toBe(49_113_000_000 - 18_997_000_000); // 30.116B
    expect(q2('revenue')).toBe(60_801_000_000); // 利润表本来就有单季行,不用差分
  });

  test('mergeFacts 不覆盖 companyfacts 的重述值:同期取 filed 最大', () => {
    const row = (val: number, filed: string) => ({
      units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val, accn: `a-${filed}`, form: '10-Q', filed }] },
    });
    const older = { facts: { 'us-gaap': { Revenues: row(100, '2026-04-30') } } };
    const newer = { facts: { 'us-gaap': { Revenues: row(111, '2026-07-30') } } };

    // 合并顺序不该影响结果 —— 裁决靠 filed,不靠谁先进数组。
    expect(collectPeriods(mergeFacts(older, newer), ['Revenues'])[0]!.val).toBe(111);
    expect(collectPeriods(mergeFacts(newer, older), ['Revenues'])[0]!.val).toBe(111);
  });
});

describe('分部科目(segment)—— GOOGL 2026Q2 实测形态', () => {
  // 真实片段:GOOGL 2026Q2 10-Q(accession 0001652044-26-000071)里**期末 = 2026-06-30** 的
  // 全部收入事实与它们的 context。逐位数过:
  //  · `RevenueFromContractWithCustomerExcludingAssessedTax` 30 条,**一条无维度的都没有** ——
  //    Alphabet 的合并收入不用这个元素,它全部用来标分部 / 产品线 / 地区拆分。
  //  · `Revenues` 12 条,其中 10 条无维度(值只有本季 119.796B 与本年累计 229.692B 两种)。
  // 也就是说合并口径与分部口径**分别落在两个元素上**,但分部那个元素同时被两种口径用
  // (2026Q2 那 30 条里既有 Cloud 也有 Services × 产品线),所以只有 context 分得开。
  const xml = readFileSync(new URL('./__fixtures__/googl-20260630-excerpt.xml', import.meta.url), 'utf8');
  const FILING = { accn: '0001652044-26-000071', form: '10-Q', filed: '2026-07-23' };
  const CLOUD = [
    {
      concept: 'cloudRev' as const,
      element: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
      axis: 'us-gaap:StatementBusinessSegmentsAxis',
      members: ['goog:GoogleCloudMember'],
      from: '2020-03-31',
      label: 'Google Cloud',
    },
  ];

  test('云收入进 cloudRev,合并口径的收入不受影响(黄金值:24.768B / 119.796B)', () => {
    const rows = extractFundamentals('GOOGL', parseXbrlInstance(xml, FILING, {}, CLOUD));
    const q2 = (c: string) => rows.find((r) => r.periodEnd === '2026-06-30' && r.concept === c)?.value;

    expect(q2('cloudRev')).toBe(24_768_000_000);
    expect(q2('revenue')).toBe(119_796_000_000);
  });

  test('members 列多个成员名 = 公司改过名也接得上(实测 2022Q1 及更早叫 …SegmentMember)', () => {
    const bothNames = [{ ...CLOUD[0]!, members: ['goog:GoogleCloudMember', 'goog:GoogleCloudSegmentMember'] }];
    const renamed = xml.replaceAll('goog:GoogleCloudMember', 'goog:GoogleCloudSegmentMember');
    const cloudOf = (x: string, segs: typeof CLOUD) =>
      extractFundamentals('GOOGL', parseXbrlInstance(x, FILING, {}, segs)).find((r) => r.concept === 'cloudRev')?.value;

    expect(cloudOf(xml, bothNames)).toBe(24_768_000_000);
    expect(cloudOf(renamed, bothNames)).toBe(24_768_000_000);
    // 只列新名字 → 旧名字那批静默消失。这正是「members 是数组」要防的那件事。
    expect(cloudOf(renamed, CLOUD)).toBeUndefined();
  });

  test('不传 segments 就一行分部数据都不收 —— 别家的解析行为一个字节都没变', () => {
    const rows = extractFundamentals('GOOGL', parseXbrlInstance(xml, FILING));
    expect(rows.some((r) => r.concept === 'cloudRev')).toBe(false);
    expect(rows.find((r) => r.periodEnd === '2026-06-30' && r.concept === 'revenue')?.value).toBe(119_796_000_000);
  });

  test('只放行点名的那个成员:别的分部 / 地区 / 产品线不许混进来', () => {
    const facts = parseXbrlInstance(xml, FILING, {}, CLOUD);
    const vals = new Set(facts.facts!['us-gaap']!.SegmentCloudRevenue!.units!.USD!.map((r) => r.val));

    // 本季 24.768B + 本年累计 44.796B,就这两条(同一个 context 在实例里被两处引用,值相同)。
    expect([...vals].sort((a, b) => a - b)).toEqual([24_768_000_000, 44_796_000_000]);
    // 反例都在同一份实例里:Google Services 分部本季 94.540B、美国地区本季 60.846B ——
    // 混进来不会报错,只会让「云收入」悄悄变成别的东西。
    expect(vals.has(94_540_000_000)).toBe(false);
    expect(vals.has(60_846_000_000)).toBe(false);
  });

  test('维度轴也要对上:同名成员挂在别的轴上不算数', () => {
    // 实例里 srt:ProductOrServiceAxis 装的是产品线拆分(搜索/YouTube/订阅…)。只比成员名的话,
    // 公司哪天在那根轴上也放一个同名成员,就会静默取到另一个数。
    const wrongAxis = xml.replaceAll(
      'dimension="us-gaap:StatementBusinessSegmentsAxis">goog:GoogleCloudMember',
      'dimension="srt:ProductOrServiceAxis">goog:GoogleCloudMember',
    );
    const facts = parseXbrlInstance(wrongAxis, FILING, {}, CLOUD);

    expect(facts.facts!['us-gaap']!.SegmentCloudRevenue).toBeUndefined();
  });

  test('二级拆分(Cloud × 地区)一律不收 —— 它与总数同 tag 混进去,差分出来是错的', () => {
    const twoAxes = xml.replace(
      '<xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">goog:GoogleCloudMember</xbrldi:explicitMember>',
      '<xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">goog:GoogleCloudMember</xbrldi:explicitMember>' +
        '<xbrldi:explicitMember dimension="srt:StatementGeographicalAxis">country:US</xbrldi:explicitMember>',
    );
    const facts = parseXbrlInstance(twoAxes, FILING, {}, CLOUD);
    const vals = facts.facts!['us-gaap']!.SegmentCloudRevenue!.units!.USD!.map((r) => r.val);

    expect(vals).not.toContain(24_768_000_000); // 被改造的那条是本季 —— 多一个维度就不该收
  });

  // 「认不出来的维度」绝不能等同于「没有维度」。改动前是「带 <segment> 一律不收」,不存在这个面;
  // 放行分部之后,任何没被 explicitMember 正则捕到的维度声明都会让 context 看起来是纯 Cloud。
  test.each([
    [
      'typedMember(typed 维度,正则完全不认)',
      '<xbrldi:typedMember dimension="goog:SomeAxis"><x>1</x></xbrldi:typedMember>',
    ],
    [
      'dimension 等号旁带空格(合法 XML)',
      '<xbrldi:explicitMember dimension = "goog:SomeAxis">goog:SomeMember</xbrldi:explicitMember>',
    ],
    // 单引号这一支要的是「两条正则的引号规则一致」:一条认一条不认,失败关闭的闸门会反过来
    // 把带维度的 context 当成合并口径,污染的是四个核心科目那一侧,面更大。
    [
      '单引号属性(合法 XML)',
      "<xbrldi:explicitMember dimension='goog:SomeAxis'>goog:SomeMember</xbrldi:explicitMember>",
    ],
  ])('未知维度声明 → 整条拒收,不是当成没有维度(%s)', (_name, extra) => {
    const sneaky = xml.replaceAll(
      '<xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">goog:GoogleCloudMember</xbrldi:explicitMember>',
      `<xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">goog:GoogleCloudMember</xbrldi:explicitMember>${extra}`,
    );

    expect(parseXbrlInstance(sneaky, FILING, {}, CLOUD).facts!['us-gaap']!.SegmentCloudRevenue).toBeUndefined();
  });

  // 实测 GOOGL 2025 10-K(accession 0001652044-26-000018):Cloud 只有 2023/2024/2025 三条**全年**,
  // 没有 9M、也没有单季 Q4。减掉的那条 9M 只存在于 Q3 那份 10-Q 的实例里,而 companyfacts
  // 永远没有分部数据、库里存的又是已差分的单季行 —— 不补这一步,每年 Q4 都算不出来。
  describe('segmentCumulativeFill:10-K 只给全年时,用库里的单季行还原 9M', () => {
    const stored = (periodEnd: string, value: number, filed: string) => ({
      ticker: 'GOOGL',
      concept: 'cloudRev',
      periodEnd,
      value,
      tagUsed: 'SegmentCloudRevenue',
      form: '10-Q',
      accn: `a-${filed}`,
      filed,
      fiscalQ: '',
    });
    const Q1_Q3 = [
      stored('2025-03-31', 12_260_000_000, '2025-04-25'),
      stored('2025-06-30', 13_624_000_000, '2025-07-24'),
      stored('2025-09-30', 15_157_000_000, '2025-10-30'),
    ];
    // 真实 10-K 实例摘录(accession 0001652044-26-000018),期末 2025-12-31 的全部收入事实。
    // 用它而不是手搓 facts:这条路径一年只走一次,而它的**前提**(10-K 里 Cloud 只有全年)
    // 恰恰得由真实实例来证 —— 手搓输入等于把前提写进测试,上游 durationContexts 抽不出来也照样绿。
    const K10_XML = readFileSync(new URL('./__fixtures__/googl-20251231-10k-excerpt.xml', import.meta.url), 'utf8');
    const K10_FILING = { accn: '0001652044-26-000018', form: '10-K', filed: '2026-02-05' };
    const fy = (val: number) =>
      facts({
        SegmentCloudRevenue: [
          { start: '2025-01-01', end: '2025-12-31', val, accn: 'k-1', form: '10-K', filed: '2026-02-05' },
        ],
      });

    test('前提成立:10-K 实例里 Cloud 只有全年三条,既没有 9M 也没有单季 Q4', () => {
      const parsed = parseXbrlInstance(K10_XML, K10_FILING, {}, CLOUD);
      const rows = parsed.facts!['us-gaap']!.SegmentCloudRevenue!.units!.USD!;
      const spans = [...new Set(rows.map((r) => `${r.start}~${r.end}`))].sort();

      expect(spans).toEqual(['2023-01-01~2023-12-31', '2024-01-01~2024-12-31', '2025-01-01~2025-12-31']);
      // 全年 58.705B 抽对了;而单独解析这份 10-K **一个 Q4 都出不来**(没有 9M 可减)——
      // 这就是 segmentCumulativeFill 存在的全部理由。
      expect(rows.find((r) => r.end === '2025-12-31')?.val).toBe(58_705_000_000);
      expect(extractFundamentals('GOOGL', parsed).some((r) => r.concept === 'cloudRev')).toBe(false);
    });

    test('真实 10-K + 库里的 Q1~Q3 → Q4 17.664B(黄金值)', () => {
      const k10 = parseXbrlInstance(K10_XML, K10_FILING, {}, CLOUD);
      const rows = extractFundamentals('GOOGL', mergeFacts(k10, segmentCumulativeFill(k10, Q1_Q3)));

      expect(rows.find((r) => r.periodEnd === '2025-12-31')?.value).toBe(17_664_000_000);
    });

    test('全年 58.705B − 还原出的 9M 41.041B = Q4 17.664B(黄金值)', () => {
      const k10 = fy(58_705_000_000);
      const rows = extractFundamentals('GOOGL', mergeFacts(k10, segmentCumulativeFill(k10, Q1_Q3)));

      expect(rows.find((r) => r.periodEnd === '2025-12-31')?.value).toBe(17_664_000_000);
    });

    test('缺任一季就不合成 —— 宁可缺一格,不可拿两季当三季', () => {
      const k10 = fy(58_705_000_000);
      const holed = [Q1_Q3[0]!, Q1_Q3[2]!]; // 缺 Q2

      expect(segmentCumulativeFill(k10, holed).facts!['us-gaap']!.SegmentCloudRevenue).toBeUndefined();
      // 最后一季也缺 → 到年末差两个季度,同样不合成
      expect(segmentCumulativeFill(k10, Q1_Q3.slice(0, 2)).facts!['us-gaap']!.SegmentCloudRevenue).toBeUndefined();
    });

    test('库里没有分部行(其余 11 家的常态)→ 什么都不合成', () => {
      expect(segmentCumulativeFill(fy(58_705_000_000), []).facts!['us-gaap']).toEqual({});
    });
  });

  test('capex/云收入是单季比单季;没有云收入的公司这条恒为空(不画假线)', () => {
    const q = (concept: string, periodEnd: string, value: number) => ({
      ticker: 'GOOGL',
      concept,
      periodEnd,
      value,
      tagUsed: 't',
      form: '10-Q',
      accn: 'a',
      filed: '2026-07-23',
      fiscalQ: '2026Q2',
    });
    const googl = [q('capex', '2026-06-30', 44_920_000_000), q('cloudRev', '2026-06-30', 24_768_000_000)];

    expect(deriveSeries(googl).capexCloud).toEqual([
      { date: '2026-06-30', value: 44_920_000_000 / 24_768_000_000, fiscalQ: '2026Q2' }, // ≈1.81
    ]);
    // 只有 capex 没有云收入(其余四家买方就是这个形态)→ combine 对不齐 → 空数组
    expect(deriveSeries([googl[0]!]).capexCloud).toEqual([]);
  });
});

describe('ocf 两档并存(终止经营)—— AMD FY2025 实测形态', () => {
  // 真实数据(companyfacts,filed 2026-08-05 / 2026-05-06):
  //   总额:Q1 0.939B、H1 2.950B      持续经营:Q1 **不报**、H1 2.401B(差额 0.549B = 终止经营 OCF)
  //   capex(us-gaap,只含持续经营):Q1 0.212B、H1 0.494B
  const amdShape = facts({
    NetCashProvidedByUsedInOperatingActivities: [
      row('2024-12-29', '2025-03-29', 939_000_000),
      row('2024-12-29', '2025-06-28', 2_950_000_000),
    ],
    // 注意:持续经营那档没有 Q1 —— 它是「有终止经营才报」,所以报得不全。
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: [row('2024-12-29', '2025-06-28', 2_401_000_000)],
    PaymentsToAcquirePropertyPlantAndEquipment: [
      row('2024-12-29', '2025-03-29', 212_000_000),
      row('2024-12-29', '2025-06-28', 494_000_000),
    ],
  });

  test('整条线一致用总额:Q2 = 2.950 − 0.939,不会和只报了 H1 的持续经营那档串基础', () => {
    const rows = extractFundamentals('AMD', amdShape);
    const q2 = (c: string) => rows.find((r) => r.concept === c && r.periodEnd === '2025-06-28')!;

    expect(q2('ocf').tagUsed).toBe('NetCashProvidedByUsedInOperatingActivities');
    expect(q2('ocf').value).toBe(2_011_000_000); // 2.950 − 0.939
    expect(q2('capex').value).toBe(282_000_000); // 0.494 − 0.212
    expect(q2('ocf').value - q2('capex').value).toBe(1_729_000_000); // 与库里 AMD 单季 FCF 一致

    // 反过来排(持续经营在前)会取 2.401 − 0.939 = 1.462B:H1 用持续、Q1 用总额,
    // 同一个差分组里换了基础。这条断言就是为了别再改回去。
    expect(q2('ocf').value).not.toBe(1_462_000_000);
  });

  test('这一对的差额不报冲突 —— 差额恒等于终止经营 OCF,不是「口径变了」', () => {
    expect(tagConflicts(amdShape)).toEqual([]);
  });

  test('豁免只覆盖这一对:revenue 两档不一致仍要报', () => {
    const clash = facts({
      Revenues: [row('2024-12-29', '2025-06-28', 100)],
      SalesRevenueNet: [row('2024-12-29', '2025-06-28', 90)],
    });
    expect(tagConflicts(clash).map((c) => c.concept)).toEqual(['revenue']);
  });
});
