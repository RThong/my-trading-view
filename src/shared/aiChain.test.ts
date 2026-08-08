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
    // AVGO:合并 VMware 后毛利率是「硅片定价权 + 软件占比」的混合,当稀缺溢价用不干净。
    for (const t of ['AAPL', 'DELL', 'AVGO']) expect(tickers).not.toContain(t);
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
    // TSM = sec6k 四格 + twse 两格,gm 不重复。
    expect(kindsOf('TSM')).toEqual(['gm', 'capex', 'fcf', 'fcfq', 'revM', 'revYoy']);
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
      // 买方必在云厂商组:它们的判据是 FCF,和卖方那几组读法完全不同。
      if (c.side === 'buyer') expect(c.group, `${c.ticker} 是买方却不在 cloud`).toBe('cloud');
      // 非链内的只能进备查 —— 否则它会混在判据组里被当成成员读。
      if (!c.inChain) expect(c.group, `${c.ticker} 非链内却不在 watch`).toBe('watch');
      if (c.group === 'cloud') expect(c.side).toBe('buyer');
    }
  });

  test('分组是启用名单的一个划分:不重不漏', () => {
    const all = GROUP_ORDER.flatMap((g) => activeByGroup(g));
    expect([...all].sort()).toEqual([...ACTIVE_TICKERS].sort());
    expect(new Set(all).size).toBe(all.length); // 不重
  });

  test('组内成员符合各自的读法', () => {
    // 直接卖加速器的两家,毛利率可横向比。
    expect(activeByGroup('accelerator')).toEqual(['NVDA', 'AMD']);
    // 代工 + 存储:都是「供给跟不跟得上」那一层。
    // 存储两家(MU / SKHY)+ 代工 + 设备。MU 与 SKHY 是 DRAM/NAND 周期的两个独立读数。
    expect(activeByGroup('upstream')).toEqual(['MU', 'TSM', 'ASML', 'SKHY']);
    expect(activeByGroup('watch')).toEqual(['INTC']);
    expect(activeByGroup('cloud')).toEqual(['MSFT', 'ORCL', 'GOOGL', 'AMZN', 'META']);
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
