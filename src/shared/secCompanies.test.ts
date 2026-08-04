import { describe, expect, test } from 'bun:test';
import { SEC_ACTIVE_TICKERS, SEC_COMPANIES, isAggregateMember } from './secCompanies';

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
    // TSM / ASML:只报 20-F,实测四科目季度行均为 0 → 这条管线一个 TTM 点都算不出。
    for (const t of ['TSM', 'ASML']) expect(tickers).not.toContain(t);
  });

  test('启用名单里的每一家都在目录里', () => {
    const known = new Set(SEC_COMPANIES.map((c) => c.ticker));
    for (const t of SEC_ACTIVE_TICKERS) expect(known.has(t)).toBe(true);
  });
});
