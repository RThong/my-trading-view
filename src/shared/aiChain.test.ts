import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_TICKERS,
  SEC_COMPANIES,
  SOURCE_KINDS,
  SOURCE_NEEDS,
  GROUP_LABELS,
  GROUP_ORDER,
  activeByGroup,
  activeBySource,
  activeInSecTable,
  cikOf,
  currencyOf,
  financeLeaseCeiling,
  fundKey,
  hasSource,
  isAggregateMember,
  knownGap,
  kindsOf,
  sec6kCikOf,
  sourcesOf,
  twseCodeOf,
} from './aiChain';

describe('AI 链名单', () => {
  test('买方合计线的成员 = buyer 且在因果链内', () => {
    // 光看 side 不够:目录里若有非链内的 buyer(如曾经的 AAPL —— FCF 由 iPhone 主导),
    // 它会静默把零轴垫高、让 §6.14 的「跌破零轴」永远不成立。
    const members = SEC_COMPANIES.filter((c) => isAggregateMember(c.ticker)).map((c) => c.ticker);
    expect(members).toEqual(['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']);

    for (const c of SEC_COMPANIES) {
      if (c.side === 'seller') expect(isAggregateMember(c.ticker)).toBe(false);
      if (!c.inChain) expect(isAggregateMember(c.ticker)).toBe(false);
    }
  });

  test('已剔除的标的不得回到目录里', () => {
    const tickers = SEC_COMPANIES.map((c) => c.ticker);
    // AAPL:不在 AI 链上(FCF 由 iPhone 主导)。DELL:整机厂,毛利率不反映芯片稀缺溢价。
    // (AVGO 曾以「VMware 混合读数」为由剔除,后实测那 6pp 是收购摊销走 COGS、不是定价权 ——
    //  已放回,现归算力芯片组的「定制 ASIC」那一半,见名单里的注释。)
    for (const t of ['AAPL', 'DELL']) expect(tickers).not.toContain(t);
  });

  test('启用名单里的每一家都在目录里', () => {
    const known = new Set(SEC_COMPANIES.map((c) => c.ticker));
    for (const t of ACTIVE_TICKERS) expect(known.has(t)).toBe(true);
  });
});

describe('源映射(表驱动)', () => {
  test('TSM 走两个源:季度四科目 sec6k、月营收 twse', () => {
    // 各测度的最佳来源本来就不同,硬塞进一个 source 会逼着二选一。
    expect(sourcesOf('TSM')).toEqual(['sec6k', 'twse']);
    expect(twseCodeOf('TSM')).toBe('2330');
    expect(sec6kCikOf('TSM')).toBe('1046179');
    // ⚠️ cikOf(companyfacts 那条)必须是 undefined —— TSM 的 companyfacts 只有半年/全年
    // 且停在 2024-12-31,SEC job 拿它去拉就是白打一轮,还会因为没有 10-Q 而报 failed。
    expect(cikOf('TSM')).toBeUndefined();
  });

  test('sources 省略即 sec,且标识符不会串源', () => {
    expect(sourcesOf('NVDA')).toEqual(['sec']);
    expect(cikOf('NVDA')).toBe('1045810');
    expect(sec6kCikOf('NVDA')).toBeUndefined();
    expect(twseCodeOf('NVDA')).toBeUndefined();
  });

  test('每家声明的每个源都有对应标识符(判别联合表达不了多源,故用测试兜)', () => {
    for (const c of SEC_COMPANIES) {
      for (const s of sourcesOf(c.ticker)) {
        expect(c[SOURCE_NEEDS[s]], `${c.ticker} 声明了 ${s} 源却缺 ${SOURCE_NEEDS[s]}`).toBeTruthy();
      }
    }
  });

  test('分源名单:一家可出现在多个源里,并集覆盖全体启用名单', () => {
    expect(activeBySource('sec6k')).toEqual(['TSM', 'ASML']);
    expect(activeBySource('twse')).toEqual(['TSM']);
    expect(activeBySource('dart')).toEqual(['SKHY']);
    // 走 sec6k / dart 的那几家不能同时出现在 sec 那一路 —— 否则 SEC job 会拿它们去 companyfacts
    // 白打一轮(TSM/ASML 那里只有年频、SKHY 压根没有财务 XBRL),还会因为没有 10-Q 而报 failed。
    for (const t of ['TSM', 'ASML', 'SKHY']) expect(activeBySource('sec')).not.toContain(t);

    const union = new Set([
      ...activeBySource('sec'),
      ...activeBySource('sec6k'),
      ...activeBySource('twse'),
      ...activeBySource('dart'),
    ]);
    expect([...union].sort()).toEqual([...ACTIVE_TICKERS].sort());
  });

  test('原始行落 sec_fundamentals 的源 = sec ∪ sec6k(writeDerived 的范围)', () => {
    // 少了 sec6k 那家,TSM 的 TTM/毛利率/FCF 线永远不出。
    expect(activeInSecTable()).toContain('TSM');
    expect(activeInSecTable()).toContain('NVDA');
    expect(activeInSecTable()).toEqual(ACTIVE_TICKERS); // 目前每家至少走一个落表的源
  });

  test('格子种类 = 各源格子的并集,同名只留一份', () => {
    // TSM = sec6k 六格 + twse 两格,gm 不重复。
    // 注意 sec 侧的 rev/revGrowth(TTM 营收 / 单季同比)与 twse 的 revM/revYoy(月营收 / 月同比)
    // **是四个不同的 kind**:口径与频率都不同,故不能同名 —— 路由的 SERIES_ID 按 kind 平铺查表。
    expect(kindsOf('TSM')).toEqual(['gm', 'capex', 'fcf', 'fcfq', 'rev', 'revGrowth', 'revM', 'revYoy']);
    expect(kindsOf('NVDA')).toEqual(SOURCE_KINDS.sec);
    // TWSE 那条不再出毛利率(曾从季度综合损益表取过,已退掉 —— 它是 6-K 的子集且无现金流)。
    expect(SOURCE_KINDS.twse).toEqual(['revM', 'revYoy']);
  });

  test('币种:TSM 报表是新台币,别家美元 —— 面板单位按它写', () => {
    expect(currencyOf('TSM')).toBe('TWD');
    expect(currencyOf('NVDA')).toBe('USD');
  });

  test('对外键前缀与来源无关', () => {
    // 早先是 `sec:`,加了非 SEC 源之后那个前缀就成了谎。
    expect(fundKey('TSM', 'revM')).toBe('fund:TSM:revM');
    expect(fundKey('NVDA', 'gm')).toBe('fund:NVDA:gm');
  });

  test('hasSource 只认声明过的源', () => {
    expect(hasSource('TSM', 'sec6k')).toBe(true);
    expect(hasSource('TSM', 'sec')).toBe(false);
    expect(hasSource('NVDA', 'sec6k')).toBe(false);
  });
});

describe('面板分组', () => {
  test('每家都归了组,且组与 side/inChain 不矛盾', () => {
    for (const c of SEC_COMPANIES) {
      expect(c.group, `${c.ticker} 没归组`).toBeTruthy();
      // 买方必在 capex 买单组:它们的判据是 FCF,和卖方那几组读法完全不同。
      if (c.side === 'buyer') expect(c.group, `${c.ticker} 是买方却不在 payer`).toBe('payer');
      // 反过来也要成立:payer 组里混进卖方,就会有人拿它的 FCF 去对零轴读。
      if (c.group === 'payer') expect(c.side, `${c.ticker} 在 payer 组却不是买方`).toBe('buyer');
    }
  });

  test('分组是启用名单的一个划分:不重不漏', () => {
    const all = GROUP_ORDER.flatMap((g) => activeByGroup(g));
    expect([...all].sort()).toEqual([...ACTIVE_TICKERS].sort());
    expect(new Set(all).size).toBe(all.length); // 不重
  });

  test('组内成员符合各自的读法', () => {
    // 顺序即资金流向:capex 买单 → 算力芯片 → 代工 → 存储 → 设备。
    expect(activeByGroup('payer')).toEqual(['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']);
    // 组内分两半:NVDA/AMD 通用 GPU(CUDA 生态),AVGO/ARM 定制 ASIC + IP
    // (**CSP 绕开 NVDA 的替代路径,不是补充**)。两半劈叉 = 大厂议价权变化的直接读数,故必须同组。
    expect(activeByGroup('accelerator')).toEqual(['NVDA', 'AMD', 'AVGO', 'ARM']);
    // 代工与存储**必须分列**:TSM 是结构性高毛利(先进制程 + 设计生态),MU/SKHY 是周期性高毛利
    // (供需缺口的产物)。结构性见顶后能维持许久、周期性见顶即退坡 —— 混一组这条判别力就没了。
    expect(activeByGroup('foundry')).toEqual(['TSM', 'INTC']);
    expect(activeByGroup('memory')).toEqual(['MU', 'SKHY']);
    // 设备单列:ASML 不是「上游产能」,是产能的**供给方**,差一层(EUV 近乎垄断无替代)。
    expect(activeByGroup('equipment')).toEqual(['ASML']);
  });

  test('每组都有中文名(缺了 tab 条上会出现空标签)', () => {
    for (const g of GROUP_ORDER) expect(GROUP_LABELS[g]).toBeTruthy();
  });
});

describe('融资租赁守卫的档位声明', () => {
  /**
   * 守卫的判据是 `ceiling !== undefined && share > ceiling` —— 漏写档位不是「按 0 报」,是**完全不查**。
   * 而这张表的立论正是「MSFT 从 1~2% 跳到 21% 时没有任何人知道」:第六家买方进来时会原样重演。
   * 隔壁 expectedCapexScope 有 `?? 'ppe'` 兜底,这里没有,只能靠不变式咬住。
   */
  test('每个买方合计成员都要有声明档位', () => {
    const missing = ACTIVE_TICKERS.filter((t) => isAggregateMember(t) && financeLeaseCeiling(t) === undefined);
    expect(missing, `这几家漏了 FINANCE_LEASE_SHARE_CEILING:${missing.join('/')}`).toEqual([]);
  });
});

describe('币种与结构性缺口的不变式', () => {
  /**
   * market_series 里三种币种同表同字段(ASML 百万欧元 / TSM 百万新台币 / 其余百万美元),
   * 靠 currencyOf 只在**文案**上区分。买方合计是唯一做跨公司加总的地方 —— 只要成员里混进
   * 一个非美元的,那条线就是把汇率当增长在加,而且不会报错。
   * 现在恰好全是美国公司,所以这条只能靠不变式咬住。
   */
  test('买方合计成员必须同币种(否则是在加汇率)', () => {
    const bad = ACTIVE_TICKERS.filter((t) => isAggregateMember(t) && currencyOf(t) !== 'USD');
    expect(bad, `非美元的买方合计成员:${bad.join('/')}`).toEqual([]);
  });

  /**
   * KNOWN_GAPS 声明「这格永远是空的」。ORCL 的 cogs 在 2018 年前其实有过行(2009-02~2011-05),
   * 派生层因为凑不满四季 TTM 窗口而不出点 —— 但这是**算出来的巧合**,不是被谁挡住的。
   * 锁住它:哪天派生逻辑放宽,一段 2009–2011 的孤立毛利率会突然冒出来,而 desc 还写着「这格是空的」。
   */
  test('登记了 KNOWN_GAPS 的格子,desc 必须解释库里可能有旧行', () => {
    expect(knownGap('ORCL', 'cogs')).toMatch(/2009-02.*2011-05/);
  });
});
