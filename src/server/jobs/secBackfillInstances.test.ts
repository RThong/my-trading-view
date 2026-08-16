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

// 分部科目在 companyfacts 里**每一期都没有**,所以「缺口 = 任一 concept 缺」这条规则一旦
// 不带下界,公司开始披露该分部**之前**的每一期都会永远算成缺口:每轮都去拉那几十份实例
// (1~3MB 一份)、对这一档一行贡献都没有、下一轮原样再拉一遍,而「仍缺 N 处」恒不为零。
// 下界由 SEGMENT_FACTS.from 表达(GOOGL = 2020-03-31)。
describe('分部科目的缺口下界(回填必须收敛)', () => {
  const period = (periodEnd: string, concept: string) => ({
    ticker: 'GOOGL',
    periodEnd,
    concept,
    value: 1,
    tagUsed: 't',
    form: '10-Q',
    accn: 'cf',
    filed: '2021-01-01',
    fiscalQ: '',
  });

  /** 2019 与 2020 各一期,四个合并科目齐全;cloudRev 只有 2020 那期有(真实形态)。 */
  function seedGoogl(db: Database) {
    insertSecFundamentals(db, [
      ...['revenue', 'cogs', 'ocf', 'capex'].flatMap((c) => [period('2019-12-31', c), period('2020-03-31', c)]),
      period('2020-03-31', 'cloudRev'),
    ]);
  }

  const googlStub = (onPull: () => void) => ({
    latestFiling: async () => null,
    periodicFilings: async () => [
      { accn: 'a19', form: '10-K', filed: '2020-02-03', periodEnd: '2019-12-31' },
      { accn: 'a20', form: '10-Q', filed: '2020-04-28', periodEnd: '2020-03-31' },
    ],
    companyFacts: async () => ({}),
    filingInstance: async () => {
      onPull();
      return '<?xml version="1.0"?><xbrl xmlns="http://www.xbrl.org/2003/instance"></xbrl>';
    },
  });

  test('披露开始之前的期不算缺口 → 零下载、仍缺为空', async () => {
    const db = freshDb();
    seedGoogl(db);

    let pulls = 0;
    const r = await backfillFromInstances(db, 'GOOGL', { fetcher: googlStub(() => (pulls += 1)) as never });

    expect(pulls).toBe(0);
    expect(r.pulled).toEqual([]);
    // 2019-12-31 少 cloudRev 是**正常**的(那时 Cloud 还没单列),不该报进「仍缺」。
    expect(r.stillMissing).toEqual([]);
    db.close();
  });

  test('下界之后真缺就照样补 —— 别把守卫做成一律不报', async () => {
    const db = freshDb();
    seedGoogl(db);
    db.run(`DELETE FROM sec_fundamentals WHERE ticker='GOOGL' AND concept='cloudRev'`);

    let pulls = 0;
    const r = await backfillFromInstances(db, 'GOOGL', { fetcher: googlStub(() => (pulls += 1)) as never });

    expect(pulls).toBe(1); // 只拉 2020-03-31 那一份,2019 那份仍不拉
    expect(r.pulled).toEqual(['2020-03-31']);
    expect(r.stillMissing).toEqual(['2020-03-31.cloudRev']); // 空实例补不上 → 如实报
    db.close();
  });
});
