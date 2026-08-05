import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, getSecFundamentals } from '../storage/repository';
import { updateSecFundamentals } from './secFundamentals';
import type { CompanyFacts } from '../analytics/secFundamentals';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

// 一年四期 YTD(四个科目齐全),够算出一个 TTM 点。四期累计 → 单季各为 1/4。
const ytd = (vals: [number, number, number, number]) => ({
  units: {
    USD: [
      { start: '2025-01-27', end: '2025-04-27', val: vals[0], accn: 'a', form: '10-Q', filed: '2025-05-28' },
      { start: '2025-01-27', end: '2025-07-27', val: vals[1], accn: 'b', form: '10-Q', filed: '2025-08-27' },
      { start: '2025-01-27', end: '2025-10-26', val: vals[2], accn: 'c', form: '10-Q', filed: '2025-11-19' },
      { start: '2025-01-27', end: '2026-01-25', val: vals[3], accn: 'd', form: '10-K', filed: '2026-02-25' },
    ],
  },
});

const cumulative = (fy: number): [number, number, number, number] => [fy / 4, fy / 2, (fy * 3) / 4, fy];

const facts = (ocfFy: number, capexFy: number): CompanyFacts => ({
  facts: {
    'us-gaap': {
      Revenues: ytd([25e9, 50e9, 75e9, 100e9]),
      CostOfRevenue: ytd([10e9, 20e9, 30e9, 40e9]),
      NetCashProvidedByUsedInOperatingActivities: ytd(cumulative(ocfFy)),
      PaymentsToAcquirePropertyPlantAndEquipment: ytd(cumulative(capexFy)),
    },
  },
});

// NVDA 是卖方、MSFT 是买方(见 shared/secCompanies 的 side):两家给不同 FCF,才能验出合计只汇买方。
const NVDA_FACTS = facts(80e9, 4e9); // FCF = 76,000 百万
const MSFT_FACTS = facts(50e9, 20e9); // FCF = 30,000 百万
const MSFT_CIK = '789019';
const NVDA_CIK = '1045810';

/** 合法但一条 fact 都没有的实例:兜底跑完仍拿不到新一期,该报红。 */
const EMPTY_INSTANCE = '<?xml version="1.0"?><xbrl xmlns="http://www.xbrl.org/2003/instance"></xbrl>';

/** 无实例可读:兜底分支若被触发就抛,让「本该不走兜底」的测试失败而不是静默通过。 */
const noInstance = async (): Promise<string> => {
  throw new Error('本轮不该读申报实例');
};

const filingOf = (filed: string | null) => (filed ? { filed, form: '10-Q', accn: `accn-${filed}` } : null);

const stubFetcher = (filed: string | null, onFacts?: (cik: string) => void) => ({
  latestFiling: async () => filingOf(filed),
  companyFacts: async (cik: string) => {
    onFacts?.(cik);
    return cik === MSFT_CIK ? MSFT_FACTS : NVDA_FACTS;
  },
  filingInstance: noInstance,
});

// 一卖一买,且两者都在启用名单里。
const BOTH = { tickers: ['NVDA', 'MSFT'], activeTickers: ['NVDA', 'MSFT'] };
const SELLER_ONLY = { tickers: ['NVDA'], activeTickers: ['NVDA'] };

describe('sec fundamentals job', () => {
  test('首次跑:落单季行 + 每家三条派生量', async () => {
    const db = freshDb();
    const r = await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    expect(r.fetched).toEqual(['NVDA', 'MSFT']);
    expect(getSecFundamentals(db, 'NVDA')).toHaveLength(16); // 4 科目 × 4 期
    expect(getMarketSeries(db, 'SEC_NVDA_FCF_TTM')).toEqual([{ date: '2026-01-25', value: 76_000 }]);
    // 毛利率 = (100 − 40) / 100 = 60%(两家的收入/成本相同)
    expect(getMarketSeries(db, 'SEC_NVDA_GM_TTM')).toEqual([{ date: '2026-01-25', value: 60 }]);
    db.close();
  });

  test('合计线只汇买方:卖方的 FCF 不进去', async () => {
    // §6.14 判据能否成立的关键——卖方在涨价周期里正 FCF 极大,混进来会把零轴永远垫在下方,
    // 「跌破零轴」就永远不会发生。
    const db = freshDb();
    await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    // MSFT(买方)30,000 单独成线;NVDA(卖方)的 76,000 不得混入。
    expect(getMarketSeries(db, 'SEC_BUYER_FCF_TTM')).toEqual([{ date: '2026-01-25', value: 30_000 }]);
    db.close();
  });

  test('买方一家都没启用 → 合计线为空,而非等于卖方', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: stubFetcher('2026-02-25') });

    expect(getMarketSeries(db, 'SEC_NVDA_FCF_TTM')).toHaveLength(1); // 单家线照常有
    expect(getMarketSeries(db, 'SEC_BUYER_FCF_TTM')).toEqual([]); // 判据线没数据
    db.close();
  });

  test('远端 filed 不比本地新 → 跳过,不拉几 MB 的 companyfacts', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    let pulled = 0;
    const r = await updateSecFundamentals(db, {
      ...BOTH,
      fetcher: stubFetcher('2026-02-25', () => {
        pulled += 1;
      }),
    });

    expect(r.skipped).toEqual(['NVDA', 'MSFT']);
    expect(pulled).toBe(0);
    db.close();
  });

  test('submissions 拿不到定期报告申报日 → 记 failed(不是 skipped)且不拉几 MB', async () => {
    // 大盘股必然有 10-Q/10-K,拿不到说明源结构变了。归入 skipped 会变成「永远绿灯零写入」的假绿。
    const db = freshDb();
    let pulled = 0;
    const r = await updateSecFundamentals(db, {
      ...SELLER_ONLY,
      fetcher: stubFetcher(null, () => {
        pulled += 1;
      }),
    });

    expect(r.skipped).toEqual([]);
    expect(r.failed[0]).toMatch(/submissions 里没有 10-Q\/10-K 申报日/);
    expect(pulled).toBe(0);
    db.close();
  });

  test('缺科目 → 每轮都报(不是只在抓到的那一轮报一次)', async () => {
    // 只给 ocf/capex,不给 revenue/cogs。行落库后水位前进,下周走 skip 分支——
    // 若体检挂在抓取那一轮,这家从此永远没有毛利率线却再也没人提。
    const db = freshDb();
    const partial = {
      latestFiling: async () => filingOf('2026-02-25'),
      companyFacts: async () => ({
        facts: {
          'us-gaap': {
            NetCashProvidedByUsedInOperatingActivities: ytd(cumulative(80e9)),
            PaymentsToAcquirePropertyPlantAndEquipment: ytd(cumulative(4e9)),
          },
        },
      }),
      filingInstance: noInstance,
    };

    const first = await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: partial });
    expect(first.failed[0]).toMatch(/最新一期\(2026-01-25\)缺\*\*判据必需\*\*科目 revenue\/cogs/);
    expect(getSecFundamentals(db, 'NVDA').length).toBeGreaterThan(0); // 拿到的行照样落库,可审计

    // 第二轮全 skip,体检仍须复发。
    const second = await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: stubFetcher('2026-02-25') });
    expect(second.skipped).toEqual(['NVDA']);
    expect(second.failed[0]).toMatch(/最新一期\(2026-01-25\)缺\*\*判据必需\*\*科目 revenue\/cogs/);
    db.close();
  });

  test('拉到了却一行没落 → 报出来且不算 fetched;而「压根没拉过」不误报缺科目', async () => {
    const db = freshDb();

    // MSFT 拉到了但 companyfacts 是空的 → 必须报;NVDA 抛错(压根没拉过)→ 不该报缺科目。
    const r = await updateSecFundamentals(db, {
      ...BOTH,
      fetcher: {
        latestFiling: async (cik: string) => {
          if (cik === NVDA_CIK) throw new Error('network down');
          return filingOf('2026-02-25');
        },
        companyFacts: async () => ({}),
        filingInstance: async () => EMPTY_INSTANCE,
      },
    });

    expect(r.failed.some((f) => /MSFT: companyfacts 与申报实例都没贡献新一期的行/.test(f))).toBe(true);
    expect(r.fetched).toEqual([]); // 一行没落不算抓到
    expect(r.failed.some((f) => /NVDA: 最新一期/.test(f))).toBe(false); // 从没抓过 ≠ tag 有问题
    db.close();
  });

  test('库里已有历史、但新申报一行都解析不出 → 必须报(稳态下唯一会发生的形态)', async () => {
    // 这是最阴的一种:体检只看得见「库里最新一期」,而那一期仍是旧的、四科目齐全的期
    // → 体检一条不报 → failed 为空 → 状态短路成 success → 绿灯 + 水位不前进 + 每周白拉几 MB。
    const db = freshDb();
    await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: stubFetcher('2026-02-25') });

    // 远端出了更新的申报,但 companyfacts 解析不出任何行(tag 全换 / SEC 改结构 / 响应降级)。
    const broken = {
      latestFiling: async () => filingOf('2026-05-20'),
      companyFacts: async () => ({}),
      filingInstance: async () => EMPTY_INSTANCE,
    };
    const r = await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: broken });

    expect(r.failed.some((f) => /NVDA: companyfacts 与申报实例都没贡献新一期的行/.test(f))).toBe(true);
    expect(r.fetched).toEqual([]);
    expect(r.rowsWritten).toBe(0);
    db.close();
  });

  test('体检按最新一期判:老季度齐全但新季度缺科目也要报', async () => {
    // 某家在新申报里把某科目换成链外 tag 时的形态:老行还在库里,只有最新一期缺。
    // 按「全历史并集」看会一条告警都不报,而 TTM 因缺季不出新点、线静默停在旧日期。
    const db = freshDb();
    await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: stubFetcher('2026-02-25') });
    db.run(`DELETE FROM sec_fundamentals WHERE ticker = 'NVDA' AND concept = 'cogs' AND period_end = '2026-01-25'`);

    const r = await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: stubFetcher('2026-02-25') });
    expect(r.failed.some((f) => /NVDA: 最新一期\(2026-01-25\)缺\*\*判据必需\*\*科目 cogs/.test(f))).toBe(true);
    db.close();
  });

  test('必需科目按 side 分:买方缺 cogs 不报警(它的毛利率是配角)', async () => {
    // 守卫该要求「判据真正用到的」。买方判据是 FCF(ocf−capex),毛利率由本业主导、是配角;
    // 为配角科目常驻黄灯会把真信号淹掉。卖方反过来(见上一条:NVDA 缺 cogs 要报)。
    const db = freshDb();
    await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });
    db.run(`DELETE FROM sec_fundamentals WHERE ticker = 'MSFT' AND concept = 'cogs'`);

    const r = await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    expect(r.failed.some((f) => /MSFT: 最新一期/.test(f))).toBe(false); // 买方缺 cogs → 不报
    expect(getMarketSeries(db, 'SEC_MSFT_FCF_TTM').length).toBeGreaterThan(0); // FCF 照常
    db.close();
  });

  test('已知结构性缺口(KNOWN_GAPS)完全不报 —— 换源才能修,报了也修不掉', async () => {
    // ORCL 2018 后用公司自定义 XBRL 分项披露收入成本,companyfacts 不聚合 extension。
    // 它是买方,cogs 本来就非必需;这条额外确认即使按必需算也被 KNOWN_GAPS 豁免。
    const db = freshDb();
    const opts = { tickers: ['ORCL'], activeTickers: ['ORCL'] };
    await updateSecFundamentals(db, { ...opts, fetcher: stubFetcher('2026-02-25') });
    db.run(`DELETE FROM sec_fundamentals WHERE ticker = 'ORCL' AND concept = 'cogs'`);

    const r = await updateSecFundamentals(db, { ...opts, fetcher: stubFetcher('2026-02-25') });
    expect(r.failed.some((f) => /ORCL.*cogs/.test(f))).toBe(false);
    db.close();
  });

  test('买方算不出任何 FCF 点 → 排除并报出,不让合计静默变空', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });
    db.run(`DELETE FROM sec_fundamentals WHERE ticker = 'MSFT' AND concept = 'capex'`);

    const r = await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    expect(r.failed.some((f) => /MSFT: 一个 TTM FCF 点都算不出/.test(f))).toBe(true);
    expect(getMarketSeries(db, 'SEC_MSFT_GM_TTM')).toHaveLength(1); // 毛利率照常出,只有 FCF 没了
    db.close();
  });

  test('全跳过且无变化 = 真 no-op:零写入', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    const r = await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });
    expect(r.seriesWritten).toBe(0);
    db.close();
  });

  test('派生量与名单脱节时,即使全跳过也会自愈重建', async () => {
    // 真实场景:手动单跑核对某家 → 加进启用名单 → 下一轮所有人都因无新申报而 skip。
    // 若重算挂在「有抓到东西」上,合计线会停在旧名单口径。这里用「手工删掉合计序列」模拟脱节。
    const db = freshDb();
    await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });
    db.run(`DELETE FROM market_series WHERE series_id = 'SEC_BUYER_FCF_TTM'`);

    const r = await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    expect(r.fetched).toEqual([]); // 一家都没抓
    expect(r.seriesWritten).toBeGreaterThan(0); // 但派生量重建了
    expect(getMarketSeries(db, 'SEC_BUYER_FCF_TTM')).toEqual([{ date: '2026-01-25', value: 30_000 }]);
    db.close();
  });

  test('单家抓取失败只记 failed,不中断整轮', async () => {
    const db = freshDb();
    const boom = {
      latestFiling: async (cik: string) => {
        if (cik === NVDA_CIK) throw new Error('network down');
        return filingOf('2026-02-25');
      },
      companyFacts: async (cik: string) => (cik === MSFT_CIK ? MSFT_FACTS : NVDA_FACTS),
      filingInstance: noInstance,
    };

    const r = await updateSecFundamentals(db, { ...BOTH, fetcher: boom });
    expect(r.failed).toEqual(['NVDA: network down']);
    expect(r.fetched).toEqual(['MSFT']); // 后一家照常跑完
    db.close();
  });

  test('--force 无视 filed 比对', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { ...BOTH, fetcher: stubFetcher('2026-02-25') });

    const r = await updateSecFundamentals(db, { ...BOTH, force: true, fetcher: stubFetcher('2026-02-25') });
    expect(r.fetched).toEqual(['NVDA', 'MSFT']);
    db.close();
  });

  test('未知 ticker 抛错(名单打错字不能静默跳过)', async () => {
    const db = freshDb();
    await expect(updateSecFundamentals(db, { tickers: ['XXXX'], fetcher: stubFetcher('2026-02-25') })).rejects.toThrow(
      /unknown SEC ticker/,
    );
    db.close();
  });
  test('companyfacts 落后于 submissions → 读申报实例补上那一期', async () => {
    // 稳态下最常见的缺口(实测 META 2026Q2:10-Q 已交,companyfacts 六天后仍没这期)。
    // 实例只报本年累计现金流,减掉的上一季在 companyfacts 里 —— 故必须合并后再算。
    const db = freshDb();
    await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: stubFetcher('2026-02-25') });

    // 远端出了 2026-05-20 的新申报,但 companyfacts 还是旧的那四期。
    const instance = [
      '<xbrl xmlns="http://www.xbrl.org/2003/instance">',
      '<unit id="u1"><measure>iso4217:USD</measure></unit>',
      '<context id="c1"><period><startDate>2026-01-26</startDate><endDate>2026-04-26</endDate></period></context>',
      '<context id="c2"><entity><segment><xbrldi:explicitMember dimension="d">m</xbrldi:explicitMember></segment></entity>' +
        '<period><startDate>2026-01-26</startDate><endDate>2026-04-26</endDate></period></context>',
      '<us-gaap:NetCashProvidedByUsedInOperatingActivities contextRef="c1" unitRef="u1">25000000000</us-gaap:NetCashProvidedByUsedInOperatingActivities>',
      '<us-gaap:PaymentsToAcquirePropertyPlantAndEquipment contextRef="c1" unitRef="u1">3000000000</us-gaap:PaymentsToAcquirePropertyPlantAndEquipment>',
      // 带维度的那条值不同,漏掉过滤会串口径。
      '<us-gaap:PaymentsToAcquirePropertyPlantAndEquipment contextRef="c2" unitRef="u1">999000000</us-gaap:PaymentsToAcquirePropertyPlantAndEquipment>',
      '</xbrl>',
    ].join('');

    const r = await updateSecFundamentals(db, {
      ...SELLER_ONLY,
      fetcher: {
        latestFiling: async () => filingOf('2026-05-20'),
        companyFacts: async () => NVDA_FACTS,
        filingInstance: async () => instance,
      },
    });

    expect(r.fetched).toEqual(['NVDA']);
    expect(r.fallback).toEqual(['NVDA(10-Q 2026-05-20)']);
    const q = getSecFundamentals(db, 'NVDA').filter((x) => x.periodEnd === '2026-04-26');
    expect(q.find((x) => x.concept === 'ocf')?.value).toBe(25e9);
    expect(q.find((x) => x.concept === 'capex')?.value).toBe(3e9); // 不是 999e6
    expect(q[0]?.filed).toBe('2026-05-20'); // 溯源列指向那份申报,不是 companyfacts
  });

  test('兜底也拿不到 → 主症状(companyfacts 落后)仍要报,不被兜底的错盖掉', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { ...SELLER_ONLY, fetcher: stubFetcher('2026-02-25') });

    const r = await updateSecFundamentals(db, {
      ...SELLER_ONLY,
      fetcher: {
        latestFiling: async () => filingOf('2026-05-20'),
        companyFacts: async () => NVDA_FACTS,
        filingInstance: async () => {
          throw new Error('目录里没有 _htm.xml 实例');
        },
      },
    });

    expect(r.failed.some((f) => /申报实例兜底失败/.test(f))).toBe(true);
    expect(r.failed.some((f) => /companyfacts 与申报实例都没贡献新一期的行/.test(f))).toBe(true);
    expect(r.fetched).toEqual([]);
  });
  test('capex 口径:AMZN 的 productive_assets 是已声明状态 → 不报;买方换档 → 报', async () => {
    // 不可比本身永远存在(AMZN 2017 后没有纯 PP&E tag 可选),报成 failed 就是永久黄灯。
    const withCapexTag = (tag: string): CompanyFacts => ({
      facts: {
        'us-gaap': {
          Revenues: ytd([25e9, 50e9, 75e9, 100e9]),
          CostOfRevenue: ytd([10e9, 20e9, 30e9, 40e9]),
          NetCashProvidedByUsedInOperatingActivities: ytd(cumulative(50e9)),
          [tag]: ytd(cumulative(20e9)),
        },
      },
    });
    const fetcherFor = (tag: string) => ({
      latestFiling: async () => filingOf('2026-02-25'),
      companyFacts: async () => withCapexTag(tag),
      filingInstance: noInstance,
    });
    const scopeProblems = (r: { failed: string[] }) => r.failed.filter((f) => /capex 口径/.test(f));

    // AMZN 用 productive_assets = 声明值 → 静默(而它与 MSFT 的 ppe 确实不可比,照样不报)。
    const db = freshDb();
    const ok = await updateSecFundamentals(db, {
      tickers: ['AMZN', 'MSFT'],
      activeTickers: ['AMZN', 'MSFT'],
      fetcher: {
        latestFiling: async () => filingOf('2026-02-25'),
        companyFacts: async (cik: string) =>
          withCapexTag(
            cik === MSFT_CIK ? 'PaymentsToAcquirePropertyPlantAndEquipment' : 'PaymentsToAcquireProductiveAssets',
          ),
        filingInstance: noInstance,
      },
    });
    expect(scopeProblems(ok)).toEqual([]);
    db.close();

    // MSFT 声明是 ppe,却命中 productive_assets → 换档,必须报。
    const db2 = freshDb();
    const flipped = await updateSecFundamentals(db2, {
      tickers: ['MSFT'],
      activeTickers: ['MSFT'],
      fetcher: fetcherFor('PaymentsToAcquireProductiveAssets'),
    });
    expect(scopeProblems(flipped)[0]).toMatch(/MSFT: capex 口径从声明的 ppe 变成 productive_assets/);
    db2.close();
  });
});
