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
