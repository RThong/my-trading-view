import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getSecFundamentals, insertSecFundamentals } from '../storage/repository';
import { backfillFromInstances } from './secBackfillInstances';
import type { CompanyFacts } from '../analytics/secFundamentals';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/**
 * 真实形态(NVDA FY2023):companyfacts 里 revenue/cogs/ocf 三科目齐全,唯独 capex 那几期
 * 消失了 —— 公司把它标成了自定义概念 `nvda:PurchasesOfPropertyAndEquipmentAndIntangibleAssets`,
 * 而 companyfacts 只聚合标准 taxonomy。
 */
const ytd = (tag: string, vals: Array<[string, number]>) => ({
  units: {
    USD: vals.map(([end, val]) => ({ start: '2022-01-31', end, val, accn: 'cf', form: '10-Q', filed: '2022-11-18' })),
  },
});

const FACTS: CompanyFacts = {
  facts: {
    'us-gaap': {
      Revenues: ytd('Revenues', [
        ['2022-05-01', 8_288e6],
        ['2022-07-31', 15_992e6],
      ]),
      CostOfRevenue: ytd('CostOfRevenue', [
        ['2022-05-01', 2_857e6],
        ['2022-07-31', 6_646e6],
      ]),
      NetCashProvidedByUsedInOperatingActivities: ytd('ocf', [
        ['2022-05-01', 1_731e6],
        ['2022-07-31', 3_001e6],
      ]),
      // capex:一期都没有 —— 这正是要回填的缺口
    },
  },
};

/** 只含 extension 那个元素的实例(结构照真实 inline XBRL 抽出来的最小片段)。 */
const instance = (end: string, val: number) => `<?xml version="1.0"?>
<xbrl xmlns:us-gaap="http://fasb.org/us-gaap" xmlns:nvda="http://nvidia.com">
  <context id="c1"><period><startDate>2022-01-31</startDate><endDate>${end}</endDate></period></context>
  <unit id="usd"><measure>iso4217:USD</measure></unit>
  <nvda:PurchasesOfPropertyAndEquipmentAndIntangibleAssets contextRef="c1" unitRef="usd">${val}</nvda:PurchasesOfPropertyAndEquipmentAndIntangibleAssets>
</xbrl>`;

const INSTANCES: Record<string, string> = {
  q1: instance('2022-05-01', 361e6),
  q2: instance('2022-07-31', 721e6),
};

const stub = {
  latestFiling: async () => null,
  periodicFilings: async () => [
    { accn: 'q1', form: '10-Q', filed: '2022-05-27', periodEnd: '2022-05-01' },
    { accn: 'q2', form: '10-Q', filed: '2022-08-31', periodEnd: '2022-07-31' },
  ],
  companyFacts: async () => FACTS,
  filingInstance: async (_cik: string, accn: string) => INSTANCES[accn]!,
};

/** 先把 companyfacts 那三科目落进库,制造出「capex 有洞」的真实起点。 */
function seed(db: Database) {
  insertSecFundamentals(
    db,
    (['revenue', 'cogs', 'ocf'] as const).flatMap((concept) =>
      ['2022-05-01', '2022-07-31'].map((periodEnd) => ({
        ticker: 'NVDA',
        periodEnd,
        concept,
        value: 1,
        tagUsed: 't',
        form: '10-Q',
        accn: 'cf',
        filed: '2022-11-18',
        fiscalQ: '2022Q2',
      })),
    ),
  );
}

describe('backfillFromInstances', () => {
  test('companyfacts 缺的 capex 从 extension 概念补回来', async () => {
    const db = freshDb();
    seed(db);
    expect(getSecFundamentals(db, 'NVDA').filter((r) => r.concept === 'capex')).toHaveLength(0);

    const r = await backfillFromInstances(db, 'NVDA', { fetcher: stub as never });

    expect(r.pulled).toEqual(['2022-05-01', '2022-07-31']);
    const capex = getSecFundamentals(db, 'NVDA').filter((r) => r.concept === 'capex');
    // Q1 直接单季(90 天);Q2 由 721 − 361 差分还原。
    expect(capex.map((c) => [c.periodEnd, c.value])).toEqual([
      ['2022-05-01', 361e6],
      ['2022-07-31', 360e6],
    ]);
    expect(r.stillMissing).toEqual([]);
    db.close();
  });

  test('只拉真的缺的那几份 —— 没有缺口就一个实例都不拉', async () => {
    const db = freshDb();
    seed(db);
    // 把 capex 也补齐 → 无缺口
    insertSecFundamentals(
      db,
      ['2022-05-01', '2022-07-31'].map((periodEnd) => ({
        ticker: 'NVDA',
        periodEnd,
        concept: 'capex',
        value: 1,
        tagUsed: 't',
        form: '10-Q',
        accn: 'cf',
        filed: '2022-11-18',
        fiscalQ: '2022Q2',
      })),
    );

    let pulls = 0;
    const counting = {
      ...stub,
      filingInstance: async (c: string, a: string) => {
        pulls += 1;
        return INSTANCES[a]!;
      },
    };
    const r = await backfillFromInstances(db, 'NVDA', { fetcher: counting as never });

    expect(pulls).toBe(0); // 实例 1~2MB,没缺口就不该白拉
    expect(r.pulled).toEqual([]);
    db.close();
  });
});
