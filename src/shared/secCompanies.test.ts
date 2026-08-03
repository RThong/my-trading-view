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

  test('AAPL 不在目录里(不在 AI 链上,FCF 由 iPhone 主导)', () => {
    expect(SEC_COMPANIES.map((c) => c.ticker)).not.toContain('AAPL');
  });

  test('启用名单里的每一家都在目录里', () => {
    const known = new Set(SEC_COMPANIES.map((c) => c.ticker));
    for (const t of SEC_ACTIVE_TICKERS) expect(known.has(t)).toBe(true);
  });
});
