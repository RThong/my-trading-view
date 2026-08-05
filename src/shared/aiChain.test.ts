import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_TICKERS,
  SEC_COMPANIES,
  SOURCE_KINDS,
  activeBySource,
  cikOf,
  fundKey,
  isAggregateMember,
  kindsOf,
  sourceOf,
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
    // ASML:只报 20-F,这条管线一个 TTM 点都算不出;有价值的读数(季度 net bookings)在 IR 季报里。
    expect(tickers).not.toContain('ASML');
  });

  test('启用名单里的每一家都在目录里', () => {
    const known = new Set(SEC_COMPANIES.map((c) => c.ticker));
    for (const t of ACTIVE_TICKERS) expect(known.has(t)).toBe(true);
  });
});

describe('源映射(表驱动)', () => {
  test('TSM 走 TWSE 而不是 SEC —— 它的 SEC 侧只有半年频且停在 2024', () => {
    expect(sourceOf('TSM')).toBe('twse');
    expect(twseCodeOf('TSM')).toBe('2330');
    // cikOf 对非 SEC 源必须返回 undefined:否则 SEC job 会拿它去 companyfacts 白打一轮。
    expect(cikOf('TSM')).toBeUndefined();
  });

  test('source 省略即 sec,且两个标识符不会串源', () => {
    expect(sourceOf('NVDA')).toBe('sec');
    expect(cikOf('NVDA')).toBe('1045810');
    expect(twseCodeOf('NVDA')).toBeUndefined();
  });

  test('每个源的启用名单互不重叠、并集 = 全体启用名单', () => {
    const sec = activeBySource('sec');
    const twse = activeBySource('twse');

    expect(twse).toEqual(['TSM']);
    expect(sec).not.toContain('TSM'); // 否则 SEC job 会对 TSM 抛「unknown SEC ticker」
    expect([...sec, ...twse].sort()).toEqual([...ACTIVE_TICKERS].sort());
  });

  test('格子种类按源分,不共用一张表', () => {
    expect(kindsOf('TSM')).toEqual(SOURCE_KINDS.twse);
    expect(kindsOf('NVDA')).toEqual(SOURCE_KINDS.sec);

    // TWSE 不给现金流 → 不该给它 FCF 那两格(会画出两条永远空的线)。
    for (const k of ['fcf', 'fcfq', 'capex']) expect(kindsOf('TSM')).not.toContain(k);
    // gm **两个源都有但口径不同**(TWSE 单季 / SEC 是 TTM),所以库里的 series_id 必须分开 ——
    // 那一层由路由的 SERIES_ID 按源分层保证,这里只确认两侧都声明了 gm。
    expect(kindsOf('TSM')).toContain('gm');
    expect(kindsOf('NVDA')).toContain('gm');
  });

  test('对外键前缀与来源无关', () => {
    // 早先是 `sec:`,加了 TWSE 之后那个前缀就成了谎(TSM 的数来自台湾证交所)。
    expect(fundKey('TSM', 'revM')).toBe('fund:TSM:revM');
    expect(fundKey('NVDA', 'gm')).toBe('fund:NVDA:gm');
  });
});
